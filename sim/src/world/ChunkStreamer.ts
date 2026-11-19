import * as THREE from 'three';
import {
  FloatingOriginManager,
  type FloatingOriginListener,
} from '../core/FloatingOriginManager.ts';
import type {
  ChunkBounds,
  ChunkData,
  ManifestChunkEntry,
  MapEdge,
  MapManifest,
  UtmCoordinate,
} from './MapTypes.ts';
import { RoadMeshBuilder } from './RoadMeshBuilder.ts';

export interface RoadSurfaceSample {
  elevationY: number;
  onRoad: boolean;
  streetName: string | null;
  maxspeedKmh: number;
  distanceToRoadMeters: number;
}

export interface RoadPlacement {
  mapPosition: THREE.Vector3;
  headingRad: number;
  streetName: string | null;
  maxspeedKmh: number;
}

export interface ChunkStreamerOptions {
  baseUrl?: string;
  loadRadiusMeters?: number;
  unloadRadiusMeters?: number;
  floatingOrigin?: FloatingOriginManager;
  roadMeshBuilder?: RoadMeshBuilder;
  streetNamesVisible?: boolean;
}

interface LoadedChunkRecord {
  entry: ManifestChunkEntry;
  group: THREE.Group;
  streetNamesGroup: THREE.Object3D | null;
  edges: MapEdge[];
}

interface LoadingChunkRecord {
  controller: AbortController;
  cancelled: boolean;
}

function disposeObjectGeometries(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh && obj.geometry instanceof THREE.BufferGeometry) {
      obj.geometry.dispose();
    }
  });
}

function distanceToBoundsSq(x: number, z: number, bounds: ChunkBounds): number {
  const dx =
    x < bounds.min_x ? bounds.min_x - x : x > bounds.max_x ? x - bounds.max_x : 0;
  const dz =
    z < bounds.min_z ? bounds.min_z - z : z > bounds.max_z ? z - bounds.max_z : 0;
  return dx * dx + dz * dz;
}

/**
 * Streams Toronto map chunks around the camera/player using manifest.json,
 * building 3D road geometry and integrating with FloatingOriginManager.
 */
export class ChunkStreamer implements FloatingOriginListener {
  public readonly worldRoot = new THREE.Group();
  public readonly floatingOrigin: FloatingOriginManager;
  public readonly roadMeshBuilder: RoadMeshBuilder;

  private readonly baseUrl: string;
  private readonly loadRadiusMeters: number;
  private readonly unloadRadiusMeters: number;
  private readonly ownsRoadBuilder: boolean;

  private manifest: MapManifest | null = null;
  private readonly chunkEntryById = new Map<string, ManifestChunkEntry>();
  private readonly loadedChunks = new Map<string, LoadedChunkRecord>();
  private readonly loadingChunks = new Map<string, LoadingChunkRecord>();
  private readonly maxConcurrentLoads = 10;

  private readonly unsubscribeOrigin: () => void;
  private readonly tempOrigin = new THREE.Vector3();
  private originShiftCount = 0;
  private streetNamesVisible: boolean;
  private secondaryMapFocusXZ: { x: number; z: number } | null = null;
  private disposed = false;

  constructor(options: ChunkStreamerOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '/map_chunks').replace(/\/+$/, '');
    this.loadRadiusMeters = options.loadRadiusMeters ?? 1500;
    this.unloadRadiusMeters = options.unloadRadiusMeters ?? 2000;
    this.streetNamesVisible = options.streetNamesVisible ?? true;
    this.floatingOrigin =
      options.floatingOrigin ?? new FloatingOriginManager(1000);
    this.ownsRoadBuilder = !options.roadMeshBuilder;
    this.roadMeshBuilder = options.roadMeshBuilder ?? new RoadMeshBuilder();

    this.worldRoot.name = 'toronto-world-root';
    this.floatingOrigin.getWorldOrigin(this.tempOrigin);
    this.worldRoot.position.copy(this.tempOrigin).negate();

    this.unsubscribeOrigin = this.floatingOrigin.subscribe(this);
  }

  /**
   * Loads manifest.json from the configured map_chunks base URL.
   */
  public async init(): Promise<MapManifest> {
    const response = await fetch(`${this.baseUrl}/manifest.json`);
    if (!response.ok) {
      throw new Error(
        `Failed to load map manifest (${response.status} ${response.statusText})`,
      );
    }
    const manifest = (await response.json()) as MapManifest;
    if (!this.disposed) {
      this.manifest = manifest;
      this.chunkEntryById.clear();
      for (const entry of manifest.chunks) {
        this.chunkEntryById.set(entry.id, entry);
      }
    }
    return manifest;
  }

  /**
   * Shifts the world root opposite to the floating-origin shift delta so
   * world geometry stays aligned with the recentered local camera/player.
   */
  public onOriginShift(shiftDelta: THREE.Vector3): void {
    this.worldRoot.position.sub(shiftDelta);
    this.originShiftCount += 1;
  }

  public setSecondaryMapFocus(focusXZ: { x: number; z: number } | null): void {
    this.secondaryMapFocusXZ = focusXZ;
  }

  public setRealisticMode(enabled: boolean): void {
    this.roadMeshBuilder.setRealisticMode(enabled);
  }

  private minFocusDistSq(
    primaryX: number,
    primaryZ: number,
    bounds: ChunkBounds,
  ): number {
    const primaryDistSq = distanceToBoundsSq(primaryX, primaryZ, bounds);
    if (!this.secondaryMapFocusXZ) {
      return primaryDistSq;
    }
    const secondaryDistSq = distanceToBoundsSq(
      this.secondaryMapFocusXZ.x,
      this.secondaryMapFocusXZ.z,
      bounds,
    );
    return Math.min(primaryDistSq, secondaryDistSq);
  }

  /**
   * Streams in chunks within loadRadiusMeters (1500m) and unloads chunks
   * beyond unloadRadiusMeters (2000m) relative to the focus position.
   */
  public update(localFocusPosition: THREE.Vector3): void {
    if (this.disposed || !this.manifest) {
      return;
    }

    const mapPos = this.getMapCoordinates(localFocusPosition);
    const loadRadiusSq = this.loadRadiusMeters * this.loadRadiusMeters;
    const unloadRadiusSq = this.unloadRadiusMeters * this.unloadRadiusMeters;

    for (const [chunkId, record] of this.loadedChunks.entries()) {
      const distSq = this.minFocusDistSq(
        mapPos.x,
        mapPos.z,
        record.entry.bounds_m,
      );
      if (distSq > unloadRadiusSq) {
        this.unloadChunk(chunkId);
      }
    }

    for (const [chunkId, loading] of this.loadingChunks.entries()) {
      const entry = this.chunkEntryById.get(chunkId);
      if (!entry) {
        continue;
      }
      const distSq = this.minFocusDistSq(mapPos.x, mapPos.z, entry.bounds_m);
      if (distSq > unloadRadiusSq) {
        loading.cancelled = true;
        loading.controller.abort();
        this.loadingChunks.delete(chunkId);
      }
    }

    const availableSlots = this.maxConcurrentLoads - this.loadingChunks.size;
    if (availableSlots <= 0) {
      return;
    }

    const candidates: Array<{ entry: ManifestChunkEntry; distSq: number }> = [];
    for (const entry of this.manifest.chunks) {
      if (
        this.loadedChunks.has(entry.id) ||
        this.loadingChunks.has(entry.id)
      ) {
        continue;
      }
      const distSq = this.minFocusDistSq(mapPos.x, mapPos.z, entry.bounds_m);
      if (distSq <= loadRadiusSq) {
        candidates.push({ entry, distSq });
      }
    }

    candidates.sort((a, b) => a.distSq - b.distSq);
    const toStart = candidates.slice(0, availableSlots);
    for (const candidate of toStart) {
      void this.loadChunk(candidate.entry);
    }
  }

  /**
   * Converts a local render-space coordinate into true map-space coordinates.
   */
  public getMapCoordinates(
    localPosition: THREE.Vector3,
    target = new THREE.Vector3(),
  ): THREE.Vector3 {
    this.floatingOrigin.getWorldOrigin(this.tempOrigin);
    return target.copy(localPosition).add(this.tempOrigin);
  }

  /**
   * Converts a local render-space coordinate into EPSG:32617 UTM Easting,
   * Northing, and elevation in meters using manifest projection metadata.
   */
  public getUtmCoordinates(localPosition: THREE.Vector3): UtmCoordinate {
    const mapPos = this.getMapCoordinates(localPosition);
    const originEasting = this.manifest?.projection.origin_utm.easting ?? 630614.631;
    const originNorthing =
      this.manifest?.projection.origin_utm.northing ?? 4834952.502;
    const crs = this.manifest?.projection.crs ?? 'EPSG:32617';

    return {
      easting: originEasting + mapPos.x,
      northing: originNorthing - mapPos.z,
      elevation: mapPos.y,
      crs,
    };
  }

  public getLoadedChunkCount(): number {
    return this.loadedChunks.size;
  }

  public getLoadingChunkCount(): number {
    return this.loadingChunks.size;
  }

  public getTotalChunkCount(): number {
    return this.manifest?.chunks.length ?? 0;
  }

  public getOriginShiftCount(): number {
    return this.originShiftCount;
  }

  public getManifest(): MapManifest | null {
    return this.manifest;
  }

  public getLoadedChunkBounds(): ChunkBounds[] {
    const out: ChunkBounds[] = [];
    for (const record of this.loadedChunks.values()) {
      out.push(record.entry.bounds_m);
    }
    return out;
  }

  public isStreetNamesVisible(): boolean {
    return this.streetNamesVisible;
  }

  /**
   * Instantly toggles visibility of road-engraved street name decals across
   * all loaded chunks and remembers the state for newly streamed chunks.
   */
  public setStreetNamesVisible(visible: boolean): void {
    this.streetNamesVisible = visible;
    for (const record of this.loadedChunks.values()) {
      if (record.streetNamesGroup) {
        record.streetNamesGroup.visible = visible;
      }
    }
  }

  public updateTrafficLights(elapsedSeconds: number): void {
    this.roadMeshBuilder.updateTrafficLights(elapsedSeconds);
  }

  /**
   * Unloads all chunks, cancels pending fetches, and releases resources.
   */
  public dispose(): void {
    this.disposed = true;
    this.unsubscribeOrigin();

    for (const loading of this.loadingChunks.values()) {
      loading.cancelled = true;
      loading.controller.abort();
    }
    this.loadingChunks.clear();

    for (const chunkId of Array.from(this.loadedChunks.keys())) {
      this.unloadChunk(chunkId);
    }

    if (this.ownsRoadBuilder) {
      this.roadMeshBuilder.dispose();
    }
  }

  private async loadChunk(entry: ManifestChunkEntry): Promise<void> {
    const controller = new AbortController();
    const loadingRecord: LoadingChunkRecord = { controller, cancelled: false };
    this.loadingChunks.set(entry.id, loadingRecord);

    try {
      const response = await fetch(`${this.baseUrl}/${entry.file}`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(
          `Failed to load chunk ${entry.id} (${response.status})`,
        );
      }
      const chunkData = (await response.json()) as ChunkData;
      if (this.disposed || loadingRecord.cancelled) {
        return;
      }
      this.attachChunk(entry, chunkData);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }
      if (!this.disposed && !loadingRecord.cancelled) {
        console.error(`Error streaming chunk ${entry.id}:`, error);
      }
    } finally {
      this.loadingChunks.delete(entry.id);
    }
  }

  private attachChunk(entry: ManifestChunkEntry, chunkData: ChunkData): void {
    if (this.loadedChunks.has(entry.id)) {
      return;
    }

    const chunkOrigin = new THREE.Vector3(
      entry.bounds_m.min_x,
      0,
      entry.bounds_m.min_z,
    );
    const group = this.roadMeshBuilder.buildChunkGroup(chunkData, {
      originOffset: chunkOrigin,
    });
    const streetNamesGroup = group.getObjectByName('street-names') ?? null;
    if (streetNamesGroup) {
      streetNamesGroup.visible = this.streetNamesVisible;
    }
    group.position.copy(chunkOrigin);
    this.worldRoot.add(group);

    this.loadedChunks.set(entry.id, {
      entry,
      group,
      streetNamesGroup,
      edges: chunkData.edges,
    });
  }

  /**
   * Samples the nearest road surface elevation, street name, and speed limit
   * around map-space XZ, preferring roads closest in elevation to referenceMapY
   * so stacked bridges/ramps and ground streets resolve unambiguously.
   */
  public sampleRoadSurface(
    mapX: number,
    referenceMapY: number,
    mapZ: number,
  ): RoadSurfaceSample {
    const searchMarginSq = 55 * 55;
    let bestScore = Infinity;
    let bestEdge: MapEdge | null = null;
    let bestElev = referenceMapY;
    let bestLateralDist = Infinity;

    for (const record of this.loadedChunks.values()) {
      if (distanceToBoundsSq(mapX, mapZ, record.entry.bounds_m) > searchMarginSq) {
        continue;
      }
      for (const edge of record.edges) {
        const geom = edge.geometry;
        if (geom.length < 2) {
          continue;
        }
        const halfW = (edge.width_m ?? edge.lanes * 3.5) * 0.5;
        for (let i = 0; i < geom.length - 1; i++) {
          const pA = geom[i];
          const pB = geom[i + 1];
          if (!pA || !pB) {
            continue;
          }
          const [ax, ay, az] = pA;
          const [bx, by, bz] = pB;
          const dx = bx - ax;
          const dz = bz - az;
          const lenSq = dx * dx + dz * dz;
          if (lenSq < 1e-6) {
            continue;
          }
          const t = Math.max(
            0,
            Math.min(1, ((mapX - ax) * dx + (mapZ - az) * dz) / lenSq),
          );
          const qx = ax + dx * t;
          const qy = ay + (by - ay) * t;
          const qz = az + dz * t;
          const dCenter = Math.hypot(mapX - qx, mapZ - qz);
          if (dCenter > 42) {
            continue;
          }
          const edgeGap = Math.max(0, dCenter - halfW);
          const dy = Math.abs(qy - referenceMapY);
          // Heavily penalize different bridge decks (> 4.5 m height diff) while staying on-road
          const deckPenalty = dy > 4.5 ? 25 + dy * 2.0 : dy * 0.35;
          const score = edgeGap + deckPenalty;
          if (score < bestScore) {
            bestScore = score;
            bestEdge = edge;
            bestElev = qy;
            bestLateralDist = edgeGap;
          }
        }
      }
    }

    return {
      elevationY: bestElev,
      onRoad: bestEdge !== null && bestLateralDist <= 0.85,
      streetName: bestEdge?.street_name ?? null,
      maxspeedKmh: bestEdge?.maxspeed_kmh ?? 50,
      distanceToRoadMeters: bestLateralDist,
    };
  }

  /**
   * Finds the nearest loaded road centerline segment and returns a right-hand
   * lane spawn pose aligned cleanly with traffic direction.
   */
  public findNearestRoadPlacement(
    mapX: number,
    mapY: number,
    mapZ: number,
    preferredDirXZ?: [number, number],
  ): RoadPlacement | null {
    const searchMarginSq = 250 * 250;
    let bestScore = Infinity;
    let bestEdge: MapEdge | null = null;
    let bestPos = new THREE.Vector3(mapX, mapY, mapZ);
    let bestDirX = 0;
    let bestDirZ = -1;

    for (const record of this.loadedChunks.values()) {
      if (distanceToBoundsSq(mapX, mapZ, record.entry.bounds_m) > searchMarginSq) {
        continue;
      }
      for (const edge of record.edges) {
        if (edge.intersection_internal) {
          continue;
        }
        const geom = edge.geometry;
        if (geom.length < 2) {
          continue;
        }
        for (let i = 0; i < geom.length - 1; i++) {
          const pA = geom[i];
          const pB = geom[i + 1];
          if (!pA || !pB) {
            continue;
          }
          const [ax, ay, az] = pA;
          const [bx, by, bz] = pB;
          const dx = bx - ax;
          const dz = bz - az;
          const lenSq = dx * dx + dz * dz;
          if (lenSq < 1e-4) {
            continue;
          }
          const t = Math.max(
            0.12,
            Math.min(0.88, ((mapX - ax) * dx + (mapZ - az) * dz) / lenSq),
          );
          const qx = ax + dx * t;
          const qy = ay + (by - ay) * t;
          const qz = az + dz * t;
          const distXZ = Math.hypot(mapX - qx, mapZ - qz);
          const dy = Math.abs(qy - mapY);
          const score = distXZ + (dy > 4.5 ? 20 + dy * 1.5 : 0);
          if (score < bestScore) {
            bestScore = score;
            bestEdge = edge;
            bestPos.set(qx, qy, qz);
            const len = Math.sqrt(lenSq);
            bestDirX = dx / len;
            bestDirZ = dz / len;
          }
        }
      }
    }

    if (!bestEdge) {
      return null;
    }

    // Align travel direction (flip only on two-way roads if user is facing opposite)
    let dirX = bestDirX;
    let dirZ = bestDirZ;
    if (bestEdge.bidirectional && preferredDirXZ) {
      const dot = dirX * preferredDirXZ[0] + dirZ * preferredDirXZ[1];
      if (dot < 0) {
        dirX = -dirX;
        dirZ = -dirZ;
      }
    }

    // Offset laterally onto the right-hand driving lane (right vector = (-dirZ, dirX))
    const rightX = -dirZ;
    const rightZ = dirX;
    let lateralOffset = 0;
    const roadWidth = bestEdge.width_m ?? bestEdge.lanes * 3.5;
    if (bestEdge.bidirectional && roadWidth > 5.0) {
      lateralOffset = 1.75;
    } else if (!bestEdge.bidirectional && bestEdge.lanes >= 2) {
      lateralOffset = bestEdge.lanes * 0.5 * 3.5 - 1.75;
    }
    bestPos.x += rightX * lateralOffset;
    bestPos.z += rightZ * lateralOffset;

    const headingRad = Math.atan2(dirX, -dirZ);
    return {
      mapPosition: bestPos,
      headingRad,
      streetName: bestEdge.street_name ?? null,
      maxspeedKmh: bestEdge.maxspeed_kmh ?? 50,
    };
  }

  private unloadChunk(chunkId: string): void {
    const record = this.loadedChunks.get(chunkId);
    if (!record) {
      return;
    }

    this.worldRoot.remove(record.group);
    disposeObjectGeometries(record.group);
    this.loadedChunks.delete(chunkId);
  }
}
