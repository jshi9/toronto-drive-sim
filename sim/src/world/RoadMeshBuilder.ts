import * as THREE from 'three';
import type {
  BusBay,
  ChunkData,
  HighwayGore,
  IntersectionGroup,
  MapEdge,
  MapNode,
  NodeApproach,
  RailCrossing,
  RailTrack,
  TurnRestriction,
  Vec3Tuple,
} from './MapTypes.ts';
import {
  createAsphaltTextureSet,
  createConcreteTextureSet,
  createEarthTerrainTextureSet,
  type ProceduralSurfaceTextureSet,
} from './WorldStyleTextures.ts';
import {
  type DetailBuffers,
  IntersectionDetailBuilder,
  type LiveSplitEndpointCapture,
  SignalMeshAccumulator,
  buffersToMeshGeometry,
  createDetailBuffers,
} from './IntersectionDetailBuilder.ts';

export const LANE_WIDTH_METERS = 3.5;
const ROAD_TILE_LENGTH_METERS = 12.0;
const TTC_TRACK_GAUGE_METERS = 1.495;
const STD_RAIL_GAUGE_METERS = 1.435;
const BRIDGE_DECK_THICKNESS_METERS = 0.8;
const BRIDGE_CURB_WIDTH_METERS = 0.38;
const BRIDGE_CURB_HEIGHT_CITY_METERS = 0.3;
const BRIDGE_BARRIER_HEIGHT_HWY_METERS = 0.78;
const STREET_NAME_MIN_EDGE_LENGTH_METERS = 25.0;
const STREET_NAME_REPEAT_INTERVAL_METERS = 125.0;
const STREET_NAME_ELEVATION_OFFSET_METERS = 0.015;
const MAX_MITER_SCALE = 1.5;
const WORLD_UP = new THREE.Vector3(0, 1, 0);

const BIKE_LANE_WIDTH_METERS = 1.6;
const TAPER_LENGTH_METERS = 26.0;
const INTERSECTION_SETBACK_EXTRA_METERS = 3.5;

const STREETCAR_AVENUE_PATTERN =
  /\b(queen\s+(?:st|street)|king\s+(?:st|street)|dundas\s+(?:st|street)|college\s+(?:st|street)|(?:lower\s+)?spadina\s+(?:ave|avenue|cres|crescent)|st\.?\s*clair|harbourfront|queens\s+quay)\b/i;

export interface RoadSegmentSpec {
  id: string;
  centerline: THREE.Vector3[];
  widthMeters: number;
  lanes?: number;
  oneway?: boolean;
  bidirectional?: boolean;
  hasStreetcar?: boolean;
}

export interface ChunkRoadBuildOptions {
  originOffset?: THREE.Vector3;
  excludedEdgeIds?: ReadonlySet<string>;
}

interface RibbonBuffers {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

type BikeLaneKind = 'none' | 'shared' | 'lane' | 'track';

interface RoadMaterialExtras {
  lanesBothWays?: number;
  lanesReversible?: number;
  bikeLaneLeftM?: number;
  bikeLaneRightM?: number;
  bikeLaneLeftType?: BikeLaneKind;
  bikeLaneRightType?: BikeLaneKind;
  busLanesForward?: boolean[] | null;
  busLanesBackward?: boolean[] | null;
  hovLanesForward?: boolean[] | null;
  changeLanesForward?: string[] | null;
  isSchoolZone?: boolean;
  isHighwayOrRamp?: boolean;
}

interface EdgeCrossSectionProfile {
  lanesTotal: number;
  lanesForward: number;
  lanesBackward: number;
  lanesBothWays: number;
  lanesReversible: number;
  bidirectional: boolean;
  oneway: boolean;
  hasStreetcar: boolean;
  hasBikeLane: boolean;
  bikeLaneLeftM: number;
  bikeLaneRightM: number;
  bikeLaneLeftType: BikeLaneKind;
  bikeLaneRightType: BikeLaneKind;
  busLanesForward: boolean[] | null;
  busLanesBackward: boolean[] | null;
  hovLanesForward: boolean[] | null;
  changeLanesForward: string[] | null;
  isSchoolZone: boolean;
  trafficLeftOffsetM: number;
  trafficRightOffsetM: number;
  leftOffsetM: number;
  rightOffsetM: number;
  widthMeters: number;
  yellowCenterOffsetM: number;
  isHighwayOrRamp: boolean;
  placement: string | null;
}

interface EdgeTransitionPlan {
  startLeftM: number;
  startRightM: number;
  startTaperLenM: number;
  startLeadInM?: number;
  endLeftM: number;
  endRightM: number;
  endTaperLenM: number;
  endLeadInM?: number;
  pocketDividerLatM?: number;
  rightPocketStorageM?: number;
  leftBaySmoothCurve?: boolean;
  leftBayEntryDividerLatM?: number;
  rightPocketLeadInM?: number;
  rightPocketTaperM?: number;
  rightPocketCoreRightM?: number;
  pinnedStartRight?: THREE.Vector3;
  pinnedEndRight?: THREE.Vector3;
  isPlacementTransition?: boolean;
  uWidened: boolean;
  vWidened: boolean;
}

interface RoadTextureSet {
  map: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
  metalnessMap: THREE.CanvasTexture;
  material: THREE.MeshStandardMaterial;
}

interface StreetNameTextureSet {
  texture: THREE.CanvasTexture;
  material: THREE.MeshStandardMaterial;
  aspect: number;
}

interface TrimmedEndpointInfo {
  cutPoint: THREE.Vector3;
  outwardDirXZ: THREE.Vector2;
  halfWidth: number;
  lanes: number;
  forwardLanes: number;
  reverseLanes: number;
  lanesBothWays?: number;
  isControlled: boolean;
  isBidirectional: boolean;
  isIncoming: boolean;
  turnLanes?: string[] | null | undefined;
  yellowOffsetRight?: number;
  incomingSpanOffset?: [number, number] | null;
}

interface NodeIntersectionPlan {
  node: MapNode;
  layer: number;
  isMedianSplit: boolean;
  isMidblockCrossing: boolean;
  hasCrosswalk: boolean;
  hasSignals: boolean;
  setbackByEdgeId: Map<string, number>;
  sortedApproaches: NodeApproach[];
}

function normalizeEdgeName(name: string | string[] | null | undefined): string {
  if (typeof name === 'string') {
    return name;
  }
  if (Array.isArray(name)) {
    return name.join(' / ');
  }
  return '';
}

function normalizeHighwayType(highway: string | string[]): string {
  if (Array.isArray(highway)) {
    return highway[0] ?? 'unclassified';
  }
  return highway || 'unclassified';
}

export function isStreetcarAvenue(
  name: string | string[] | null | undefined,
): boolean {
  const normalized = normalizeEdgeName(name);
  if (!normalized) {
    return false;
  }
  return STREETCAR_AVENUE_PATTERN.test(normalized);
}

/**
 * Produces a canonical signature for road deduplication (used by legacy callers).
 */
export function getCanonicalRoadSignature(edge: MapEdge): string {
  if (edge.oneway || edge.geometry.length < 2) {
    return edge.id;
  }
  const first = edge.geometry[0]!;
  const last = edge.geometry[edge.geometry.length - 1]!;
  const mid = edge.geometry[Math.floor(edge.geometry.length / 2)]!;
  const forwardKey = `${first[0].toFixed(2)},${first[1].toFixed(2)},${first[2].toFixed(2)}>${mid[0].toFixed(2)},${mid[1].toFixed(2)},${mid[2].toFixed(2)}>${last[0].toFixed(2)},${last[1].toFixed(2)},${last[2].toFixed(2)}`;
  const reverseKey = `${last[0].toFixed(2)},${last[1].toFixed(2)},${last[2].toFixed(2)}>${mid[0].toFixed(2)},${mid[1].toFixed(2)},${mid[2].toFixed(2)}>${first[0].toFixed(2)},${first[1].toFixed(2)},${first[2].toFixed(2)}`;
  const orderedGeom = forwardKey <= reverseKey ? forwardKey : reverseKey;
  return `twoway:${edge.lanes}:${edge.layer}:${orderedGeom}`;
}

function createPrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function createEmptyBuffers(): RibbonBuffers {
  return { positions: [], normals: [], uvs: [], indices: [] };
}

function buffersToGeometry(
  buffers: RibbonBuffers,
  planarUvScale = 0,
): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(buffers.positions, 3),
  );
  geometry.setAttribute(
    'normal',
    new THREE.Float32BufferAttribute(buffers.normals, 3),
  );
  if (planarUvScale > 0) {
    const uvOut = new Float32Array((buffers.positions.length / 3) * 2);
    for (let i = 0, j = 0; i < buffers.positions.length; i += 3, j += 2) {
      uvOut[j] = buffers.positions[i]! * planarUvScale;
      uvOut[j + 1] = buffers.positions[i + 2]! * planarUvScale;
    }
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvOut, 2));
  } else {
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(buffers.uvs, 2));
  }
  geometry.setIndex(buffers.indices);
  geometry.computeBoundingSphere();
  return geometry;
}

function appendBuffers(target: RibbonBuffers, source: RibbonBuffers): void {
  const baseVertex = target.positions.length / 3;
  for (let i = 0; i < source.positions.length; i++) {
    target.positions.push(source.positions[i]!);
  }
  for (let i = 0; i < source.normals.length; i++) {
    target.normals.push(source.normals[i]!);
  }
  for (let i = 0; i < source.uvs.length; i++) {
    target.uvs.push(source.uvs[i]!);
  }
  for (let i = 0; i < source.indices.length; i++) {
    target.indices.push(source.indices[i]! + baseVertex);
  }
}

function pushQuad(
  target: RibbonBuffers,
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  d: THREE.Vector3,
  faceNormal: THREE.Vector3,
): void {
  const base = target.positions.length / 3;
  target.positions.push(
    a.x,
    a.y,
    a.z,
    b.x,
    b.y,
    b.z,
    c.x,
    c.y,
    c.z,
    d.x,
    d.y,
    d.z,
  );
  for (let k = 0; k < 4; k++) {
    target.normals.push(faceNormal.x, faceNormal.y, faceNormal.z);
  }
  target.uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
  target.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/**
 * Constructs Three.js 3D road ribbon geometry with graph-aware intersection
 * trimming, unified asphalt aprons, stop bars, miter-clamped smooth ribbons,
 * accurate directional lane markings, streetcar rails, and 3D bridge decks.
 */
export class RoadMeshBuilder {
  private readonly materialCache = new Map<string, RoadTextureSet>();
  private readonly streetNameCache = new Map<string, StreetNameTextureSet>();
  private readonly concreteMaterial: THREE.MeshStandardMaterial;
  private readonly apronAsphaltMaterial: THREE.MeshStandardMaterial;
  private readonly terrainMaterial: THREE.MeshStandardMaterial;
  private readonly railSteelMaterial: THREE.MeshStandardMaterial;
  private readonly railGrooveMaterial: THREE.MeshStandardMaterial;
  private readonly railBallastMaterial: THREE.MeshStandardMaterial;
  private readonly railTieMaterial: THREE.MeshStandardMaterial;
  private readonly crossingGateRedMaterial: THREE.MeshStandardMaterial;
  private readonly schoolSignYellowMaterial: THREE.MeshStandardMaterial;
  private readonly intersectionDetails = new IntersectionDetailBuilder();
  private realisticMode = false;
  private realisticAsphaltTex: ProceduralSurfaceTextureSet | null = null;
  private realisticConcreteTex: ProceduralSurfaceTextureSet | null = null;
  private realisticEarthTex: ProceduralSurfaceTextureSet | null = null;

  constructor() {
    this.concreteMaterial = new THREE.MeshStandardMaterial({
      color: 0x64748b,
      roughness: 0.88,
      metalness: 0.06,
    });
    this.apronAsphaltMaterial = new THREE.MeshStandardMaterial({
      color: 0x262b33,
      roughness: 0.9,
      metalness: 0.04,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    this.terrainMaterial = new THREE.MeshStandardMaterial({
      color: 0x151c26,
      roughness: 0.97,
      metalness: 0.02,
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 2,
    });
    this.railSteelMaterial = new THREE.MeshStandardMaterial({
      color: 0xd8e0ea,
      roughness: 0.32,
      metalness: 0.72,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    this.railGrooveMaterial = new THREE.MeshStandardMaterial({
      color: 0x0f131a,
      roughness: 0.92,
      metalness: 0.05,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.railBallastMaterial = new THREE.MeshStandardMaterial({
      color: 0x5c5852,
      roughness: 0.96,
      metalness: 0.02,
    });
    this.railTieMaterial = new THREE.MeshStandardMaterial({
      color: 0x3b2f26,
      roughness: 0.95,
      metalness: 0.02,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    this.crossingGateRedMaterial = new THREE.MeshStandardMaterial({
      color: 0xdc2626,
      roughness: 0.5,
      metalness: 0.1,
    });
    this.schoolSignYellowMaterial = new THREE.MeshStandardMaterial({
      color: 0xd9f99d,
      roughness: 0.52,
      metalness: 0.04,
    });
  }

  /**
   * Advances city-wide animated traffic & pedestrian signal light phases.
   */
  public updateTrafficLights(elapsedSeconds: number): void {
    this.intersectionDetails.updateTrafficLights(elapsedSeconds);
  }

  public isRealisticMode(): boolean {
    return this.realisticMode;
  }

  /**
   * Toggles realistic PBR procedural textures (grainy asphalt, poured concrete
   * sidewalks/medians, and grassy earth terrain) across all streamed chunks.
   */
  public setRealisticMode(enabled: boolean): void {
    if (this.realisticMode === enabled) {
      return;
    }
    this.realisticMode = enabled;

    if (enabled) {
      this.realisticAsphaltTex ??= createAsphaltTextureSet();
      this.realisticConcreteTex ??= createConcreteTextureSet();
      this.realisticEarthTex ??= createEarthTerrainTextureSet(1);

      this.apronAsphaltMaterial.map = this.realisticAsphaltTex.map;
      this.apronAsphaltMaterial.roughnessMap =
        this.realisticAsphaltTex.roughnessMap;
      this.apronAsphaltMaterial.color.setHex(0xeef1f5);

      this.concreteMaterial.map = this.realisticConcreteTex.map;
      this.concreteMaterial.roughnessMap = this.realisticConcreteTex.roughnessMap;
      this.concreteMaterial.color.setHex(0xcbd5e1);

      this.terrainMaterial.map = this.realisticEarthTex.map;
      this.terrainMaterial.roughnessMap = this.realisticEarthTex.roughnessMap;
      this.terrainMaterial.color.setHex(0xc8d2be);

      this.intersectionDetails.setRealisticConcreteTextures(
        this.realisticConcreteTex.map,
        this.realisticConcreteTex.roughnessMap,
      );
    } else {
      this.apronAsphaltMaterial.map = null;
      this.apronAsphaltMaterial.roughnessMap = null;
      this.apronAsphaltMaterial.color.setHex(0x262b33);

      this.concreteMaterial.map = null;
      this.concreteMaterial.roughnessMap = null;
      this.concreteMaterial.color.setHex(0x64748b);

      this.terrainMaterial.map = null;
      this.terrainMaterial.roughnessMap = null;
      this.terrainMaterial.color.setHex(0x151c26);

      this.intersectionDetails.setRealisticConcreteTextures(null, null);
    }

    this.apronAsphaltMaterial.needsUpdate = true;
    this.concreteMaterial.needsUpdate = true;
    this.terrainMaterial.needsUpdate = true;
  }

  /**
   * Builds a standalone group for a generic RoadSegmentSpec.
   */
  public buildSegmentGroup(segment: RoadSegmentSpec): THREE.Group {
    const group = new THREE.Group();
    group.name = `road-${segment.id}`;
    if (segment.centerline.length < 2) {
      return group;
    }

    const lanes = Math.max(
      1,
      segment.lanes ?? Math.round(segment.widthMeters / LANE_WIDTH_METERS),
    );
    const oneway = segment.oneway ?? false;
    const bidirectional = segment.bidirectional ?? !oneway;
    const fwdLanes = oneway ? lanes : Math.max(1, Math.floor(lanes / 2));
    const revLanes = oneway ? 0 : Math.max(1, lanes - fwdLanes);
    const hasStreetcar = segment.hasStreetcar ?? false;
    const subdivided = this.subdivideSharpCorners(segment.centerline);
    const buffers = this.createRibbonBuffers(
      subdivided,
      segment.widthMeters,
      false,
      new THREE.Vector3(),
    );
    if (buffers.positions.length === 0) {
      return group;
    }

    const material = this.getRoadMaterial(
      lanes,
      bidirectional,
      oneway,
      fwdLanes,
      revLanes,
      hasStreetcar,
      false,
    );
    const mesh = new THREE.Mesh(buffersToGeometry(buffers), material);
    mesh.receiveShadow = true;
    mesh.name = `road-ribbon-${segment.id}`;
    group.add(mesh);
    return group;
  }

  /**
   * Builds a 3D mesh (and concrete bridge deck if elevated) for a single MapEdge.
   */
  public buildEdgeMesh(
    edge: MapEdge,
    originOffset = new THREE.Vector3(),
  ): THREE.Group {
    const group = new THREE.Group();
    group.name = `edge-${edge.id}`;

    const rawPoints = this.cleanPolyline(edge.geometry);
    if (rawPoints.length < 2) {
      return group;
    }

    const points = this.subdivideSharpCorners(rawPoints);
    const cs = this.resolveEdgeCrossSection(edge);
    const {
      lanesTotal: lanes,
      bidirectional,
      oneway,
      lanesForward: forwardLanes,
      lanesBackward: reverseLanes,
      lanesBothWays,
      hasStreetcar,
      bikeLaneLeftM,
      bikeLaneRightM,
      isHighwayOrRamp,
      leftOffsetM,
      rightOffsetM,
    } = cs;
    const hw = normalizeHighwayType(edge.highway);
    const allowBank = hw === 'motorway' || hw === 'motorway_link';
    const isBridge = edge.bridge || edge.layer > 0;
    const isMotorwayBridge = hw === 'motorway' || hw === 'motorway_link';

    const ribbonBuffers = this.createRibbonBuffersWithOffsets(
      points,
      leftOffsetM,
      rightOffsetM,
      allowBank,
      originOffset,
    );
    if (ribbonBuffers.positions.length > 0) {
      const roadMat = this.getRoadMaterial(
        lanes,
        bidirectional,
        oneway,
        forwardLanes,
        reverseLanes,
        hasStreetcar,
        isBridge,
        { lanesBothWays, bikeLaneLeftM, bikeLaneRightM, isHighwayOrRamp },
      );
      const roadMesh = new THREE.Mesh(
        buffersToGeometry(ribbonBuffers),
        roadMat,
      );
      roadMesh.receiveShadow = true;
      roadMesh.castShadow = isBridge;
      group.add(roadMesh);
    }

    if (isBridge) {
      const deckBuffers = this.createBridgeDeckBuffers(
        points,
        cs.widthMeters,
        allowBank,
        isMotorwayBridge,
        originOffset,
      );
      if (deckBuffers.positions.length > 0) {
        const deckMesh = new THREE.Mesh(
          buffersToGeometry(deckBuffers),
          this.concreteMaterial,
        );
        deckMesh.castShadow = true;
        deckMesh.receiveShadow = true;
        group.add(deckMesh);
      }
    }

    return group;
  }

  /**
   * Builds a batched THREE.Group containing trimmed road ribbons, unified
   * intersection aprons, controlled-approach stop bars, and 3D bridge decks.
   */
  public buildChunkGroup(
    chunk: ChunkData,
    options: ChunkRoadBuildOptions = {},
  ): THREE.Group {
    const group = new THREE.Group();
    group.name = `chunk-roads-${chunk.chunk.id}`;

    const originOffset =
      options.originOffset ??
      new THREE.Vector3(
        chunk.chunk.bounds_m.min_x,
        0,
        chunk.chunk.bounds_m.min_z,
      );
    const excludedEdgeIds = options.excludedEdgeIds;

    const nodeLookup = new Map<number, MapNode>();
    const clusteredCornerKeys = new Set<string>();
    for (const node of chunk.nodes) {
      nodeLookup.set(node.id, node);
      for (const app of node.approaches ?? []) {
        if (app.intersection_internal) {
          clusteredCornerKeys.add(`${node.id}:${app.layer}`);
        }
      }
    }
    for (const ig of chunk.intersection_groups ?? []) {
      for (const nid of ig.corner_nodes) {
        clusteredCornerKeys.add(`${nid}:${ig.layer}`);
      }
    }

    const controlledIgEndpoints = new Set<string>();
    const igByCornerKey = new Map<string, IntersectionGroup>();
    for (const ig of chunk.intersection_groups ?? []) {
      for (const cn of ig.corner_nodes) {
        igByCornerKey.set(`${cn}:${ig.layer}`, ig);
      }
      if (!(ig.has_crosswalks || ig.signalized || ig.stop_controlled)) {
        continue;
      }
      for (const app of ig.approaches) {
        controlledIgEndpoints.add(`${app.edge_id}:${app.corner_node}`);
        const baseId = app.edge_id.split('__')[0] ?? app.edge_id;
        controlledIgEndpoints.add(`${baseId}:${app.corner_node}`);
      }
    }

    // Build intersection trim plans for single-node intersections & Y-splits
    const nodePlans = this.computeIntersectionPlans(chunk, clusteredCornerKeys);
    const { profiles: edgeProfiles, transitions: edgeTransitions } =
      this.computeEdgeTransitionPlans(chunk, nodePlans, excludedEdgeIds);

    const chunkSplitNodeIds = new Set<number>(
      (chunk.median_transitions ?? []).map((mt) => mt.split_node),
    );
    const liveSplitEndpoints = new Map<number, LiveSplitEndpointCapture[]>();

    const buckets = new Map<
      string,
      {
        lanes: number;
        bidirectional: boolean;
        oneway: boolean;
        forwardLanes: number;
        reverseLanes: number;
        hasStreetcar: boolean;
        isBridge: boolean;
        extras: RoadMaterialExtras;
        buffers: RibbonBuffers;
      }
    >();
    const bridgeDeckBuffers = createEmptyBuffers();
    const whitePaintBuffers = createDetailBuffers();
    const yellowPaintBuffers = createDetailBuffers();
    const apronBuffers = createEmptyBuffers();
    const apronBridgeDeckBuffers = createEmptyBuffers();
    const concreteTopBuffers = createDetailBuffers();
    const concreteSideBuffers = createDetailBuffers();
    const railSteelBuf = createDetailBuffers();
    const railGrooveBuf = createDetailBuffers();
    const railBallastBuf = createDetailBuffers();
    const railTieBuf = createDetailBuffers();
    const gateRedBuf = createDetailBuffers();
    const schoolYellowBuf = createDetailBuffers();
    const arrowBuckets = new Map<string, DetailBuffers>();
    const signalAccumulator = new SignalMeshAccumulator();
    const streetNameBuckets = new Map<string, RibbonBuffers>();

    // Map `${nodeId}:${layer}:${edgeId}` -> exact trimmed cross-section
    const trimmedCrossSections = new Map<string, TrimmedEndpointInfo>();

    for (const edge of chunk.edges) {
      if (excludedEdgeIds?.has(edge.id) || edge.intersection_internal) {
        continue;
      }

      const rawPoints = this.cleanPolyline(edge.geometry);
      if (rawPoints.length < 2) {
        continue;
      }

      const cs = edgeProfiles.get(edge.id) ?? this.resolveEdgeCrossSection(edge);
      let trans = edgeTransitions.get(edge.id);
      const lanes = cs.lanesTotal;
      const bidirectional = cs.bidirectional;
      const oneway = cs.oneway;
      const forwardLanes = cs.lanesForward;
      const reverseLanes = cs.lanesBackward;
      const widthMeters = cs.widthMeters;
      const halfWidth = widthMeters * 0.5;
      const ribbonMidOffsetM = (cs.leftOffsetM + cs.rightOffsetM) * 0.5;
      const hw = normalizeHighwayType(edge.highway);
      const allowBank = hw === 'motorway' || hw === 'motorway_link';
      const streetName = this.resolveEdgeStreetName(edge);
      const hasStreetcar = cs.hasStreetcar;
      const isBridge = edge.bridge || edge.layer > 0;
      const isMotorwayBridge = hw === 'motorway' || hw === 'motorway_link';
      const matExtras: RoadMaterialExtras = {
        lanesBothWays: cs.lanesBothWays,
        lanesReversible: cs.lanesReversible,
        bikeLaneLeftM: cs.bikeLaneLeftM,
        bikeLaneRightM: cs.bikeLaneRightM,
        bikeLaneLeftType: cs.bikeLaneLeftType,
        bikeLaneRightType: cs.bikeLaneRightType,
        busLanesForward: cs.busLanesForward,
        busLanesBackward: cs.busLanesBackward,
        hovLanesForward: cs.hovLanesForward,
        changeLanesForward: cs.changeLanesForward,
        isSchoolZone: cs.isSchoolZone,
        isHighwayOrRamp: cs.isHighwayOrRamp,
      };

      const totalLen = this.computePolylineLength(rawPoints);
      const uPlan = nodePlans.get(`${edge.u}:${edge.layer}`);
      const vPlan = nodePlans.get(`${edge.v}:${edge.layer}`);
      let sStart =
        typeof edge.trim_start_m === 'number' && edge.trim_start_m > 0
          ? edge.trim_start_m
          : (uPlan?.setbackByEdgeId.get(edge.id) ?? 0);
      let sEnd =
        typeof edge.trim_end_m === 'number' && edge.trim_end_m > 0
          ? edge.trim_end_m
          : (vPlan?.setbackByEdgeId.get(edge.id) ?? 0);

      if (sStart + sEnd > totalLen - 1.5) {
        const scale =
          totalLen > 1.5 ? (totalLen - 1.5) / Math.max(1e-6, sStart + sEnd) : 0;
        sStart *= scale;
        sEnd *= scale;
      }

      const trimmedRaw = this.trimPolylineByDistances(rawPoints, sStart, sEnd);
      if (trimmedRaw.length < 2) {
        continue;
      }

      const baseEdgeId = edge.id.split('__')[0] ?? edge.id;
      const uNodeObj = nodeLookup.get(edge.u);
      const vNodeObj = nodeLookup.get(edge.v);

      // Record exact trimmed cut points (centered at ribbonMidOffsetM) for single-node aprons & stop bars
      if (uPlan) {
        const p0 = trimmedRaw[0]!;
        const p1 = trimmedRaw[1]!;
        const outDir = new THREE.Vector2(p1.x - p0.x, p1.z - p0.z);
        if (outDir.lengthSq() > 1e-8) {
          outDir.normalize();
        } else {
          outDir.set(1, 0);
        }
        const shiftedCutU = new THREE.Vector3(
          p0.x - outDir.y * ribbonMidOffsetM,
          p0.y,
          p0.z + outDir.x * ribbonMidOffsetM,
        );
        const isControlled =
          bidirectional &&
          Boolean(uNodeObj?.traffic_signal || uNodeObj?.stop_sign);
        const yellowOffsetRightU = cs.yellowCenterOffsetM - ribbonMidOffsetM;
        const incomingSpanU: [number, number] | null = bidirectional
          ? [
              cs.trafficLeftOffsetM - ribbonMidOffsetM,
              cs.trafficLeftOffsetM + reverseLanes * LANE_WIDTH_METERS - ribbonMidOffsetM,
            ]
          : null;
        trimmedCrossSections.set(`${edge.u}:${edge.layer}:${edge.id}`, {
          cutPoint: shiftedCutU,
          outwardDirXZ: outDir,
          halfWidth,
          lanes,
          forwardLanes: bidirectional ? reverseLanes : forwardLanes,
          reverseLanes: bidirectional ? forwardLanes : reverseLanes,
          lanesBothWays: cs.lanesBothWays,
          isControlled,
          isBidirectional: bidirectional,
          isIncoming: bidirectional,
          turnLanes: bidirectional ? (edge.turn_lanes_backward ?? edge.turn_lanes_rev) : null,
          yellowOffsetRight: yellowOffsetRightU,
          incomingSpanOffset: incomingSpanU,
        });

        if (isControlled && !uPlan.isMedianSplit) {
          this.intersectionDetails.appendStopBarQuadAtCut(
            whitePaintBuffers,
            shiftedCutU,
            outDir,
            halfWidth,
            bidirectional,
            reverseLanes,
            lanes,
            originOffset,
            incomingSpanU,
          );
        }
      }

      if (vPlan) {
        const pLast = trimmedRaw[trimmedRaw.length - 1]!;
        const pPrev = trimmedRaw[trimmedRaw.length - 2]!;
        const outDir = new THREE.Vector2(pPrev.x - pLast.x, pPrev.z - pLast.z);
        if (outDir.lengthSq() > 1e-8) {
          outDir.normalize();
        } else {
          outDir.set(1, 0);
        }
        // At v, edge forward tangent = -outDir, so edgeRight = (outDir.y, -outDir.x)
        const shiftedCutV = new THREE.Vector3(
          pLast.x + outDir.y * ribbonMidOffsetM,
          pLast.y,
          pLast.z - outDir.x * ribbonMidOffsetM,
        );
        const isControlled = Boolean(vNodeObj?.traffic_signal || vNodeObj?.stop_sign);
        const yellowOffsetRightV = -(cs.yellowCenterOffsetM - ribbonMidOffsetM);
        const incomingSpanV: [number, number] = bidirectional
          ? [
              ribbonMidOffsetM - cs.trafficRightOffsetM,
              ribbonMidOffsetM - (cs.trafficRightOffsetM - forwardLanes * LANE_WIDTH_METERS),
            ]
          : [ribbonMidOffsetM - cs.trafficRightOffsetM, ribbonMidOffsetM - cs.trafficLeftOffsetM];
        trimmedCrossSections.set(`${edge.v}:${edge.layer}:${edge.id}`, {
          cutPoint: shiftedCutV,
          outwardDirXZ: outDir,
          halfWidth,
          lanes,
          forwardLanes,
          reverseLanes,
          lanesBothWays: cs.lanesBothWays,
          isControlled,
          isBidirectional: bidirectional,
          isIncoming: true,
          turnLanes: edge.turn_lanes_forward ?? edge.turn_lanes_fwd,
          yellowOffsetRight: yellowOffsetRightV,
          incomingSpanOffset: incomingSpanV,
        });

        if (isControlled && !vPlan.isMedianSplit) {
          this.intersectionDetails.appendStopBarQuadAtCut(
            whitePaintBuffers,
            shiftedCutV,
            outDir,
            halfWidth,
            bidirectional,
            forwardLanes,
            lanes,
            originOffset,
            incomingSpanV,
          );
        }
      }

      const startNeedsClearanceCollar =
        Boolean(
          uPlan &&
            !uPlan.isMedianSplit &&
            (uPlan.hasCrosswalk || uPlan.hasSignals || uNodeObj?.stop_sign),
        ) ||
        controlledIgEndpoints.has(`${edge.id}:${edge.u}`) ||
        controlledIgEndpoints.has(`${baseEdgeId}:${edge.u}`);
      const endNeedsClearanceCollar =
        Boolean(
          vPlan &&
            !vPlan.isMedianSplit &&
            (vPlan.hasCrosswalk || vPlan.hasSignals || vNodeObj?.stop_sign),
        ) ||
        controlledIgEndpoints.has(`${edge.id}:${edge.v}`) ||
        controlledIgEndpoints.has(`${baseEdgeId}:${edge.v}`);

      // Trim textured road ribbon back to stop-bar face (~1.6m behind crosswalk cutPoint)
      // and bridge [cutPoint .. stopBar] with spotless plain dark asphalt so ZERO lane markers
      // or yellow lines ever leak between the solid stop bar and the pedestrian crossing.
      const trimmedLen = this.computePolylineLength(trimmedRaw);
      const startCollarM =
        startNeedsClearanceCollar && trimmedLen > 4.0
          ? Math.min(1.65, Math.max(0, trimmedLen - 2.0) * 0.25)
          : 0;
      const endCollarM =
        endNeedsClearanceCollar && trimmedLen > 4.0
          ? Math.min(1.65, Math.max(0, trimmedLen - startCollarM - 2.0) * 0.25)
          : 0;

      const uHasIntersection =
        Boolean(uPlan && !uPlan.isMedianSplit) ||
        Boolean(uNodeObj?.traffic_signal || uNodeObj?.stop_sign);
      const vHasIntersection =
        Boolean(vPlan && !vPlan.isMedianSplit) ||
        Boolean(vNodeObj?.traffic_signal || vNodeObj?.stop_sign);
      const uIncomingControlled =
        bidirectional &&
        Boolean(
          uNodeObj?.traffic_signal ||
            uNodeObj?.stop_sign ||
            controlledIgEndpoints.has(`${edge.id}:${edge.u}`) ||
            controlledIgEndpoints.has(`${baseEdgeId}:${edge.u}`),
        );
      const vIncomingControlled = Boolean(
        vNodeObj?.traffic_signal ||
          vNodeObj?.stop_sign ||
          controlledIgEndpoints.has(`${edge.id}:${edge.v}`) ||
          controlledIgEndpoints.has(`${baseEdgeId}:${edge.v}`),
      );

      // Flare exclusive right-turn pocket (+1 lane on outer right curb) gradually near the intersection
      // instead of abruptly adding two extra lanes at once back at the Y-split
      const vLegalTurns = this.computeLegalTurnsForEdgeEndpoint(
        edge,
        true,
        rawPoints,
        nodeLookup,
        igByCornerKey,
      );
      const uLegalTurns = bidirectional
        ? this.computeLegalTurnsForEdgeEndpoint(edge, false, rawPoints, nodeLookup, igByCornerKey)
        : undefined;
      const rightPocketCount = vLegalTurns.right ? this.getRightPocketLanes(edge, cs) : 0;
      const roadPolyLen = Math.max(0, trimmedLen - startCollarM - endCollarM);
      if (
        rightPocketCount === 1 &&
        trans &&
        trans.startTaperLenM <= 0.15 &&
        trans.endTaperLenM <= 0.15 &&
        roadPolyLen >= 16.0 &&
        (vHasIntersection ||
          vIncomingControlled ||
          chunkSplitNodeIds.has(edge.u) ||
          uNodeObj?.node_type === 'median_split')
      ) {
        const pocketStorageM = Math.min(20.0, Math.max(8.5, roadPolyLen * 0.4));
        const pocketTaperM = Math.min(18.0, Math.max(9.0, roadPolyLen * 0.38));
        const leadInM = Math.max(0.0, roadPolyLen - pocketStorageM - pocketTaperM);
        const coreRightM = cs.rightOffsetM - LANE_WIDTH_METERS;
        trans = {
          ...trans,
          startLeftM: cs.leftOffsetM,
          startRightM: coreRightM,
          startLeadInM: leadInM,
          startTaperLenM: pocketTaperM,
          pocketDividerLatM: coreRightM,
          rightPocketStorageM: pocketStorageM + endCollarM,
        };
      } else if (
        rightPocketCount === 1 &&
        trans &&
        trans.startTaperLenM > 0.15 &&
        trans.endTaperLenM <= 0.15 &&
        Math.abs(trans.startRightM - (cs.rightOffsetM - LANE_WIDTH_METERS)) <= 0.25 &&
        roadPolyLen >= trans.startTaperLenM + 20.0
      ) {
        const coreRightM = cs.rightOffsetM - LANE_WIDTH_METERS;
        const remLen = roadPolyLen - trans.startTaperLenM;
        const pocketStorageM = Math.min(24.0, Math.max(10.0, remLen * 0.42));
        const pocketTaperM = Math.min(18.0, Math.max(9.0, remLen * 0.36));
        const rightLeadInM = Math.max(
          trans.startTaperLenM,
          roadPolyLen - pocketStorageM - pocketTaperM,
        );
        trans = {
          ...trans,
          rightPocketLeadInM: rightLeadInM,
          rightPocketTaperM: pocketTaperM,
          rightPocketCoreRightM: coreRightM,
          rightPocketStorageM: pocketStorageM + endCollarM,
          pocketDividerLatM: coreRightM,
        };
      }

      const collarLeftStartM = (trans?.startTaperLenM ?? 0) > 0.15 && trans ? trans.startLeftM : cs.leftOffsetM;
      const collarRightStartM = (trans?.startTaperLenM ?? 0) > 0.15 && trans ? trans.startRightM : cs.rightOffsetM;
      const collarLeftEndM = (trans?.endTaperLenM ?? 0) > 0.15 && trans ? trans.endLeftM : cs.leftOffsetM;
      const collarRightEndM = (trans?.endTaperLenM ?? 0) > 0.15 && trans ? trans.endRightM : cs.rightOffsetM;

      let roadPointsRaw = trimmedRaw;
      if (startCollarM > 0.1 || endCollarM > 0.1) {
        if (startCollarM > 0.1) {
          const collarStart = this.trimPolylineByDistances(
            trimmedRaw,
            0,
            Math.max(0.5, trimmedLen - startCollarM),
          );
          if (collarStart.length >= 2) {
            appendBuffers(
              apronBuffers,
              this.createRibbonBuffersWithOffsets(
                collarStart,
                collarLeftStartM,
                collarRightStartM,
                allowBank,
                originOffset,
                0,
                1,
                trans?.pinnedStartRight,
                undefined,
              ),
            );
          }
        }
        if (endCollarM > 0.1) {
          const collarEnd = this.trimPolylineByDistances(
            trimmedRaw,
            Math.max(0.5, trimmedLen - endCollarM),
            0,
          );
          if (collarEnd.length >= 2) {
            appendBuffers(
              apronBuffers,
              this.createRibbonBuffersWithOffsets(
                collarEnd,
                collarLeftEndM,
                collarRightEndM,
                allowBank,
                originOffset,
                0,
                1,
                undefined,
                trans?.pinnedEndRight,
              ),
            );
          }
        }
        roadPointsRaw = this.trimPolylineByDistances(trimmedRaw, startCollarM, endCollarM);
      }
      if (roadPointsRaw.length < 2) {
        roadPointsRaw = trimmedRaw;
      }

      const points = this.subdivideSharpCorners(roadPointsRaw);
      if (points.length < 2) {
        continue;
      }

      const needTurnOrSolidMarkings =
        (bidirectional && cs.lanesBothWays === 1) ||
        (lanes >= 2 && (uHasIntersection || vHasIntersection || uIncomingControlled || vIncomingControlled)) ||
        Boolean(edge.turn_lanes_forward?.length || edge.turn_lanes_fwd?.length) ||
        Boolean(edge.turn_lanes_backward?.length || edge.turn_lanes_rev?.length);
      const hasProtectedBikeTrack =
        cs.bikeLaneLeftType === 'track' || cs.bikeLaneRightType === 'track';
      const hasMidblockCtrl = (edge.midblock_controls?.length ?? 0) > 0;
      const needFrameCapture =
        needTurnOrSolidMarkings ||
        hasProtectedBikeTrack ||
        hasMidblockCtrl ||
        cs.isSchoolZone ||
        chunkSplitNodeIds.has(edge.u) ||
        chunkSplitNodeIds.has(edge.v);
      const frame = needFrameCapture ? this.computeFrameAlongPolyline(points, allowBank) : null;

      if (frame && points.length >= 2) {
        const lastIdx = points.length - 1;
        const p0 = points[0]!;
        const r0 = trans?.pinnedStartRight ?? frame.rights[0]!;
        const t0 = frame.tangents[0]!;
        const scale0 = frame.miterScales[0]!;
        const hasStartWidthOverride =
          Boolean(trans && (trans.startTaperLenM > 0.15 || (trans.startLeadInM ?? 0) > 0.15));
        const rawL0 = hasStartWidthOverride && trans ? trans.startLeftM : cs.leftOffsetM;
        const rawR0 = hasStartWidthOverride && trans ? trans.startRightM : cs.rightOffsetM;
        const lOff0 = rawL0 * scale0;
        const rOff0 = rawR0 * scale0;
        const splitWidth0 = Math.max(3.0, rawR0 - rawL0);
        const splitLanes0 =
          hasStartWidthOverride && trans?.pocketDividerLatM !== undefined
            ? Math.max(1, lanes - 1)
            : lanes;
        const pLast = points[lastIdx]!;
        const rLast = trans?.pinnedEndRight ?? frame.rights[lastIdx]!;
        const tLast = frame.tangents[lastIdx]!;
        const scaleLast = frame.miterScales[lastIdx]!;
        const lOffLast = (trans && trans.endTaperLenM > 0.15 ? trans.endLeftM : cs.leftOffsetM) * scaleLast;
        const rOffLast = (trans && trans.endTaperLenM > 0.15 ? trans.endRightM : cs.rightOffsetM) * scaleLast;

        if (chunkSplitNodeIds.has(edge.u)) {
          let list = liveSplitEndpoints.get(edge.u);
          if (!list) {
            list = [];
            liveSplitEndpoints.set(edge.u, list);
          }
          list.push({
            cutPt: p0.clone().addScaledVector(r0, (lOff0 + rOff0) * 0.5),
            leftPt: p0.clone().addScaledVector(r0, lOff0),
            rightPt: p0.clone().addScaledVector(r0, rOff0),
            yellowPt: p0.clone().addScaledVector(r0, cs.yellowCenterOffsetM * scale0),
            outDir: new THREE.Vector3(t0.x, 0, t0.z).normalize(),
            isTrunk: bidirectional,
            lanes: splitLanes0,
            reverseLanes,
            width: splitWidth0,
          });
        }
        if (chunkSplitNodeIds.has(edge.v)) {
          let list = liveSplitEndpoints.get(edge.v);
          if (!list) {
            list = [];
            liveSplitEndpoints.set(edge.v, list);
          }
          list.push({
            cutPt: pLast.clone().addScaledVector(rLast, (lOffLast + rOffLast) * 0.5),
            leftPt: pLast.clone().addScaledVector(rLast, lOffLast),
            rightPt: pLast.clone().addScaledVector(rLast, rOffLast),
            yellowPt: pLast.clone().addScaledVector(rLast, cs.yellowCenterOffsetM * scaleLast),
            outDir: new THREE.Vector3(-tLast.x, 0, -tLast.z).normalize(),
            isTrunk: bidirectional,
            lanes,
            reverseLanes,
            width: widthMeters,
          });
        }
      }

      const matKey = this.getMaterialKey(
        lanes,
        bidirectional,
        oneway,
        forwardLanes,
        reverseLanes,
        hasStreetcar,
        isBridge,
        matExtras,
      );
      let bucket = buckets.get(matKey);
      if (!bucket) {
        bucket = {
          lanes,
          bidirectional,
          oneway,
          forwardLanes,
          reverseLanes,
          hasStreetcar,
          isBridge,
          extras: matExtras,
          buffers: createEmptyBuffers(),
        };
        buckets.set(matKey, bucket);
      }
      this.appendRoadSurfaceWithTapers(
        bucket.buffers,
        apronBuffers,
        whitePaintBuffers,
        yellowPaintBuffers,
        points,
        cs,
        trans,
        allowBank,
        originOffset,
        startCollarM,
      );

      if (frame && needTurnOrSolidMarkings) {
        this.intersectionDetails.appendTurnLaneMarkings(
          whitePaintBuffers,
          arrowBuckets,
          points,
          frame.tangents,
          frame.rights,
          frame.normals,
          frame.distances,
          widthMeters,
          lanes,
          bidirectional,
          forwardLanes,
          reverseLanes,
          edge,
          originOffset,
          startCollarM,
          endCollarM,
          {
            trafficLeftOffsetM: cs.trafficLeftOffsetM,
            lanesBothWays: cs.lanesBothWays,
            lanesReversible: cs.lanesReversible,
            uIncomingControlled,
            vIncomingControlled,
            uHasIntersection,
            vHasIntersection,
            uWidened: Boolean(trans?.uWidened),
            vWidened: Boolean(trans?.vWidened),
            vLegalTurns,
            ...(uLegalTurns ? { uLegalTurns } : {}),
            ...(trans?.rightPocketStorageM !== undefined ? { rightPocketLimitM: trans.rightPocketStorageM } : {}),
          },
        );
      }

      if (isBridge) {
        let bridgePts =
          startCollarM > 0.1 || endCollarM > 0.1
            ? this.subdivideSharpCorners(trimmedRaw)
            : points;
        if (Math.abs(ribbonMidOffsetM) > 0.05 && bridgePts.length >= 2) {
          const brFrame = this.computeFrameAlongPolyline(bridgePts, allowBank);
          bridgePts = bridgePts.map((pt, i) =>
            pt.clone().addScaledVector(brFrame.rights[i]!, ribbonMidOffsetM),
          );
        }
        const uNodeG = nodeLookup.get(edge.u)?.ground_y ?? bridgePts[0]!.y;
        const vNodeG = nodeLookup.get(edge.v)?.ground_y ?? bridgePts[bridgePts.length - 1]!.y;
        const deck = this.createBridgeDeckBuffers(
          bridgePts,
          widthMeters,
          allowBank,
          isMotorwayBridge,
          originOffset,
          uNodeG,
          vNodeG,
        );
        appendBuffers(bridgeDeckBuffers, deck);
      }

      if (frame && hasProtectedBikeTrack && !isBridge) {
        this.appendProtectedBikeCurbs(
          concreteTopBuffers,
          concreteSideBuffers,
          points,
          frame.rights,
          frame.normals,
          frame.distances,
          cs,
          uHasIntersection,
          vHasIntersection,
          originOffset,
        );
      }

      if (frame && hasMidblockCtrl) {
        this.appendMidblockCrosswalks(
          whitePaintBuffers,
          yellowPaintBuffers,
          signalAccumulator,
          schoolYellowBuf,
          points,
          frame.tangents,
          frame.rights,
          frame.distances,
          cs.leftOffsetM,
          cs.rightOffsetM,
          uHasIntersection,
          vHasIntersection,
          edge.midblock_controls,
          originOffset,
        );
      }

      if (frame && cs.isSchoolZone && !cs.isHighwayOrRamp && edge.length_m >= 38) {
        this.appendSchoolZoneSignage(
          signalAccumulator,
          schoolYellowBuf,
          points,
          frame.tangents,
          frame.rights,
          frame.distances,
          cs.leftOffsetM,
          cs.rightOffsetM,
          bidirectional,
          originOffset,
        );
      }

      if (streetName && edge.length_m >= STREET_NAME_MIN_EDGE_LENGTH_METERS) {
        const labelLanes =
          trans?.pocketDividerLatM !== undefined ? Math.max(1, lanes - 1) : lanes;
        const labelWidth =
          trans?.pocketDividerLatM !== undefined
            ? Math.max(LANE_WIDTH_METERS, widthMeters - LANE_WIDTH_METERS)
            : widthMeters;
        this.appendStreetNameDecals(
          streetNameBuckets,
          streetName,
          points,
          labelLanes,
          labelWidth,
          bidirectional,
          forwardLanes,
          reverseLanes,
          hasStreetcar,
          allowBank,
          originOffset,
          { lanesBothWays: cs.lanesBothWays, trafficLeftOffsetM: cs.trafficLeftOffsetM },
        );
      }
    }

    const transitionNodeIds = new Set<number>();
    for (const mt of chunk.median_transitions ?? []) {
      transitionNodeIds.add(mt.split_node);
      this.intersectionDetails.appendMedianSplitTransition(
        mt,
        apronBuffers,
        whitePaintBuffers,
        yellowPaintBuffers,
        originOffset,
        liveSplitEndpoints.get(mt.split_node),
      );
    }

    // Build unified flush asphalt aprons, crosswalks, guide lines, & signals for single-node intersections
    for (const plan of nodePlans.values()) {
      if (!plan.node.in_chunk) {
        continue;
      }
      if (plan.isMedianSplit && transitionNodeIds.has(plan.node.id)) {
        continue;
      }
      this.appendIntersectionApron(
        apronBuffers,
        plan.layer > 0 ? apronBridgeDeckBuffers : null,
        plan,
        trimmedCrossSections,
        originOffset,
      );

      if (!plan.isMedianSplit) {
        const appDetails: Array<{
          cutPoint: THREE.Vector3;
          outDir: THREE.Vector2;
          halfWidth: number;
          lanes: number;
          bidirectional: boolean;
          isIncoming: boolean;
          forwardLanes: number;
          reverseLanes: number;
          lanesBothWays?: number;
          turnLanes?: string[] | null | undefined;
          crosswalkMarkings?: string;
          yellowOffsetRight?: number;
        }> = [];

        for (const app of plan.sortedApproaches) {
          const trimmed = trimmedCrossSections.get(
            `${plan.node.id}:${plan.layer}:${app.edge_id}`,
          );
          if (trimmed) {
            appDetails.push({
              cutPoint: trimmed.cutPoint,
              outDir: trimmed.outwardDirXZ,
              halfWidth: trimmed.halfWidth,
              lanes: trimmed.lanes,
              bidirectional: trimmed.isBidirectional,
              isIncoming: trimmed.isIncoming,
              forwardLanes: trimmed.forwardLanes,
              reverseLanes: trimmed.reverseLanes,
              ...(trimmed.lanesBothWays !== undefined ? { lanesBothWays: trimmed.lanesBothWays } : {}),
              turnLanes: trimmed.turnLanes,
              crosswalkMarkings: app.crosswalk_markings ?? plan.node.crosswalk_markings ?? 'ladder',
              ...(trimmed.yellowOffsetRight !== undefined
                ? { yellowOffsetRight: trimmed.yellowOffsetRight }
                : {}),
            });
          } else {
            // Cross-chunk approach fallback: synthesize geometry from NodeApproach so chunk-boundary intersections never miss a crosswalk or corner sidewalk
            const dLen = Math.hypot(app.dir_xz[0], app.dir_xz[1]) || 1;
            const outDir = new THREE.Vector2(app.dir_xz[0] / dLen, app.dir_xz[1] / dLen);
            const setback = plan.setbackByEdgeId.get(app.edge_id) ?? app.width_m * 0.5;
            const midOff =
              app.left_offset_m !== undefined && app.right_offset_m !== undefined
                ? 0.5 * (app.left_offset_m + app.right_offset_m)
                : 0;
            const cutPoint = new THREE.Vector3(
              plan.node.x + outDir.x * setback - outDir.y * midOff,
              plan.node.y,
              plan.node.z + outDir.y * setback + outDir.x * midOff,
            );
            const halfWidth =
              app.left_offset_m !== undefined && app.right_offset_m !== undefined
                ? Math.max(1.5, 0.5 * (app.right_offset_m - app.left_offset_m))
                : app.width_m * 0.5;
            const lanes = Math.max(1, app.lanes);
            const bidirectional = Boolean(app.bidirectional);
            const forwardLanes =
              app.forward_lanes !== undefined
                ? Math.max(1, app.forward_lanes)
                : bidirectional
                  ? Math.max(1, Math.floor(lanes / 2))
                  : lanes;
            const reverseLanes =
              app.reverse_lanes !== undefined
                ? Math.max(0, app.reverse_lanes)
                : bidirectional
                  ? Math.max(1, lanes - forwardLanes)
                  : 0;
            appDetails.push({
              cutPoint,
              outDir,
              halfWidth,
              lanes,
              bidirectional,
              isIncoming: Boolean(app.is_incoming),
              forwardLanes,
              reverseLanes,
              ...(app.lanes_both_ways !== undefined ? { lanesBothWays: app.lanes_both_ways } : {}),
              turnLanes: app.turn_lanes,
              crosswalkMarkings: app.crosswalk_markings ?? plan.node.crosswalk_markings ?? 'ladder',
              ...(app.yellow_offset_right !== undefined
                ? { yellowOffsetRight: app.yellow_offset_right }
                : {}),
            });
            if (
              (plan.hasSignals || plan.node.stop_sign) &&
              app.is_incoming &&
              !plan.isMedianSplit
            ) {
              this.intersectionDetails.appendStopBarQuadAtCut(
                whitePaintBuffers,
                cutPoint,
                outDir,
                halfWidth,
                bidirectional,
                forwardLanes,
                lanes,
                originOffset,
              );
            }
          }
        }

        if (appDetails.length >= 2) {
          if (plan.isMidblockCrossing) {
            if (plan.hasCrosswalk && appDetails[0]) {
              const app = appDetails[0];
              this.intersectionDetails.appendSingleApproachCrosswalk(
                whitePaintBuffers,
                app.cutPoint,
                app.outDir,
                app.halfWidth,
                originOffset,
                plan.node.y,
                app.crosswalkMarkings ?? 'ladder',
                yellowPaintBuffers,
              );
            }
          } else if (plan.layer === 0 && (plan.hasCrosswalk || plan.hasSignals || plan.node.stop_sign)) {
            this.intersectionDetails.appendSingleNodeDetails(
              [plan.node.x, plan.node.y, plan.node.z],
              appDetails,
              apronBuffers,
              whitePaintBuffers,
              concreteTopBuffers,
              concreteSideBuffers,
              signalAccumulator,
              originOffset,
              {
                hasCrosswalks: plan.hasCrosswalk,
                hasSignals: plan.hasSignals,
                hasStopOrControl: Boolean(plan.hasCrosswalk || plan.hasSignals || plan.node.stop_sign),
                yellowPaintTarget: yellowPaintBuffers,
              },
            );
          } else if (plan.hasCrosswalk) {
            for (const app of appDetails) {
              this.intersectionDetails.appendSingleApproachCrosswalk(
                whitePaintBuffers,
                app.cutPoint,
                app.outDir,
                app.halfWidth,
                originOffset,
                plan.node.y,
                app.crosswalkMarkings ?? 'ladder',
                yellowPaintBuffers,
              );
            }
          }

          if (!plan.isMidblockCrossing && appDetails.length >= 3 && plan.layer === 0) {
            if (plan.hasSignals) {
              this.intersectionDetails.appendSingleNodeLeftTurnGuideArcs(
                whitePaintBuffers,
                [plan.node.x, plan.node.y, plan.node.z],
                appDetails,
                originOffset,
              );
            }
            this.intersectionDetails.appendSingleNodeContinuityGuideLines(
              whitePaintBuffers,
              [plan.node.x, plan.node.y, plan.node.z],
              appDetails,
              originOffset,
              { hasCrosswalks: plan.hasCrosswalk },
            );
          }
        }
      }
    }

    // Build unified multi-corner divided intersection groups (e.g. Steeles & Kennedy, Steeles & Birchmount)
    for (const ig of chunk.intersection_groups ?? []) {
      this.intersectionDetails.appendIntersectionGroup(
        ig,
        apronBuffers,
        ig.layer > 0 ? apronBridgeDeckBuffers : null,
        whitePaintBuffers,
        concreteTopBuffers,
        concreteSideBuffers,
        signalAccumulator,
        originOffset,
        yellowPaintBuffers,
      );
    }

    // Build concrete curbed median islands between parallel opposite divided carriageways
    for (const island of chunk.median_islands ?? []) {
      this.intersectionDetails.appendMedianIsland(
        island,
        concreteTopBuffers,
        concreteSideBuffers,
        apronBuffers,
        originOffset,
        yellowPaintBuffers,
      );
    }

    // Highway off/on-ramp V-gore asphalt wedges and Ontario white chevron hatching
    for (const gore of chunk.highway_gores ?? []) {
      this.appendHighwayGore(gore, apronBuffers, whitePaintBuffers, originOffset);
    }

    // Continuous 3D TTC streetcar tracks, separated transit ROW trackbeds, and GO/CN heavy rail corridors
    for (const rt of chunk.rail_tracks ?? []) {
      this.appendRailTracks(
        rt,
        railSteelBuf,
        railGrooveBuf,
        railBallastBuf,
        railTieBuf,
        concreteTopBuffers,
        concreteSideBuffers,
        bridgeDeckBuffers,
        originOffset,
      );
    }

    // At-grade railway / tram level crossings with timber panels, stop bars, crossbucks & gate arms
    for (const rc of chunk.rail_crossings ?? []) {
      this.appendRailCrossings(
        rc,
        whitePaintBuffers,
        railTieBuf,
        signalAccumulator,
        gateRedBuf,
        originOffset,
      );
    }

    // Tapered concrete TTC/YRT bus pull-out bays and stop posts
    for (const bb of chunk.bus_bays ?? []) {
      this.appendBusBays(
        bb,
        concreteTopBuffers,
        concreteSideBuffers,
        whitePaintBuffers,
        signalAccumulator,
        gateRedBuf,
        originOffset,
      );
    }

    for (const bucket of buckets.values()) {
      if (bucket.buffers.positions.length === 0) {
        continue;
      }
      const material = this.getRoadMaterial(
        bucket.lanes,
        bucket.bidirectional,
        bucket.oneway,
        bucket.forwardLanes,
        bucket.reverseLanes,
        bucket.hasStreetcar,
        bucket.isBridge,
        bucket.extras,
      );
      const mesh = new THREE.Mesh(
        buffersToGeometry(bucket.buffers),
        material,
      );
      mesh.receiveShadow = true;
      mesh.castShadow = bucket.isBridge;
      group.add(mesh);
    }

    if (apronBuffers.positions.length > 0) {
      const apronMesh = new THREE.Mesh(
        buffersToGeometry(apronBuffers, 0.22),
        this.apronAsphaltMaterial,
      );
      apronMesh.receiveShadow = true;
      group.add(apronMesh);
    }

    if (railBallastBuf.positions.length > 0) {
      const ballastMesh = new THREE.Mesh(
        buffersToMeshGeometry(railBallastBuf),
        this.railBallastMaterial,
      );
      ballastMesh.receiveShadow = true;
      group.add(ballastMesh);
    }

    if (railTieBuf.positions.length > 0) {
      const tieMesh = new THREE.Mesh(
        buffersToMeshGeometry(railTieBuf),
        this.railTieMaterial,
      );
      tieMesh.receiveShadow = true;
      group.add(tieMesh);
    }

    if (railGrooveBuf.positions.length > 0) {
      const grooveMesh = new THREE.Mesh(
        buffersToMeshGeometry(railGrooveBuf),
        this.railGrooveMaterial,
      );
      grooveMesh.receiveShadow = true;
      group.add(grooveMesh);
    }

    if (railSteelBuf.positions.length > 0) {
      const railMesh = new THREE.Mesh(
        buffersToMeshGeometry(railSteelBuf),
        this.railSteelMaterial,
      );
      railMesh.receiveShadow = true;
      group.add(railMesh);
    }

    if (whitePaintBuffers.positions.length > 0) {
      const paintMesh = new THREE.Mesh(
        buffersToMeshGeometry(whitePaintBuffers),
        this.intersectionDetails.getWhitePaintMaterial(),
      );
      paintMesh.receiveShadow = true;
      group.add(paintMesh);
    }

    if (yellowPaintBuffers.positions.length > 0) {
      const yPaintMesh = new THREE.Mesh(
        buffersToMeshGeometry(yellowPaintBuffers),
        this.intersectionDetails.getYellowPaintMaterial(),
      );
      yPaintMesh.receiveShadow = true;
      group.add(yPaintMesh);
    }

    if (gateRedBuf.positions.length > 0) {
      const gateMesh = new THREE.Mesh(
        buffersToMeshGeometry(gateRedBuf),
        this.crossingGateRedMaterial,
      );
      gateMesh.castShadow = true;
      group.add(gateMesh);
    }

    if (schoolYellowBuf.positions.length > 0) {
      const schMesh = new THREE.Mesh(
        buffersToMeshGeometry(schoolYellowBuf),
        this.schoolSignYellowMaterial,
      );
      schMesh.castShadow = true;
      group.add(schMesh);
    }

    for (const [arrowKey, arrowBuf] of arrowBuckets.entries()) {
      if (arrowBuf.positions.length === 0) {
        continue;
      }
      const arrowMat = this.intersectionDetails.getOrCreateArrowMaterial(arrowKey);
      const arrowMesh = new THREE.Mesh(
        buffersToMeshGeometry(arrowBuf),
        arrowMat,
      );
      arrowMesh.receiveShadow = true;
      group.add(arrowMesh);
    }

    if (concreteTopBuffers.positions.length > 0) {
      const topMesh = new THREE.Mesh(
        buffersToMeshGeometry(concreteTopBuffers, 0.22),
        this.intersectionDetails.getConcreteTopMaterial(),
      );
      topMesh.receiveShadow = true;
      group.add(topMesh);
    }

    if (concreteSideBuffers.positions.length > 0) {
      const sideMesh = new THREE.Mesh(
        buffersToMeshGeometry(concreteSideBuffers, 0.22),
        this.intersectionDetails.getConcreteSideMaterial(),
      );
      sideMesh.castShadow = true;
      sideMesh.receiveShadow = true;
      group.add(sideMesh);
    }

    this.intersectionDetails.finalizeSignalMeshes(group, signalAccumulator);

    // Build continuous terrain ground skirt matching chunk node elevations beneath roads
    if (chunk.nodes.length > 0) {
      const terrainBuf = this.buildChunkTerrainSkirt(chunk, originOffset);
      if (terrainBuf.positions.length > 0) {
        const terrainMesh = new THREE.Mesh(
          buffersToGeometry(terrainBuf, 0.012),
          this.terrainMaterial,
        );
        terrainMesh.receiveShadow = true;
        group.add(terrainMesh);
      }
    }

    if (apronBridgeDeckBuffers.positions.length > 0) {
      appendBuffers(bridgeDeckBuffers, apronBridgeDeckBuffers);
    }

    if (bridgeDeckBuffers.positions.length > 0) {
      const deckMesh = new THREE.Mesh(
        buffersToGeometry(bridgeDeckBuffers, 0.22),
        this.concreteMaterial,
      );
      deckMesh.castShadow = true;
      deckMesh.receiveShadow = true;
      group.add(deckMesh);
    }

    const streetNamesGroup = new THREE.Group();
    streetNamesGroup.name = 'street-names';
    for (const [label, decalBuffers] of streetNameBuckets.entries()) {
      if (decalBuffers.positions.length === 0) {
        continue;
      }
      const { material } = this.getStreetNameTextureSet(label);
      const decalMesh = new THREE.Mesh(
        buffersToGeometry(decalBuffers),
        material,
      );
      decalMesh.receiveShadow = true;
      decalMesh.renderOrder = 2;
      streetNamesGroup.add(decalMesh);
    }
    group.add(streetNamesGroup);

    return group;
  }

  /**
   * Disposes all cached procedural road textures and materials.
   */
  public dispose(): void {
    for (const set of this.materialCache.values()) {
      set.map.dispose();
      set.roughnessMap.dispose();
      set.metalnessMap.dispose();
      set.material.dispose();
    }
    this.materialCache.clear();
    for (const set of this.streetNameCache.values()) {
      set.texture.dispose();
      set.material.dispose();
    }
    this.streetNameCache.clear();
    this.concreteMaterial.dispose();
    this.apronAsphaltMaterial.dispose();
    this.terrainMaterial.dispose();
    this.railSteelMaterial.dispose();
    this.railGrooveMaterial.dispose();
    this.railBallastMaterial.dispose();
    this.railTieMaterial.dispose();
    this.crossingGateRedMaterial.dispose();
    this.schoolSignYellowMaterial.dispose();
    this.realisticAsphaltTex?.map.dispose();
    this.realisticAsphaltTex?.roughnessMap.dispose();
    this.realisticConcreteTex?.map.dispose();
    this.realisticConcreteTex?.roughnessMap.dispose();
    this.realisticEarthTex?.map.dispose();
    this.realisticEarthTex?.roughnessMap.dispose();
    this.intersectionDetails.dispose();
  }

  private emitLocalBoxXZ(
    buf: DetailBuffers,
    cx: number,
    baseY: number,
    cz: number,
    halfLenAlongAxis: number,
    heightY: number,
    halfWidthPerp: number,
    axisX: number,
    axisZ: number,
  ): void {
    const an = Math.hypot(axisX, axisZ) || 1;
    const ux = axisX / an;
    const uz = axisZ / an;
    const vx = -uz;
    const vz = ux;
    const pt = (ax: number, ay: number, az: number): THREE.Vector3 =>
      new THREE.Vector3(cx + ux * ax + vx * az, baseY + ay, cz + uz * ax + vz * az);

    const b00 = pt(-halfLenAlongAxis, 0, -halfWidthPerp);
    const b10 = pt(halfLenAlongAxis, 0, -halfWidthPerp);
    const b11 = pt(halfLenAlongAxis, 0, halfWidthPerp);
    const b01 = pt(-halfLenAlongAxis, 0, halfWidthPerp);
    const t00 = pt(-halfLenAlongAxis, heightY, -halfWidthPerp);
    const t10 = pt(halfLenAlongAxis, heightY, -halfWidthPerp);
    const t11 = pt(halfLenAlongAxis, heightY, halfWidthPerp);
    const t01 = pt(-halfLenAlongAxis, heightY, halfWidthPerp);

    pushQuad(buf, t00, t01, t11, t10, WORLD_UP);
    pushQuad(buf, b01, b11, t11, t01, new THREE.Vector3(vx, 0, vz));
    pushQuad(buf, b10, b00, t00, t10, new THREE.Vector3(-vx, 0, -vz));
    pushQuad(buf, b11, b10, t10, t11, new THREE.Vector3(ux, 0, uz));
    pushQuad(buf, b00, b01, t01, t00, new THREE.Vector3(-ux, 0, -uz));
  }

  private emitFlatRibbonXZ(
    buf: DetailBuffers,
    pts: THREE.Vector3[],
    halfWidth: number,
    yLift: number,
    originOffset: THREE.Vector3,
    lateralShift = 0,
  ): void {
    const n = pts.length;
    if (n < 2) {
      return;
    }
    const baseVtx = buf.positions.length / 3;
    for (let i = 0; i < n; i++) {
      const pPrev = pts[Math.max(0, i - 1)]!;
      const pNext = pts[Math.min(n - 1, i + 1)]!;
      let dx = pNext.x - pPrev.x;
      let dz = pNext.z - pPrev.z;
      const len = Math.hypot(dx, dz) || 1;
      dx /= len;
      dz /= len;
      const rx = -dz;
      const rz = dx;
      const p = pts[i]!;
      const cx = p.x + rx * lateralShift - originOffset.x;
      const cy = p.y + yLift - originOffset.y;
      const cz = p.z + rz * lateralShift - originOffset.z;
      buf.positions.push(
        cx - rx * halfWidth,
        cy,
        cz - rz * halfWidth,
        cx + rx * halfWidth,
        cy,
        cz + rz * halfWidth,
      );
      buf.normals.push(0, 1, 0, 0, 1, 0);
      buf.uvs.push(0, 0, 1, 0);
    }
    for (let i = 0; i < n - 1; i++) {
      const b0 = baseVtx + i * 2;
      const b1 = b0 + 2;
      buf.indices.push(b0, b0 + 1, b1 + 1, b0, b1 + 1, b1);
    }
  }

  private appendProtectedBikeCurbs(
    topTarget: DetailBuffers,
    sideTarget: DetailBuffers,
    points: THREE.Vector3[],
    rights: THREE.Vector3[],
    normals: THREE.Vector3[],
    distances: number[],
    cs: EdgeCrossSectionProfile,
    uHasIntersection: boolean,
    vHasIntersection: boolean,
    originOffset: THREE.Vector3,
  ): void {
    const n = points.length;
    const totalLen = distances[n - 1] ?? 0;
    if (n < 2 || totalLen < 12.0) {
      return;
    }
    const sMin = uHasIntersection ? 4.0 : 0.6;
    const sMax = totalLen - (vHasIntersection ? 4.0 : 0.6);
    if (sMax - sMin < 4.5) {
      return;
    }

    const sides: number[] = [];
    if (cs.bikeLaneLeftType === 'track') {
      sides.push(cs.trafficLeftOffsetM - 0.14);
    }
    if (cs.bikeLaneRightType === 'track') {
      sides.push(cs.trafficRightOffsetM + 0.14);
    }

    const halfCurbW = 0.11;
    const curbH = 0.12;
    const botOff = -0.02;

    for (const lat of sides) {
      for (let i = 0; i < n - 1; i++) {
        const d0 = distances[i]!;
        const d1 = distances[i + 1]!;
        if (d1 <= sMin || d0 >= sMax) {
          continue;
        }
        const p0 = points[i]!;
        const p1 = points[i + 1]!;
        const r0 = rights[i]!;
        const r1 = rights[i + 1]!;
        const norm = normals[i]!;
        const mk = (p: THREE.Vector3, r: THREE.Vector3, lOff: number, yOff: number) =>
          new THREE.Vector3(
            p.x + r.x * lOff - originOffset.x,
            p.y + yOff - originOffset.y,
            p.z + r.z * lOff - originOffset.z,
          );
        const tl0 = mk(p0, r0, lat - halfCurbW, curbH);
        const tr0 = mk(p0, r0, lat + halfCurbW, curbH);
        const tl1 = mk(p1, r1, lat - halfCurbW, curbH);
        const tr1 = mk(p1, r1, lat + halfCurbW, curbH);
        const bl0 = mk(p0, r0, lat - halfCurbW, botOff);
        const br0 = mk(p0, r0, lat + halfCurbW, botOff);
        const bl1 = mk(p1, r1, lat - halfCurbW, botOff);
        const br1 = mk(p1, r1, lat + halfCurbW, botOff);

        pushQuad(topTarget, tl0, tr0, tr1, tl1, norm);
        pushQuad(sideTarget, tr0, br0, br1, tr1, r0);
        pushQuad(sideTarget, bl0, tl0, tl1, bl1, r0.clone().negate());
      }
    }
  }

  private appendMidblockCrosswalks(
    whiteTarget: DetailBuffers,
    yellowTarget: DetailBuffers,
    signalAcc: SignalMeshAccumulator,
    schoolYellowTarget: DetailBuffers,
    points: THREE.Vector3[],
    tangents: THREE.Vector3[],
    rights: THREE.Vector3[],
    distances: number[],
    leftOffsetM: number,
    rightOffsetM: number,
    uHasIntersection: boolean,
    vHasIntersection: boolean,
    controls: MapEdge['midblock_controls'],
    originOffset: THREE.Vector3,
  ): void {
    const totalLen = distances[distances.length - 1] ?? 0;
    if (points.length < 2 || totalLen < 12.0) {
      return;
    }

    for (const ctrl of controls) {
      const mStyle = ctrl.markings ?? 'ladder';
      if (mStyle === 'none') {
        continue;
      }
      if (ctrl.type !== 'crossing' && !ctrl.has_signals) {
        continue;
      }

      const cx = ctrl.position[0];
      const cz = ctrl.position[2];
      let bestS = -1;
      let bestD2 = 16.0;
      let bestPt = points[0]!;
      let bestTan = tangents[0]!;
      let bestRight = rights[0]!;

      for (let i = 0; i < points.length - 1; i++) {
        const a = points[i]!;
        const b = points[i + 1]!;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const lsq = dx * dx + dz * dz;
        if (lsq <= 1e-6) {
          continue;
        }
        const t = THREE.MathUtils.clamp(((cx - a.x) * dx + (cz - a.z) * dz) / lsq, 0, 1);
        const qx = a.x + dx * t;
        const qy = a.y + (b.y - a.y) * t;
        const qz = a.z + dz * t;
        const d2 = (cx - qx) ** 2 + (cz - qz) ** 2;
        if (d2 < bestD2) {
          bestD2 = d2;
          bestS = distances[i]! + (distances[i + 1]! - distances[i]!) * t;
          bestPt = new THREE.Vector3(qx, qy, qz);
          bestTan = tangents[i]!;
          bestRight = rights[i]!;
        }
      }

      if (bestS < 0) {
        continue;
      }
      if ((uHasIntersection && bestS < 8.5) || (vHasIntersection && totalLen - bestS < 8.5)) {
        continue;
      }

      const ox = bestPt.x - originOffset.x;
      const oy = bestPt.y - originOffset.y;
      const oz = bestPt.z - originOffset.z;
      const mk = (along: number, lat: number, yLift = 0.024) =>
        new THREE.Vector3(
          ox + bestTan.x * along + bestRight.x * lat,
          oy + yLift,
          oz + bestTan.z * along + bestRight.z * lat,
        );

      const spanL = leftOffsetM + 0.16;
      const spanR = rightOffsetM - 0.16;
      if (spanR - spanL < 2.2) {
        continue;
      }

      if (mStyle === 'lines') {
        for (const barAlong of [-1.4, 1.4]) {
          pushQuad(
            whiteTarget,
            mk(barAlong - 0.11, spanL),
            mk(barAlong - 0.11, spanR),
            mk(barAlong + 0.11, spanR),
            mk(barAlong + 0.11, spanL),
            WORLD_UP,
          );
        }
      } else {
        const isSchool = mStyle === 'school_ladder';
        const span = spanR - spanL;
        const count = Math.max(3, Math.floor(span / 1.1));
        const pitch = span / count;
        const halfBar = Math.min(0.25, pitch * 0.31);
        for (let i = 0; i < count; i++) {
          const latMid = spanL + (i + 0.5) * pitch;
          pushQuad(
            whiteTarget,
            mk(-1.35, latMid - halfBar),
            mk(-1.35, latMid + halfBar),
            mk(1.35, latMid + halfBar),
            mk(1.35, latMid - halfBar),
            WORLD_UP,
          );
        }
        if (isSchool) {
          for (const railAlong of [-1.45, 1.45]) {
            pushQuad(
              yellowTarget,
              mk(railAlong - 0.1, spanL),
              mk(railAlong - 0.1, spanR),
              mk(railAlong + 0.1, spanR),
              mk(railAlong + 0.1, spanL),
              WORLD_UP,
            );
          }
        }
      }

      // Twin advance white stop bars on both directions
      for (const stopAlong of [-4.2, 4.2]) {
        pushQuad(
          whiteTarget,
          mk(stopAlong - 0.25, spanL, 0.022),
          mk(stopAlong - 0.25, spanR, 0.022),
          mk(stopAlong + 0.25, spanR, 0.022),
          mk(stopAlong + 0.25, spanL, 0.022),
          WORLD_UP,
        );
      }

      // Pedestrian Crossover (PXO) overhead yellow beacon poles at curb sides
      if (ctrl.has_signals) {
        for (const curbLat of [leftOffsetM - 0.85, rightOffsetM + 0.85]) {
          const bx = ox + bestRight.x * curbLat;
          const bz = oz + bestRight.z * curbLat;
          this.emitLocalBoxXZ(signalAcc.poles, bx, oy, bz, 0.07, 4.4, 0.07, 1, 0);
          this.emitLocalBoxXZ(
            schoolYellowTarget,
            bx,
            oy + 3.8,
            bz,
            0.35,
            0.35,
            0.05,
            bestRight.x,
            bestRight.z,
          );
        }
      }
    }
  }

  private appendSchoolZoneSignage(
    signalAcc: SignalMeshAccumulator,
    schoolYellowTarget: DetailBuffers,
    points: THREE.Vector3[],
    tangents: THREE.Vector3[],
    rights: THREE.Vector3[],
    distances: number[],
    leftOffsetM: number,
    rightOffsetM: number,
    bidirectional: boolean,
    originOffset: THREE.Vector3,
  ): void {
    const totalLen = distances[distances.length - 1] ?? 0;
    const midS = totalLen * 0.5;
    let idx = 0;
    for (let i = 0; i < distances.length - 1; i++) {
      if (distances[i + 1]! >= midS) {
        idx = i;
        break;
      }
    }
    const p = points[idx]!;
    const r = rights[idx]!;
    const t = tangents[idx]!;
    const px = p.x - originOffset.x;
    const py = p.y - originOffset.y;
    const pz = p.z - originOffset.z;

    const placements: Array<{ lat: number }> = [{ lat: rightOffsetM + 0.9 }];
    if (bidirectional) {
      placements.push({ lat: leftOffsetM - 0.9 });
    }
    for (const pl of placements) {
      const sx = px + r.x * pl.lat;
      const sz = pz + r.z * pl.lat;
      this.emitLocalBoxXZ(signalAcc.poles, sx, py, sz, 0.06, 3.1, 0.06, 1, 0);
      this.emitLocalBoxXZ(schoolYellowTarget, sx, py + 2.35, sz, 0.36, 0.65, 0.04, t.x, t.z);
    }
  }

  private appendHighwayGore(
    gore: HighwayGore,
    apronTarget: DetailBuffers,
    whitePaintTarget: DetailBuffers,
    originOffset: THREE.Vector3,
  ): void {
    const n = Math.min(gore.left_edge.length, gore.right_edge.length);
    if (n < 2) {
      return;
    }
    const lPts = gore.left_edge.slice(0, n).map((p) => new THREE.Vector3(p[0], p[1], p[2]));
    const rPts = gore.right_edge.slice(0, n).map((p) => new THREE.Vector3(p[0], p[1], p[2]));

    // 1. Dark asphalt V-wedge fill
    for (let i = 0; i < n - 1; i++) {
      const a0 = lPts[i]!.clone().sub(originOffset);
      const b0 = rPts[i]!.clone().sub(originOffset);
      const a1 = lPts[i + 1]!.clone().sub(originOffset);
      const b1 = rPts[i + 1]!.clone().sub(originOffset);
      a0.y -= 0.002;
      b0.y -= 0.002;
      a1.y -= 0.002;
      b1.y -= 0.002;
      const crossY = (b0.z - a0.z) * (a1.x - a0.x) - (b0.x - a0.x) * (a1.z - a0.z);
      if (crossY >= 0) {
        pushQuad(apronTarget, a0, b0, b1, a1, WORLD_UP);
      } else {
        pushQuad(apronTarget, a0, a1, b1, b0, WORLD_UP);
      }
    }

    // 2. Crisp white V boundary edge lines
    this.emitFlatRibbonXZ(whitePaintTarget, lPts, 0.1, 0.017, originOffset);
    this.emitFlatRibbonXZ(whitePaintTarget, rPts, 0.1, 0.017, originOffset);

    // 3. Ontario highway gore V-chevrons pointing against oncoming nose direction
    const centers: THREE.Vector3[] = [];
    const cumDists: number[] = [0];
    for (let i = 0; i < n; i++) {
      const m = new THREE.Vector3().lerpVectors(lPts[i]!, rPts[i]!, 0.5);
      centers.push(m);
      if (i > 0) {
        cumDists.push(cumDists[i - 1]! + centers[i - 1]!.distanceTo(m));
      }
    }
    const maxLen = cumDists[n - 1] ?? 0;
    const sampleArr = (arr: THREE.Vector3[], sTarget: number): THREE.Vector3 => {
      const s = THREE.MathUtils.clamp(sTarget, 0, maxLen);
      for (let i = 0; i < n - 1; i++) {
        const d0 = cumDists[i]!;
        const d1 = cumDists[i + 1]!;
        if (s <= d1 || i === n - 2) {
          const span = d1 - d0;
          const a = span > 1e-5 ? THREE.MathUtils.clamp((s - d0) / span, 0, 1) : 0;
          return new THREE.Vector3().lerpVectors(arr[i]!, arr[i + 1]!, a);
        }
      }
      return arr[n - 1]!.clone();
    };

    const isMerge = gore.mode === 'merge';
    for (let d = 2.0; d <= maxLen - 1.2; d += 3.0) {
      const pL = sampleArr(lPts, d);
      const pR = sampleArr(rPts, d);
      const w = pL.distanceTo(pR);
      if (w < 0.75) {
        continue;
      }
      const pC = sampleArr(centers, d);
      const wingDist = isMerge
        ? Math.max(0.2, d - Math.min(2.4, w * 0.55))
        : Math.min(maxLen - 0.2, d + Math.min(2.4, w * 0.55));
      const pLTip = sampleArr(lPts, wingDist);
      const pRTip = sampleArr(rPts, wingDist);
      const barL = new THREE.Vector3().lerpVectors(pC, pLTip, 0.88);
      const barR = new THREE.Vector3().lerpVectors(pC, pRTip, 0.88);
      if (pC.distanceTo(barL) > 0.25) {
        this.emitFlatRibbonXZ(whitePaintTarget, [pC, barL], 0.11, 0.017, originOffset);
      }
      if (pC.distanceTo(barR) > 0.25) {
        this.emitFlatRibbonXZ(whitePaintTarget, [pC, barR], 0.11, 0.017, originOffset);
      }
    }
  }

  private appendRailTracks(
    rt: RailTrack,
    railSteelTarget: DetailBuffers,
    railGrooveTarget: DetailBuffers,
    railBallastTarget: DetailBuffers,
    railTieTarget: DetailBuffers,
    concreteTopTarget: DetailBuffers,
    concreteSideTarget: DetailBuffers,
    bridgeDeckTarget: RibbonBuffers,
    originOffset: THREE.Vector3,
  ): void {
    const pts = this.cleanPolyline(rt.geometry);
    if (pts.length < 2) {
      return;
    }
    const isTramOrLrt = rt.railway_type === 'tram' || rt.railway_type === 'light_rail';
    const halfGauge = (isTramOrLrt ? TTC_TRACK_GAUGE_METERS : STD_RAIL_GAUGE_METERS) * 0.5;

    if (isTramOrLrt) {
      const railLift = rt.embedded_in_road ? 0.028 : 0.065;
      const grooveLift = rt.embedded_in_road ? 0.024 : 0.060;
      if (!rt.embedded_in_road) {
        // Dedicated concrete TTC streetcar/LRT right-of-way (Spadina, St. Clair, Queens Quay, Eglinton)
        this.emitFlatRibbonXZ(concreteTopTarget, pts, 1.32, 0.045, originOffset);
        this.emitFlatRibbonXZ(concreteSideTarget, pts, 1.38, -0.02, originOffset);
      }
      for (const side of [-1, 1]) {
        this.emitFlatRibbonXZ(railGrooveTarget, pts, 0.055, grooveLift, originOffset, side * (halfGauge - 0.055));
        this.emitFlatRibbonXZ(railSteelTarget, pts, 0.048, railLift, originOffset, side * halfGauge);
      }
      return;
    }

    // Heavy rail (GO Transit / CN / CP / UP Express): ballast bed + crossties + steel rails + bridge deck
    this.emitFlatRibbonXZ(railBallastTarget, pts, 1.9, 0.03, originOffset);
    for (const side of [-1, 1]) {
      this.emitFlatRibbonXZ(railSteelTarget, pts, 0.055, 0.145, originOffset, side * halfGauge);
    }

    let accum = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dz = b.z - a.z;
      const segLen = Math.hypot(dx, dz);
      if (segLen < 0.3) {
        continue;
      }
      const tx = dx / segLen;
      const tz = dz / segLen;
      let s = accum === 0 ? 0.25 : 0.95 - (accum % 0.95);
      while (s < segLen) {
        const frac = s / segLen;
        const px = a.x + dx * frac - originOffset.x;
        const py = a.y + dy * frac - originOffset.y;
        const pz = a.z + dz * frac - originOffset.z;
        this.emitLocalBoxXZ(railTieTarget, px, py + 0.02, pz, 0.11, 0.075, 1.25, tx, tz);
        s += 0.95;
      }
      accum += segLen;
    }

    if (rt.bridge) {
      const deck = this.createBridgeDeckBuffers(pts, 3.6, false, false, originOffset);
      appendBuffers(bridgeDeckTarget, deck);
    }
  }

  private appendRailCrossings(
    rc: RailCrossing,
    whitePaintTarget: DetailBuffers,
    railTieTarget: DetailBuffers,
    signalAcc: SignalMeshAccumulator,
    gateRedTarget: DetailBuffers,
    originOffset: THREE.Vector3,
  ): void {
    // Only stamp level-crossing pads, advance stop bars & gates for heavy railways (never downtown tram_level_crossing)
    if (rc.crossing_type !== 'rail') {
      return;
    }
    const cx = rc.position[0] - originOffset.x;
    const cy = rc.position[1] - originOffset.y;
    const cz = rc.position[2] - originOffset.z;
    const rLen = Math.hypot(rc.road_dir_xz[0], rc.road_dir_xz[1]) || 1;
    const rdx = rc.road_dir_xz[0] / rLen;
    const rdz = rc.road_dir_xz[1] / rLen;
    const rrX = -rdz;
    const rrZ = rdx;

    const rwHalf = Math.max(2.6, rc.road_width_m * 0.5);
    const tLen = Math.hypot(rc.rail_dir_xz[0], rc.rail_dir_xz[1]) || 1;
    const tx = rc.rail_dir_xz[0] / tLen;
    const tz = rc.rail_dir_xz[1] / tLen;

    // Timber/rubber level crossing planks aligned with tracks across road width
    if (rc.crossing_type === 'rail') {
      this.emitLocalBoxXZ(
        railTieTarget,
        cx,
        cy + 0.005,
        cz,
        rwHalf + 0.5,
        0.025,
        1.45,
        tx,
        tz,
      );
    }

    // Approaching-side white stop bars 5.0 m upstream of tracks on right-hand lanes
    for (const dirSign of [-1, 1]) {
      const latMid = -dirSign * (rwHalf * 0.5);
      const bx = cx + rdx * (dirSign * 5.0) + rrX * latMid;
      const bz = cz + rdz * (dirSign * 5.0) + rrZ * latMid;
      this.emitLocalBoxXZ(whitePaintTarget, bx, cy + 0.01, bz, 0.25, 0.018, rwHalf * 0.47, rdx, rdz);
    }

    // Crossing gates, masts, crossbuck arms & red/white barrier booms at heavy rail crossings
    if (rc.has_gates) {
      for (const dirSign of [-1, 1]) {
        const curbDist = rwHalf + 1.15;
        const gx = cx + rdx * (dirSign * 3.4) + rrX * (-dirSign * curbDist);
        const gz = cz + rdz * (dirSign * 3.4) + rrZ * (-dirSign * curbDist);
        // Steel crossing mast
        this.emitLocalBoxXZ(signalAcc.poles, gx, cy, gz, 0.1, 4.1, 0.1, 1, 0);
        // Flasher housing
        this.emitLocalBoxXZ(signalAcc.housings, gx, cy + 2.3, gz, 0.18, 0.3, 0.42, rdx, rdz);
        // White X crossbuck blades
        this.emitLocalBoxXZ(whitePaintTarget, gx, cy + 3.45, gz, 0.04, 0.22, 0.68, rdx, rdz);
        // Horizontal red/white striped gate boom extending inward across approaching lane
        const inX = dirSign * rrX;
        const inZ = dirSign * rrZ;
        const armHalf = Math.min(rwHalf * 0.48, 2.8);
        const ax = gx + inX * (armHalf + 0.25);
        const az = gz + inZ * (armHalf + 0.25);
        this.emitLocalBoxXZ(gateRedTarget, ax, cy + 1.15, az, armHalf, 0.09, 0.04, inX, inZ);
        this.emitLocalBoxXZ(whitePaintTarget, ax + inX * 0.5, cy + 1.16, az + inZ * 0.5, armHalf * 0.42, 0.1, 0.045, inX, inZ);
      }
    }
  }

  private appendBusBays(
    bb: BusBay,
    concreteTopTarget: DetailBuffers,
    concreteSideTarget: DetailBuffers,
    whitePaintTarget: DetailBuffers,
    signalAcc: SignalMeshAccumulator,
    gateRedTarget: DetailBuffers,
    originOffset: THREE.Vector3,
  ): void {
    const cx = bb.position[0] - originOffset.x;
    const cy = bb.position[1] - originOffset.y;
    const cz = bb.position[2] - originOffset.z;
    const dLen = Math.hypot(bb.dir_xz[0], bb.dir_xz[1]) || 1;
    const dx = bb.dir_xz[0] / dLen;
    const dz = bb.dir_xz[1] / dLen;
    const oLen = Math.hypot(bb.outward_xz[0], bb.outward_xz[1]) || 1;
    const ox = bb.outward_xz[0] / oLen;
    const oz = bb.outward_xz[1] / oLen;

    const halfL = bb.length_m * 0.5;
    const halfFlat = Math.max(3.5, halfL - 3.6);
    const pocketD = bb.width_m;
    const mk = (along: number, outDist: number, yOff = 0.015) =>
      new THREE.Vector3(
        cx + dx * along + ox * outDist,
        cy + yOff,
        cz + dz * along + oz * outDist,
      );

    // Tapered concrete transit pull-out apron & rear curb
    const pIn0 = mk(-halfL, 0);
    const pIn1 = mk(-halfFlat, 0);
    const pIn2 = mk(halfFlat, 0);
    const pIn3 = mk(halfL, 0);
    const pOut1 = mk(-halfFlat, pocketD);
    const pOut2 = mk(halfFlat, pocketD);
    const mkFix = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, target: DetailBuffers) => {
      const wY = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
      if (wY >= 0) {
        pushQuad(target, a, b, c, d, WORLD_UP);
      } else {
        pushQuad(target, a, d, c, b, WORLD_UP);
      }
    };
    mkFix(pIn1, pOut1, pOut2, pIn2, concreteTopTarget);
    mkFix(pIn0, pIn1, pOut1, pIn0, concreteTopTarget);
    mkFix(pIn2, pIn3, pIn3, pOut2, concreteTopTarget);
    this.emitLocalBoxXZ(
      concreteSideTarget,
      cx + ox * (pocketD + 0.12),
      cy - 0.02,
      cz + oz * (pocketD + 0.12),
      halfFlat,
      0.16,
      0.12,
      dx,
      dz,
    );

    // Dashed white edge opening line along main travel edge
    for (let s = -halfL + 1.0; s <= halfL - 1.5; s += 3.0) {
      const qx = cx + dx * s;
      const qz = cz + dz * s;
      this.emitLocalBoxXZ(whitePaintTarget, qx, cy + 0.01, qz, 0.85, 0.015, 0.08, dx, dz);
    }

    // TTC/YRT bus stop pole + red marker plate
    const px = cx + ox * (pocketD + 0.6);
    const pz = cz + oz * (pocketD + 0.6);
    this.emitLocalBoxXZ(signalAcc.poles, px, cy, pz, 0.05, 2.8, 0.05, 1, 0);
    this.emitLocalBoxXZ(gateRedTarget, px, cy + 2.35, pz, 0.04, 0.42, 0.16, dx, dz);
  }

  private resolveEdgeStreetName(edge: MapEdge): string | null {
    const raw =
      typeof edge.street_name === 'string' && edge.street_name.trim().length > 0
        ? edge.street_name.trim()
        : normalizeEdgeName(edge.name).trim();
    return raw.length > 0 ? raw : null;
  }

  private getStreetNameTextureSet(streetName: string): StreetNameTextureSet {
    const existing = this.streetNameCache.get(streetName);
    if (existing) {
      return existing;
    }

    const canvasHeight = 192;
    const font =
      '900 118px "Arial Narrow", "Roboto Condensed", "Segoe UI", Arial, sans-serif';
    const measureCanvas = document.createElement('canvas');
    const mCtx = measureCanvas.getContext('2d')!;
    mCtx.font = font;
    const measuredWidth = Math.ceil(mCtx.measureText(streetName).width);
    const padX = 24;
    const canvasWidth = Math.min(2048, Math.max(128, measuredWidth + padX * 2));

    const canvas = document.createElement('canvas');
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Scale horizontally only if a very long composite name exceeds 2048px
    const maxUsableWidth = canvasWidth - padX * 2;
    const scaleX = measuredWidth > maxUsableWidth ? maxUsableWidth / measuredWidth : 1;

    ctx.save();
    ctx.translate(canvasWidth * 0.5, canvasHeight * 0.52);
    ctx.scale(scaleX, 1);

    // Recessed engraved asphalt groove / dark bevel shadow
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(5, 8, 12, 0.96)';
    ctx.lineWidth = 18;
    ctx.strokeText(streetName, 2, 5);

    // Subtle upper-lip inner shadow
    ctx.fillStyle = 'rgba(6, 9, 13, 0.9)';
    ctx.fillText(streetName, 2, 5);

    // Warm off-white stenciled road paint fill
    ctx.fillStyle = '#f5f1e6';
    ctx.fillText(streetName, 0, 0);

    // Subtle specular top highlight for engraved contrast
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.fillText(streetName, -0.5, -1.5);

    ctx.restore();

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.anisotropy = 8;
    texture.needsUpdate = true;

    const material = new THREE.MeshStandardMaterial({
      map: texture,
      transparent: true,
      alphaTest: 0.08,
      depthWrite: false,
      roughness: 0.68,
      metalness: 0.05,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });

    const aspect = canvasWidth / canvasHeight;
    const set: StreetNameTextureSet = { texture, material, aspect };
    this.streetNameCache.set(streetName, set);
    return set;
  }

  private sampleFrameAtDistance(
    points: THREE.Vector3[],
    rights: THREE.Vector3[],
    normals: THREE.Vector3[],
    tangents: THREE.Vector3[],
    distances: number[],
    targetDist: number,
  ): {
    point: THREE.Vector3;
    right: THREE.Vector3;
    normal: THREE.Vector3;
    tangent: THREE.Vector3;
  } {
    const n = points.length;
    if (targetDist <= 0 || n < 2) {
      return {
        point: points[0]!.clone(),
        right: rights[0]!.clone(),
        normal: normals[0]!.clone(),
        tangent: tangents[0]!.clone(),
      };
    }
    const total = distances[n - 1] ?? 0;
    if (targetDist >= total) {
      return {
        point: points[n - 1]!.clone(),
        right: rights[n - 1]!.clone(),
        normal: normals[n - 1]!.clone(),
        tangent: tangents[n - 1]!.clone(),
      };
    }
    for (let i = 0; i < n - 1; i++) {
      const d0 = distances[i]!;
      const d1 = distances[i + 1]!;
      if (targetDist <= d1) {
        const seg = d1 - d0;
        const alpha = seg > 1e-6 ? (targetDist - d0) / seg : 0;
        const point = new THREE.Vector3().lerpVectors(
          points[i]!,
          points[i + 1]!,
          alpha,
        );
        const right = new THREE.Vector3()
          .lerpVectors(rights[i]!, rights[i + 1]!, alpha)
          .normalize();
        const normal = new THREE.Vector3()
          .lerpVectors(normals[i]!, normals[i + 1]!, alpha)
          .normalize();
        const tangent = new THREE.Vector3()
          .lerpVectors(tangents[i]!, tangents[i + 1]!, alpha)
          .normalize();
        return { point, right, normal, tangent };
      }
    }
    return {
      point: points[n - 1]!.clone(),
      right: rights[n - 1]!.clone(),
      normal: normals[n - 1]!.clone(),
      tangent: tangents[n - 1]!.clone(),
    };
  }

  private appendStreetNameDecals(
    buckets: Map<string, RibbonBuffers>,
    streetName: string,
    points: THREE.Vector3[],
    lanes: number,
    roadWidth: number,
    bidirectional: boolean,
    forwardLanes: number,
    reverseLanes: number,
    hasStreetcar: boolean,
    allowBank: boolean,
    originOffset: THREE.Vector3,
    extras?: { lanesBothWays?: number; trafficLeftOffsetM?: number },
  ): void {
    const { tangents, rights, normals, distances } =
      this.computeFrameAlongPolyline(points, allowBank);
    const totalLen = distances[distances.length - 1] ?? 0;
    if (totalLen < STREET_NAME_MIN_EDGE_LENGTH_METERS) {
      return;
    }

    const { aspect } = this.getStreetNameTextureSet(streetName);
    const lanesBothWays = extras?.lanesBothWays ?? 0;
    const effectiveLaneWidth = LANE_WIDTH_METERS;
    const trafficLeftOffsetM = extras?.trafficLeftOffsetM ?? -roadWidth * 0.5;
    const fwdStart = reverseLanes + lanesBothWays;

    // Pick a clean travel lane centered away from double-yellow/TWLTL centerlines & streetcar tracks
    let targetLaneIndex: number;
    if (bidirectional) {
      if (forwardLanes >= 2 && hasStreetcar) {
        // Curb-side forward lane avoids streetcar rails in inner lane
        targetLaneIndex = Math.min(lanes - 1, fwdStart + forwardLanes - 1);
      } else {
        targetLaneIndex = Math.min(
          lanes - 1,
          fwdStart + Math.floor(forwardLanes * 0.5),
        );
      }
    } else if (hasStreetcar && lanes >= 2) {
      targetLaneIndex = 1;
    } else {
      targetLaneIndex = Math.floor(lanes * 0.5);
    }

    const lateralCenter =
      trafficLeftOffsetM + (targetLaneIndex + 0.5) * effectiveLaneWidth;
    const maxHeightInLane =
      !bidirectional && lanes >= 3 && !hasStreetcar
        ? Math.min(effectiveLaneWidth * 0.9, roadWidth * 0.24)
        : Math.min(effectiveLaneWidth * 0.78, Math.max(1.4, roadWidth * 0.2));

    const endMargin = Math.min(12.0, totalLen * 0.16);
    const usableLen = totalLen - endMargin * 2;
    if (usableLen < 6.0) {
      return;
    }

    let decalHeight = maxHeightInLane;
    let decalLength = decalHeight * aspect;
    const maxDecalLength = Math.min(24.0, usableLen * 0.78);
    if (decalLength > maxDecalLength) {
      decalLength = maxDecalLength;
      decalHeight = decalLength / aspect;
    }
    if (decalLength < 2.8 || decalHeight < 0.85) {
      return;
    }

    const stations: number[] = [];
    if (totalLen < 90.0) {
      stations.push(totalLen * 0.5);
    } else {
      const startMargin = Math.max(endMargin + decalLength * 0.5, 20.0);
      const endLimit = totalLen - startMargin;
      if (endLimit <= startMargin) {
        stations.push(totalLen * 0.5);
      } else {
        for (
          let s = startMargin;
          s <= endLimit + 1e-3;
          s += STREET_NAME_REPEAT_INTERVAL_METERS
        ) {
          stations.push(s);
        }
      }
    }

    let target = buckets.get(streetName);
    if (!target) {
      target = createEmptyBuffers();
      buckets.set(streetName, target);
    }

    const halfDecalH = decalHeight * 0.5;
    const halfDecalL = decalLength * 0.5;
    const subSteps = 4;

    for (const centerS of stations) {
      const midFrame = this.sampleFrameAtDistance(
        points,
        rights,
        normals,
        tangents,
        distances,
        centerS,
      );
      // Keep letter tops consistently biased North (-Z) / North-East across Toronto's tilted grid
      // so N-S avenues (Don Mills Rd, Kipling Ave, Warden Ave) remain upright without 45 deg flips.
      const flipUpright =
        Math.abs(midFrame.tangent.x) > 0.06
          ? midFrame.tangent.x < 0
          : midFrame.tangent.z > 0;

      const baseVertex = target.positions.length / 3;
      for (let step = 0; step <= subSteps; step++) {
        const uFrac = step / subSteps;
        const s = centerS - halfDecalL + uFrac * decalLength;
        const frame = this.sampleFrameAtDistance(
          points,
          rights,
          normals,
          tangents,
          distances,
          s,
        );

        const cx =
          frame.point.x +
          frame.right.x * lateralCenter +
          frame.normal.x * STREET_NAME_ELEVATION_OFFSET_METERS -
          originOffset.x;
        const cy =
          frame.point.y +
          frame.right.y * lateralCenter +
          frame.normal.y * STREET_NAME_ELEVATION_OFFSET_METERS -
          originOffset.y;
        const cz =
          frame.point.z +
          frame.right.z * lateralCenter +
          frame.normal.z * STREET_NAME_ELEVATION_OFFSET_METERS -
          originOffset.z;

        const topX = cx - frame.right.x * halfDecalH;
        const topY = cy - frame.right.y * halfDecalH;
        const topZ = cz - frame.right.z * halfDecalH;

        const botX = cx + frame.right.x * halfDecalH;
        const botY = cy + frame.right.y * halfDecalH;
        const botZ = cz + frame.right.z * halfDecalH;

        target.positions.push(topX, topY, topZ, botX, botY, botZ);
        target.normals.push(
          frame.normal.x,
          frame.normal.y,
          frame.normal.z,
          frame.normal.x,
          frame.normal.y,
          frame.normal.z,
        );

        const texU = flipUpright ? 1 - uFrac : uFrac;
        const texVTop = flipUpright ? 0 : 1;
        const texVBot = flipUpright ? 1 : 0;
        target.uvs.push(texU, texVTop, texU, texVBot);
      }

      for (let step = 0; step < subSteps; step++) {
        const b0 = baseVertex + step * 2;
        const b1 = baseVertex + (step + 1) * 2;
        target.indices.push(b0, b0 + 1, b1 + 1);
        target.indices.push(b0, b1 + 1, b1);
      }
    }
  }

  private resolveEdgeCrossSection(edge: MapEdge): EdgeCrossSectionProfile {
    const hw = normalizeHighwayType(edge.highway);
    const roadClass = edge.road_class ? normalizeHighwayType(edge.road_class) : hw;
    const isHighwayOrRamp =
      roadClass === 'motorway' ||
      roadClass === 'motorway_link' ||
      roadClass === 'trunk' ||
      roadClass === 'trunk_link';
    const oneway = Boolean(edge.is_oneway ?? edge.oneway);
    const bidirectional =
      !oneway && (edge.bidirectional !== undefined ? Boolean(edge.bidirectional) : true);
    let lanesTotal = Math.max(1, edge.lanes_total ?? edge.lanes ?? 2);
    let lanesBothWays = 0;
    let lanesReversible = 0;
    let lanesForward = lanesTotal;
    let lanesBackward = 0;

    if (!oneway) {
      lanesBothWays = edge.lanes_both_ways && edge.lanes_both_ways > 0 ? 1 : 0;
      lanesReversible =
        lanesBothWays === 0 && edge.lanes_reversible && edge.lanes_reversible > 0 ? 1 : 0;
      const centerExtra = lanesBothWays + lanesReversible;
      if (lanesTotal === 1) {
        lanesForward = 1;
        lanesBackward = 1;
        lanesBothWays = 0;
        lanesReversible = 0;
      } else {
        const explicitFwd = edge.lanes_forward ?? edge.forward_lanes;
        const explicitRev = edge.lanes_backward ?? edge.reverse_lanes;
        if (explicitFwd !== undefined && explicitRev !== undefined) {
          lanesForward = Math.max(1, explicitFwd);
          lanesBackward = Math.max(1, explicitRev);
        } else if (explicitFwd !== undefined) {
          lanesForward = Math.max(1, explicitFwd);
          lanesBackward = Math.max(1, lanesTotal - centerExtra - lanesForward);
        } else if (explicitRev !== undefined) {
          lanesBackward = Math.max(1, explicitRev);
          lanesForward = Math.max(1, lanesTotal - centerExtra - lanesBackward);
        } else {
          const avail = Math.max(2, lanesTotal - centerExtra);
          lanesBackward = Math.max(1, Math.floor(avail / 2));
          lanesForward = Math.max(1, avail - lanesBackward);
        }
        lanesTotal = lanesBackward + centerExtra + lanesForward;
      }
    }

    const normBikeKind = (raw: string | undefined, legacyBool?: boolean): BikeLaneKind => {
      if (raw === 'shared' || raw === 'lane' || raw === 'track') {
        return raw;
      }
      return legacyBool ? 'lane' : 'none';
    };
    const bikeLaneLeftType = normBikeKind(edge.bike_lane_left_type, edge.bike_lane_left);
    let bikeLaneRightType = normBikeKind(edge.bike_lane_right_type, edge.bike_lane_right);
    if (bikeLaneLeftType === 'none' && bikeLaneRightType === 'none' && edge.has_bike_lane) {
      bikeLaneRightType = 'lane';
    }
    const bikeLaneLeftM =
      bikeLaneLeftType === 'lane' || bikeLaneLeftType === 'track' ? BIKE_LANE_WIDTH_METERS : 0;
    const bikeLaneRightM =
      bikeLaneRightType === 'lane' || bikeLaneRightType === 'track' ? BIKE_LANE_WIDTH_METERS : 0;
    const hasBikeLane =
      bikeLaneLeftType !== 'none' || bikeLaneRightType !== 'none' || Boolean(edge.has_bike_lane);

    const centerExtra = lanesBothWays + lanesReversible;
    const trafficWidthM = lanesTotal * LANE_WIDTH_METERS;
    // Anchor cross-section origin (offset = 0) at the yellow divider (or inner left yellow edge on oneway)
    const yellowFromLeftM = oneway
      ? 0
      : lanesTotal === 1
        ? LANE_WIDTH_METERS * 0.5
        : lanesBackward * LANE_WIDTH_METERS + (centerExtra > 0 ? LANE_WIDTH_METERS * 0.5 : 0);

    let wayLineFromLeftM = oneway ? trafficWidthM * 0.5 : yellowFromLeftM;
    const placement = typeof edge.placement === 'string' ? edge.placement.trim().toLowerCase() : null;
    if (placement) {
      const match = /^(left_of|middle_of|right_of):(\d+)$/.exec(placement);
      if (match) {
        const mode = match[1]!;
        const laneIdx = Math.max(1, Math.min(lanesTotal, Number(match[2]!)));
        if (mode === 'left_of') {
          wayLineFromLeftM = (laneIdx - 1) * LANE_WIDTH_METERS;
        } else if (mode === 'middle_of') {
          wayLineFromLeftM = (laneIdx - 0.5) * LANE_WIDTH_METERS;
        } else {
          wayLineFromLeftM = laneIdx * LANE_WIDTH_METERS;
        }
      }
    }

    const shiftRightM = typeof edge.lane_shift_right_m === 'number' ? edge.lane_shift_right_m : 0;
    const trafficLeftOffsetM = -wayLineFromLeftM + shiftRightM;
    const trafficRightOffsetM = trafficWidthM - wayLineFromLeftM + shiftRightM;
    const leftOffsetM = trafficLeftOffsetM - bikeLaneLeftM;
    const rightOffsetM = trafficRightOffsetM + bikeLaneRightM;
    const widthMeters = rightOffsetM - leftOffsetM;
    const yellowCenterOffsetM = trafficLeftOffsetM + yellowFromLeftM;
    const hasStreetcar =
      edge.has_streetcar_tracks !== undefined
        ? Boolean(edge.has_streetcar_tracks)
        : isStreetcarAvenue(edge.name);

    return {
      lanesTotal,
      lanesForward,
      lanesBackward,
      lanesBothWays,
      lanesReversible,
      bidirectional,
      oneway,
      hasStreetcar,
      hasBikeLane,
      bikeLaneLeftM,
      bikeLaneRightM,
      bikeLaneLeftType,
      bikeLaneRightType,
      busLanesForward: edge.bus_lanes_forward ?? null,
      busLanesBackward: edge.bus_lanes_backward ?? null,
      hovLanesForward: edge.hov_lanes_forward ?? null,
      changeLanesForward: edge.change_lanes_forward ?? null,
      isSchoolZone: Boolean(edge.is_school_zone),
      trafficLeftOffsetM,
      trafficRightOffsetM,
      leftOffsetM,
      rightOffsetM,
      widthMeters,
      yellowCenterOffsetM,
      isHighwayOrRamp,
      placement,
    };
  }

  private getRightPocketLanes(edge: MapEdge, cs: EdgeCrossSectionProfile): number {
    if (!cs.oneway || cs.lanesTotal < 3 || cs.bikeLaneRightM > 0 || cs.isHighwayOrRamp) {
      return 0;
    }
    if (typeof edge.right_pocket_lanes === 'number') {
      return edge.right_pocket_lanes >= 1 ? 1 : 0;
    }
    const tf = edge.turn_lanes_forward ?? edge.turn_lanes_fwd ?? null;
    if (Array.isArray(tf) && tf.length === cs.lanesTotal) {
      const last = tf[tf.length - 1];
      const prev = tf[tf.length - 2];
      if ((last === 'right' || last === 'slight_right') && prev !== 'right' && prev !== 'slight_right') {
        return 1;
      }
    }
    return 0;
  }

  private computeLegalTurnsForEdgeEndpoint(
    edge: MapEdge,
    arrivingAtV: boolean,
    rawPoints: THREE.Vector3[],
    nodeLookup: Map<number, MapNode>,
    igByCornerKey: Map<string, IntersectionGroup>,
  ): { left: boolean; through: boolean; right: boolean } {
    const destNid = arrivingAtV ? edge.v : edge.u;
    const destNode = nodeLookup.get(destNid);
    if (!destNode || rawPoints.length < 2) {
      return { left: true, through: true, right: true };
    }
    const pA = arrivingAtV ? rawPoints[rawPoints.length - 2]! : rawPoints[1]!;
    const pB = arrivingAtV ? rawPoints[rawPoints.length - 1]! : rawPoints[0]!;
    const tLen = Math.hypot(pB.x - pA.x, pB.z - pA.z) || 1;
    const tx = (pB.x - pA.x) / tLen;
    const tz = (pB.z - pA.z) / tLen;

    const ig = igByCornerKey.get(`${destNid}:${edge.layer}`);
    const layerApps = (destNode.approaches ?? []).filter(
      (a) => a.layer === edge.layer && !a.intersection_internal,
    );

    // Degree-2 midblock/crosswalk splits are validated globally in the Python pipeline
    if (!ig && layerApps.length === 2) {
      return { left: true, through: true, right: true };
    }

    const exits: Array<{ ox: number; oz: number; eid: string }> = [];
    if (ig) {
      for (const app of ig.approaches) {
        if (app.edge_id === edge.id) {
          continue;
        }
        if (app.bidirectional || !app.is_incoming) {
          exits.push({ ox: app.out_dir_xz[0], oz: app.out_dir_xz[1], eid: app.edge_id });
        }
      }
    } else {
      for (const app of layerApps) {
        if (app.edge_id === edge.id) {
          continue;
        }
        if (app.bidirectional || !app.is_incoming) {
          exits.push({ ox: app.dir_xz[0], oz: app.dir_xz[1], eid: app.edge_id });
        }
      }
    }

    if (exits.length === 0) {
      return { left: false, through: false, right: false };
    }

    const leftExits: string[] = [];
    const thruExits: string[] = [];
    const rightExits: string[] = [];
    for (const ex of exits) {
      const fwdDot = ex.ox * tx + ex.oz * tz;
      const leftDot = ex.ox * tz - ex.oz * tx;
      const ang = THREE.MathUtils.radToDeg(Math.atan2(leftDot, fwdDot));
      if (ang >= 35 && ang <= 145) {
        leftExits.push(ex.eid);
      } else if (ang >= -145 && ang <= -35) {
        rightExits.push(ex.eid);
      } else if (ang > -35 && ang < 35) {
        thruExits.push(ex.eid);
      }
    }

    let leftOk = leftExits.length > 0;
    let thruOk = thruExits.length > 0;
    let rightOk = rightExits.length > 0;

    const edgeWids = new Set(edge.osm_way_ids ?? []);
    const isUnconditional = (tr: TurnRestriction): boolean => {
      if (tr.condition || (tr.type && tr.type.includes('@'))) {
        return false;
      }
      const exc = (tr.except ?? '').toLowerCase();
      return !exc.includes('motorcar') && !exc.includes('motor_vehicle');
    };

    const relevantTrs: TurnRestriction[] = [];
    for (const tr of edge.turn_restrictions ?? []) {
      if ((tr.via_node === undefined || tr.via_node === destNid) && isUnconditional(tr)) {
        relevantTrs.push(tr);
      }
    }
    for (const tr of destNode.turn_restrictions ?? []) {
      if (!isUnconditional(tr)) {
        continue;
      }
      const matchesFromId =
        tr.from_edge_ids?.includes(edge.id) ||
        (edge.reverse_edge_id ? tr.from_edge_ids?.includes(edge.reverse_edge_id) : false);
      const matchesFromWay = (tr.from_way_ids ?? []).some((w) => edgeWids.has(w));
      if (matchesFromId || matchesFromWay) {
        relevantTrs.push(tr);
      }
    }

    for (const tr of relevantTrs) {
      const rtype = (tr.type ?? '').trim().toLowerCase();
      const toSet = new Set(tr.to_edge_ids ?? []);
      if (rtype === 'no_left_turn') {
        if (leftExits.every((eid) => toSet.has(eid))) {
          leftOk = false;
        }
      } else if (rtype === 'no_right_turn') {
        if (rightExits.every((eid) => toSet.has(eid))) {
          rightOk = false;
        }
      } else if (rtype === 'only_straight_on') {
        leftOk = false;
        rightOk = false;
      } else if (rtype === 'only_left_turn') {
        thruOk = false;
        rightOk = false;
      } else if (rtype === 'only_right_turn') {
        thruOk = false;
        leftOk = false;
      }
    }

    return { left: leftOk, through: thruOk, right: rightOk };
  }

  private computeEdgeTransitionPlans(
    chunk: ChunkData,
    intersectionPlans: Map<string, NodeIntersectionPlan>,
    excludedEdgeIds?: ReadonlySet<string>,
  ): {
    profiles: Map<string, EdgeCrossSectionProfile>;
    transitions: Map<string, EdgeTransitionPlan>;
  } {
    const profiles = new Map<string, EdgeCrossSectionProfile>();
    const transitions = new Map<string, EdgeTransitionPlan>();

    interface EndRecord {
      edge: MapEdge;
      cs: EdgeCrossSectionProfile;
      isStart: boolean;
      outDirX: number;
      outDirZ: number;
      fwdRight: THREE.Vector3;
    }
    const byNodeLayer = new Map<string, EndRecord[]>();

    for (const edge of chunk.edges) {
      if (excludedEdgeIds?.has(edge.id) || edge.intersection_internal) {
        continue;
      }
      const rawPts = this.cleanPolyline(edge.geometry);
      if (rawPts.length < 2) {
        continue;
      }
      const cs = this.resolveEdgeCrossSection(edge);
      profiles.set(edge.id, cs);
      transitions.set(edge.id, {
        startLeftM: cs.leftOffsetM,
        startRightM: cs.rightOffsetM,
        startTaperLenM: 0,
        endLeftM: cs.leftOffsetM,
        endRightM: cs.rightOffsetM,
        endTaperLenM: 0,
        uWidened: false,
        vWidened: false,
      });

      const p0 = rawPts[0]!;
      const p1 = rawPts[1]!;
      const dxU = p1.x - p0.x;
      const dzU = p1.z - p0.z;
      const lenU = Math.hypot(dxU, dzU);
      if (lenU > 1e-4) {
        const outDirX = dxU / lenU;
        const outDirZ = dzU / lenU;
        const keyU = `${edge.u}:${edge.layer}`;
        let listU = byNodeLayer.get(keyU);
        if (!listU) {
          listU = [];
          byNodeLayer.set(keyU, listU);
        }
        listU.push({
          edge,
          cs,
          isStart: true,
          outDirX,
          outDirZ,
          fwdRight: new THREE.Vector3(-outDirZ, 0, outDirX),
        });
      }

      const pLast = rawPts[rawPts.length - 1]!;
      const pPrev = rawPts[rawPts.length - 2]!;
      const dxV = pPrev.x - pLast.x;
      const dzV = pPrev.z - pLast.z;
      const lenV = Math.hypot(dxV, dzV);
      if (lenV > 1e-4) {
        const outDirX = dxV / lenV;
        const outDirZ = dzV / lenV;
        const keyV = `${edge.v}:${edge.layer}`;
        let listV = byNodeLayer.get(keyV);
        if (!listV) {
          listV = [];
          byNodeLayer.set(keyV, listV);
        }
        // Edge forward tangent at v is -outDir; right = (outDirZ, 0, -outDirX)
        listV.push({
          edge,
          cs,
          isStart: false,
          outDirX,
          outDirZ,
          fwdRight: new THREE.Vector3(outDirZ, 0, -outDirX),
        });
      }
    }

    const nodeById = new Map<number, MapNode>(chunk.nodes.map((n) => [n.id, n]));
    for (const [nodeLayerKey, ends] of byNodeLayer.entries()) {
      if (intersectionPlans.has(nodeLayerKey)) {
        continue;
      }
      if (ends.length === 1) {
        // Cross-chunk degree-2 transition: weld & taper against adjacent chunk neighbor via node.approaches
        const a = ends[0]!;
        const nid = a.isStart ? a.edge.u : a.edge.v;
        const node = nodeById.get(nid);
        const layerApps = (node?.approaches ?? []).filter(
          (app) => app.layer === a.edge.layer && !app.intersection_internal,
        );
        if (layerApps.length !== 2) {
          continue;
        }
        const otherApp = layerApps.find((app) => app.edge_id !== a.edge.id);
        if (!otherApp) {
          continue;
        }
        const outDot = a.outDirX * otherApp.dir_xz[0] + a.outDirZ * otherApp.dir_xz[1];
        if (outDot > -0.5) {
          continue;
        }
        const candRight = new THREE.Vector3(-otherApp.dir_xz[1], 0, otherApp.dir_xz[0]);
        if (candRight.dot(a.fwdRight) < 0) {
          candRight.negate();
        }
        const sharedAxis = a.fwdRight.clone().add(candRight);
        if (sharedAxis.lengthSq() > 1e-6) {
          sharedAxis.normalize();
          const planA = transitions.get(a.edge.id)!;
          if (a.isStart) {
            planA.pinnedStartRight = sharedAxis.clone();
          } else {
            planA.pinnedEndRight = sharedAxis.clone();
          }
          const otherCandRight = new THREE.Vector3(-otherApp.dir_xz[1], 0, otherApp.dir_xz[0]);
          const otherSameDir = otherCandRight.dot(a.fwdRight) >= 0;
          let otherLeft: number;
          let otherRight: number;
          if (otherApp.left_offset_m !== undefined && otherApp.right_offset_m !== undefined) {
            otherLeft = otherSameDir ? otherApp.left_offset_m : -otherApp.right_offset_m;
            otherRight = otherSameDir ? otherApp.right_offset_m : -otherApp.left_offset_m;
          } else {
            const otherShiftRaw = otherApp.lane_shift_right_m ?? 0;
            const otherShift = otherShiftRaw * (otherSameDir ? 1 : -1);
            const otherHalf = Math.max(1.75, otherApp.width_m * 0.5);
            otherLeft = -otherHalf + otherShift;
            otherRight = otherHalf + otherShift;
          }
          const aWider =
            a.cs.lanesTotal > otherApp.lanes ||
            (a.cs.lanesTotal === otherApp.lanes && a.cs.widthMeters > otherApp.width_m + 0.08);
          if (aWider) {
            const sU = intersectionPlans.get(`${a.edge.u}:${a.edge.layer}`)?.setbackByEdgeId.get(a.edge.id) ?? 0;
            const sV = intersectionPlans.get(`${a.edge.v}:${a.edge.layer}`)?.setbackByEdgeId.get(a.edge.id) ?? 0;
            const trimmedA = Math.max(0, (a.edge.length_m || 24) - sU - sV);
            if (trimmedA >= 4.5) {
              const hwH = normalizeHighwayType(a.edge.highway);
              const isHwy =
                hwH === 'motorway' || hwH === 'motorway_link' || hwH === 'trunk' || hwH === 'trunk_link';
              const tfA = a.edge.turn_lanes_forward ?? a.edge.turn_lanes_fwd ?? null;
              const rightPocketsA = this.getRightPocketLanes(a.edge, a.cs);
              const coreRightA = a.cs.rightOffsetM - rightPocketsA * LANE_WIDTH_METERS;
              const isLeftBayOpening =
                a.cs.oneway &&
                a.isStart &&
                Array.isArray(tfA) &&
                tfA.length >= 3 &&
                tfA[0] === 'left' &&
                Math.abs(otherRight - coreRightA) <= 0.35 &&
                a.cs.leftOffsetM < otherLeft - 1.0;
              const taperLen = isLeftBayOpening
                ? Math.min(26.0, trimmedA * 0.5)
                : Math.min(isHwy ? 38.0 : TAPER_LENGTH_METERS, trimmedA * 0.65);
              if (taperLen >= 3.0) {
                if (a.isStart) {
                  planA.startLeftM = otherLeft;
                  planA.startRightM =
                    isLeftBayOpening && rightPocketsA === 1 ? coreRightA : otherRight;
                  planA.startTaperLenM = taperLen;
                  if (isLeftBayOpening) {
                    planA.leftBaySmoothCurve = true;
                    planA.leftBayEntryDividerLatM = otherLeft;
                  }
                  if (a.cs.lanesTotal > otherApp.lanes) {
                    planA.vWidened = true;
                  }
                } else {
                  planA.endLeftM = otherLeft;
                  planA.endRightM = otherRight;
                  planA.endTaperLenM = taperLen;
                  if (a.cs.lanesTotal > otherApp.lanes) {
                    planA.uWidened = true;
                  }
                }
              }
            }
          }
        }
        continue;
      }
      if (ends.length !== 2) {
        continue;
      }
      const a = ends[0]!;
      const b = ends[1]!;
      const outDot = a.outDirX * b.outDirX + a.outDirZ * b.outDirZ;
      if (outDot > -0.5) {
        continue;
      }

      // Compute shared welded cross-section right axis at collinear degree-2 node
      const sameSide = a.fwdRight.dot(b.fwdRight) >= 0;
      const alignedBRight = sameSide ? b.fwdRight.clone() : b.fwdRight.clone().negate();
      const sharedAxis = a.fwdRight.clone().add(alignedBRight);
      if (sharedAxis.lengthSq() > 1e-6) {
        sharedAxis.normalize();
        const planA = transitions.get(a.edge.id)!;
        const planB = transitions.get(b.edge.id)!;
        const pinA = sharedAxis.clone();
        const pinB = sameSide ? sharedAxis.clone() : sharedAxis.clone().negate();
        if (a.isStart) {
          planA.pinnedStartRight = pinA;
        } else {
          planA.pinnedEndRight = pinA;
        }
        if (b.isStart) {
          planB.pinnedStartRight = pinB;
        } else {
          planB.pinnedEndRight = pinB;
        }

        const bLeftInA = sameSide ? b.cs.leftOffsetM : -b.cs.rightOffsetM;
        const bRightInA = sameSide ? b.cs.rightOffsetM : -b.cs.leftOffsetM;
        const maxDiff = Math.max(
          Math.abs(a.cs.leftOffsetM - bLeftInA),
          Math.abs(a.cs.rightOffsetM - bRightInA),
        );
        if (maxDiff <= 0.08) {
          continue;
        }

        const trimLen = (rec: EndRecord): number => {
          const sU = intersectionPlans.get(`${rec.edge.u}:${rec.edge.layer}`)?.setbackByEdgeId.get(rec.edge.id) ?? 0;
          const sV = intersectionPlans.get(`${rec.edge.v}:${rec.edge.layer}`)?.setbackByEdgeId.get(rec.edge.id) ?? 0;
          return Math.max(0, (rec.edge.length_m || 24) - sU - sV);
        };
        const trimmedA = trimLen(a);
        const trimmedB = trimLen(b);

        const aWider =
          a.cs.lanesTotal > b.cs.lanesTotal ||
          (a.cs.lanesTotal === b.cs.lanesTotal && a.cs.widthMeters > b.cs.widthMeters + 0.08);
        const bWider =
          b.cs.lanesTotal > a.cs.lanesTotal ||
          (b.cs.lanesTotal === a.cs.lanesTotal && b.cs.widthMeters > a.cs.widthMeters + 0.08);

        const assignTaper = (
          host: EndRecord,
          targetLeft: number,
          targetRight: number,
          hostTrimLen: number,
          fromWiderLanes: boolean,
        ) => {
          if (hostTrimLen < 4.5) {
            return;
          }
          const planH = transitions.get(host.edge.id)!;
          const hwH = normalizeHighwayType(host.edge.highway);
          const isHwy =
            hwH === 'motorway' ||
            hwH === 'motorway_link' ||
            hwH === 'trunk' ||
            hwH === 'trunk_link';
          const tf = host.edge.turn_lanes_forward ?? host.edge.turn_lanes_fwd ?? null;
          const hostRightPockets = this.getRightPocketLanes(host.edge, host.cs);
          const hostCoreRight = host.cs.rightOffsetM - hostRightPockets * LANE_WIDTH_METERS;
          const isLeftBayOpening =
            host.cs.oneway &&
            host.isStart &&
            Array.isArray(tf) &&
            tf.length >= 3 &&
            tf[0] === 'left' &&
            Math.abs(targetRight - hostCoreRight) <= 0.35 &&
            host.cs.leftOffsetM < targetLeft - 1.0;
          const maxTaper = isHwy ? 38.0 : TAPER_LENGTH_METERS;
          const taperLen = isLeftBayOpening
            ? Math.min(26.0, hostTrimLen * 0.5)
            : Math.min(maxTaper, hostTrimLen * 0.65);
          if (taperLen < 3.0) {
            return;
          }
          if (host.isStart) {
            planH.startLeftM = targetLeft;
            planH.startRightM =
              isLeftBayOpening && hostRightPockets === 1 ? hostCoreRight : targetRight;
            planH.startTaperLenM = taperLen;
            if (isLeftBayOpening) {
              planH.leftBaySmoothCurve = true;
              planH.leftBayEntryDividerLatM = targetLeft;
            }
            if (fromWiderLanes) {
              planH.vWidened = true;
            }
          } else {
            planH.endLeftM = targetLeft;
            planH.endRightM = targetRight;
            planH.endTaperLenM = taperLen;
            if (fromWiderLanes) {
              planH.uWidened = true;
            }
          }
        };

        const aLeftInB = sameSide ? a.cs.leftOffsetM : -a.cs.rightOffsetM;
        const aRightInB = sameSide ? a.cs.rightOffsetM : -a.cs.leftOffsetM;

        if (aWider) {
          // If the wider side is a tiny trimmed intersection stub while the downstream block is long,
          // place the 18m transition on the longer downstream block instead of a stub right at the crosswalk.
          if (trimmedA < 10.0 && trimmedB >= 16.0) {
            assignTaper(b, aLeftInB, aRightInB, trimmedB, false);
          } else {
            assignTaper(a, bLeftInA, bRightInA, trimmedA, a.cs.lanesTotal > b.cs.lanesTotal);
          }
        } else if (bWider) {
          if (trimmedB < 10.0 && trimmedA >= 16.0) {
            assignTaper(a, bLeftInA, bRightInA, trimmedA, false);
          } else {
            assignTaper(b, aLeftInB, aRightInB, trimmedB, b.cs.lanesTotal > a.cs.lanesTotal);
          }
        } else {
          // Equal width & lane count with differing placement: smooth half-blend
          const midLeftInA = (a.cs.leftOffsetM + bLeftInA) * 0.5;
          const midRightInA = (a.cs.rightOffsetM + bRightInA) * 0.5;
          const midLeftInB = sameSide ? midLeftInA : -midRightInA;
          const midRightInB = sameSide ? midRightInA : -midLeftInA;
          assignTaper(a, midLeftInA, midRightInA, trimmedA * 0.78, false);
          assignTaper(b, midLeftInB, midRightInB, trimmedB * 0.78, false);
        }
      }
    }

    // Support OSM placement=transition edges by interpolating cross-sections cleanly between u and v neighbors
    for (const edge of chunk.edges) {
      if (excludedEdgeIds?.has(edge.id) || edge.intersection_internal) {
        continue;
      }
      const cs = profiles.get(edge.id);
      const plan = transitions.get(edge.id);
      if (!cs || !plan || cs.placement !== 'transition') {
        continue;
      }
      const resolveNeighborOffsets = (
        nid: number,
        isStartEnd: boolean,
      ): { left: number; right: number } | null => {
        const key = `${nid}:${edge.layer}`;
        const localEnds = byNodeLayer.get(key) ?? [];
        const selfRec = localEnds.find((r) => r.edge.id === edge.id && r.isStart === isStartEnd);
        if (!selfRec) {
          return null;
        }
        const otherLocal = localEnds.find(
          (r) =>
            r.edge.id !== edge.id &&
            r.outDirX * selfRec.outDirX + r.outDirZ * selfRec.outDirZ < -0.5,
        );
        if (otherLocal) {
          const sameSide = selfRec.fwdRight.dot(otherLocal.fwdRight) >= 0;
          return {
            left: sameSide ? otherLocal.cs.leftOffsetM : -otherLocal.cs.rightOffsetM,
            right: sameSide ? otherLocal.cs.rightOffsetM : -otherLocal.cs.leftOffsetM,
          };
        }
        const node = nodeById.get(nid);
        const otherApp = (node?.approaches ?? []).find(
          (app) =>
            app.layer === edge.layer &&
            !app.intersection_internal &&
            app.edge_id !== edge.id &&
            app.dir_xz[0] * selfRec.outDirX + app.dir_xz[1] * selfRec.outDirZ < -0.5,
        );
        if (otherApp && otherApp.left_offset_m !== undefined && otherApp.right_offset_m !== undefined) {
          const candR = new THREE.Vector3(-otherApp.dir_xz[1], 0, otherApp.dir_xz[0]);
          const sameSide = candR.dot(selfRec.fwdRight) >= 0;
          return {
            left: sameSide ? otherApp.left_offset_m : -otherApp.right_offset_m,
            right: sameSide ? otherApp.right_offset_m : -otherApp.left_offset_m,
          };
        }
        return null;
      };

      const uOff = resolveNeighborOffsets(edge.u, true);
      const vOff = resolveNeighborOffsets(edge.v, false);
      if (uOff || vOff) {
        plan.startLeftM = uOff ? uOff.left : cs.leftOffsetM;
        plan.startRightM = uOff ? uOff.right : cs.rightOffsetM;
        plan.endLeftM = vOff ? vOff.left : cs.leftOffsetM;
        plan.endRightM = vOff ? vOff.right : cs.rightOffsetM;
        plan.isPlacementTransition = true;
        plan.startTaperLenM = Math.max(1.0, edge.length_m || 12.0);
      }
    }

    return { profiles, transitions };
  }

  private computeIntersectionPlans(
    chunk: ChunkData,
    clusteredCornerKeys: ReadonlySet<string>,
  ): Map<string, NodeIntersectionPlan> {
    const plans = new Map<string, NodeIntersectionPlan>();
    const freewayOrBridgeEdgeIds = new Set<string>();
    for (const edge of chunk.edges) {
      const hw = normalizeHighwayType(edge.highway);
      if (
        hw === 'motorway' ||
        hw === 'motorway_link' ||
        hw === 'trunk_link' ||
        edge.bridge ||
        edge.layer > 0
      ) {
        freewayOrBridgeEdgeIds.add(edge.id);
      }
    }

    for (const node of chunk.nodes) {
      const approaches = node.approaches ?? [];
      if (approaches.length < 2) {
        continue;
      }

      const byLayer = new Map<number, NodeApproach[]>();
      for (const app of approaches) {
        let list = byLayer.get(app.layer);
        if (!list) {
          list = [];
          byLayer.set(app.layer, list);
        }
        list.push(app);
      }

      const isMedianSplit = node.node_type === 'median_split';
      const hasSignals = Boolean(node.traffic_signal);
      const hasStop = Boolean(node.stop_sign);
      const hasControl = hasSignals || hasStop;
      const hasCrosswalk =
        !isMedianSplit &&
        Boolean(node.traffic_signal || node.stop_sign || node.has_crossing);

      for (const [layer, layerApproaches] of byLayer.entries()) {
        if (layerApproaches.length < 3 && !(layerApproaches.length >= 2 && hasControl)) {
          continue;
        }
        if (clusteredCornerKeys.has(`${node.id}:${layer}`)) {
          continue;
        }
        if (layerApproaches.length === 2) {
          const nearIg =
            Boolean(node.suppress_midblock) ||
            (chunk.intersection_groups ?? []).some((ig) => {
              if (ig.layer !== layer) {
                return false;
              }
              const dx = node.x - ig.center[0];
              const dz = node.z - ig.center[2];
              return dx * dx + dz * dz <= 30.0 * 30.0;
            });
          if (nearIg) {
            continue;
          }
        }
        // Never setback-trim elevated motorway/ramp bridge forks or cross-chunk freeway splits
        const allFreewayOrBridge = layerApproaches.every(
          (a) => freewayOrBridgeEdgeIds.has(a.edge_id) || Boolean(a.is_freeway) || Boolean(a.bridge),
        );
        const touchesUncontrolledMotorway =
          layerApproaches.some((a) => a.highway === 'motorway') &&
          !hasSignals &&
          !node.stop_sign &&
          !hasCrosswalk;
        if (
          layer > 0 ||
          (!hasSignals &&
            !node.stop_sign &&
            !hasCrosswalk &&
            !isMedianSplit &&
            allFreewayOrBridge) ||
          touchesUncontrolledMotorway
        ) {
          continue;
        }

        // Sort CCW around node center in XZ plane (+X East, -Z North)
        const sorted = [...layerApproaches].sort((a, b) => {
          const angA = Math.atan2(-a.dir_xz[1], a.dir_xz[0]);
          const angB = Math.atan2(-b.dir_xz[1], b.dir_xz[0]);
          return angA - angB;
        });

        const maxHalfWidth = sorted.reduce(
          (acc, app) => Math.max(acc, app.width_m * 0.5),
          0,
        );
        const maxSetbackClamp = Math.max(8.0, maxHalfWidth + 6.5);

        const setbackByEdgeId = new Map<string, number>();
        for (let i = 0; i < sorted.length; i++) {
          const appI = sorted[i]!;
          const hI = appI.width_m * 0.5;
          const dxI = appI.dir_xz[0];
          const dzI = appI.dir_xz[1];

          let clampedSetback: number;
          if (isMedianSplit) {
            clampedSetback = 1.8;
          } else {
            let setback = 0;
            for (let j = 0; j < sorted.length; j++) {
              if (i === j) {
                continue;
              }
              const appJ = sorted[j]!;
              const hJ = appJ.width_m * 0.5;
              const dxJ = appJ.dir_xz[0];
              const dzJ = appJ.dir_xz[1];

              const dot = dxI * dxJ + dzI * dzJ;
              const cross = Math.abs(dxI * dzJ - dzI * dxJ);

              if (cross > 0.25) {
                const d = (hJ + hI * Math.max(0, dot)) / Math.max(cross, 0.55);
                setback = Math.max(setback, d);
              } else if (dot > 0.85) {
                setback = Math.max(setback, hJ);
              }
            }

            if (setback <= 0) {
              setback = sorted.length < 3 ? 0.5 : maxHalfWidth;
            }
            const baseTrim = THREE.MathUtils.clamp(
              setback,
              0.5,
              maxSetbackClamp,
            );
            clampedSetback = baseTrim + INTERSECTION_SETBACK_EXTRA_METERS;
          }

          if (
            typeof appI.edge_length_m === 'number' &&
            appI.edge_length_m > 0
          ) {
            const maxByEdge = Math.max(0.25, (appI.edge_length_m - 1.2) * 0.45);
            clampedSetback = Math.min(clampedSetback, maxByEdge);
          }
          setbackByEdgeId.set(appI.edge_id, clampedSetback);
        }

        const isMidblockCrossing =
          !isMedianSplit &&
          sorted.length === 2 &&
          sorted[0]!.dir_xz[0] * sorted[1]!.dir_xz[0] +
            sorted[0]!.dir_xz[1] * sorted[1]!.dir_xz[1] <
            -0.75;

        plans.set(`${node.id}:${layer}`, {
          node,
          layer,
          isMedianSplit,
          isMidblockCrossing,
          hasCrosswalk,
          hasSignals,
          setbackByEdgeId,
          sortedApproaches: sorted,
        });
      }
    }

    return plans;
  }

  private appendIntersectionApron(
    apronTarget: RibbonBuffers,
    bridgeDeckTarget: RibbonBuffers | null,
    plan: NodeIntersectionPlan,
    trimmedCrossSections: Map<string, TrimmedEndpointInfo>,
    originOffset: THREE.Vector3,
  ): void {
    const { node, layer, sortedApproaches, setbackByEdgeId } = plan;
    const perimeter: THREE.Vector3[] = [];

    for (const app of sortedApproaches) {
      const trimmed = trimmedCrossSections.get(
        `${node.id}:${layer}:${app.edge_id}`,
      );
      let cutPoint: THREE.Vector3;
      let outDirX: number;
      let outDirZ: number;
      let halfWidth: number;

      if (trimmed) {
        cutPoint = trimmed.cutPoint;
        outDirX = trimmed.outwardDirXZ.x;
        outDirZ = trimmed.outwardDirXZ.y;
        halfWidth = trimmed.halfWidth;
      } else {
        const setback = setbackByEdgeId.get(app.edge_id) ?? app.width_m * 0.5;
        outDirX = app.dir_xz[0];
        outDirZ = app.dir_xz[1];
        const midOff =
          app.left_offset_m !== undefined && app.right_offset_m !== undefined
            ? 0.5 * (app.left_offset_m + app.right_offset_m)
            : 0;
        cutPoint = new THREE.Vector3(
          node.x + outDirX * setback - outDirZ * midOff,
          node.y,
          node.z + outDirZ * setback + outDirX * midOff,
        );
        halfWidth =
          app.left_offset_m !== undefined && app.right_offset_m !== undefined
            ? Math.max(1.5, 0.5 * (app.right_offset_m - app.left_offset_m))
            : app.width_m * 0.5;
      }

      // right_out = outwardDir × WORLD_UP = (-outDirZ, 0, outDirX)
      const rightX = -outDirZ;
      const rightZ = outDirX;

      // In CCW angle order around the node:
      // P_early = cutPoint + halfWidth * right_out (clockwise / smaller angle)
      // P_late  = cutPoint - halfWidth * right_out (counter-clockwise / larger angle)
      const pEarly = new THREE.Vector3(
        cutPoint.x + rightX * halfWidth - originOffset.x,
        cutPoint.y - originOffset.y,
        cutPoint.z + rightZ * halfWidth - originOffset.z,
      );
      const pLate = new THREE.Vector3(
        cutPoint.x - rightX * halfWidth - originOffset.x,
        cutPoint.y - originOffset.y,
        cutPoint.z - rightZ * halfWidth - originOffset.z,
      );
      perimeter.push(pEarly, pLate);
    }

    if (perimeter.length < 3) {
      return;
    }

      const center = new THREE.Vector3(
        node.x - originOffset.x,
        node.y - originOffset.y,
        node.z - originOffset.z,
      );

      perimeter.sort(
        (a, b) =>
          Math.atan2(-(a.z - center.z), a.x - center.x) -
          Math.atan2(-(b.z - center.z), b.x - center.x),
      );

      // Guard against inverted or crossing perimeter edges around narrow Y-junctions
      for (let i = 0; i < perimeter.length; i++) {
        const curr = perimeter[i]!;
        const next = perimeter[(i + 1) % perimeter.length]!;
        const cross =
          (curr.z - center.z) * (next.x - center.x) -
          (curr.x - center.x) * (next.z - center.z);
        if (cross <= 0.04) {
          const mx = (curr.x + next.x) * 0.5;
          const my = (curr.y + next.y) * 0.5;
          const mz = (curr.z + next.z) * 0.5;
          curr.set(mx, my, mz);
          next.set(mx, my, mz);
        }
      }

      let sumY = 0;
      for (const p of perimeter) {
        sumY += p.y;
      }
      center.y = (center.y + sumY / perimeter.length) * 0.5;

      const centerIdx = apronTarget.positions.length / 3;
      apronTarget.positions.push(center.x, center.y, center.z);
      apronTarget.normals.push(0, 1, 0);
      apronTarget.uvs.push(0.5, 0.5);

      for (const p of perimeter) {
        apronTarget.positions.push(p.x, p.y, p.z);
        apronTarget.normals.push(0, 1, 0);
        apronTarget.uvs.push(0.5, 0.5);
      }

      const count = perimeter.length;
      for (let i = 0; i < count; i++) {
        const next = (i + 1) % count;
        const vA = perimeter[i]!;
        const vB = perimeter[next]!;
        const windingY =
          (vA.z - center.z) * (vB.x - center.x) -
          (vA.x - center.x) * (vB.z - center.z);
        if (windingY > 1e-3) {
          apronTarget.indices.push(centerIdx, centerIdx + 1 + i, centerIdx + 1 + next);
        }
      }

    if (bridgeDeckTarget) {
      const botCenter = new THREE.Vector3(
        center.x,
        center.y - BRIDGE_DECK_THICKNESS_METERS,
        center.z,
      );
      const botCenterIdx = bridgeDeckTarget.positions.length / 3;
      bridgeDeckTarget.positions.push(botCenter.x, botCenter.y, botCenter.z);
      bridgeDeckTarget.normals.push(0, -1, 0);
      bridgeDeckTarget.uvs.push(0.5, 0.5);

      for (const p of perimeter) {
        bridgeDeckTarget.positions.push(
          p.x,
          p.y - BRIDGE_DECK_THICKNESS_METERS,
          p.z,
        );
        bridgeDeckTarget.normals.push(0, -1, 0);
        bridgeDeckTarget.uvs.push(0.5, 0.5);
      }

      for (let i = 0; i < count; i++) {
        const next = (i + 1) % count;
        bridgeDeckTarget.indices.push(
          botCenterIdx,
          botCenterIdx + 1 + next,
          botCenterIdx + 1 + i,
        );
      }
    }
  }

  private cleanPolyline(raw: Vec3Tuple[]): THREE.Vector3[] {
    const result: THREE.Vector3[] = [];
    for (let i = 0; i < raw.length; i++) {
      const tuple = raw[i]!;
      const pt = new THREE.Vector3(tuple[0], tuple[1], tuple[2]);
      const prev = result[result.length - 1];
      if (!prev || prev.distanceToSquared(pt) > 1e-6) {
        result.push(pt);
      }
    }
    return result;
  }

  private computePolylineLength(points: THREE.Vector3[]): number {
    let total = 0;
    for (let i = 0; i < points.length - 1; i++) {
      total += points[i]!.distanceTo(points[i + 1]!);
    }
    return total;
  }

  private trimPolylineByDistances(
    points: THREE.Vector3[],
    trimStartMeters: number,
    trimEndMeters: number,
  ): THREE.Vector3[] {
    const cumDists: number[] = [0];
    for (let i = 0; i < points.length - 1; i++) {
      cumDists.push(cumDists[i]! + points[i]!.distanceTo(points[i + 1]!));
    }
    const totalLen = cumDists[cumDists.length - 1] ?? 0;
    if (totalLen <= 1e-4) {
      return points;
    }

    const s0 = Math.max(0, Math.min(totalLen - 0.5, trimStartMeters));
    const s1 = Math.max(s0 + 0.5, totalLen - Math.max(0, trimEndMeters));

    const sampleAt = (targetS: number): THREE.Vector3 => {
      for (let i = 0; i < cumDists.length - 1; i++) {
        const d0 = cumDists[i]!;
        const d1 = cumDists[i + 1]!;
        if (targetS <= d1 || i === cumDists.length - 2) {
          const seg = d1 - d0;
          const alpha =
            seg > 1e-6 ? THREE.MathUtils.clamp((targetS - d0) / seg, 0, 1) : 0;
          return new THREE.Vector3().lerpVectors(points[i]!, points[i + 1]!, alpha);
        }
      }
      return points[points.length - 1]!.clone();
    };

    const result: THREE.Vector3[] = [sampleAt(s0)];
    for (let i = 1; i < points.length - 1; i++) {
      const d = cumDists[i]!;
      if (d > s0 + 0.1 && d < s1 - 0.1) {
        result.push(points[i]!.clone());
      }
    }
    result.push(sampleAt(s1));
    return result;
  }

  /**
   * Subdivides sharp interior bends (> ~14 degrees) with quadratic Bezier fillets
   * while preserving start and end points so trimmed ends remain flush.
   */
  private subdivideSharpCorners(points: THREE.Vector3[]): THREE.Vector3[] {
    if (points.length < 3) {
      return points;
    }

    const result: THREE.Vector3[] = [points[0]!.clone()];
    for (let i = 1; i < points.length - 1; i++) {
      const prev = points[i - 1]!;
      const curr = points[i]!;
      const next = points[i + 1]!;

      const vIn = new THREE.Vector3().subVectors(curr, prev);
      const vOut = new THREE.Vector3().subVectors(next, curr);
      const lenIn = vIn.length();
      const lenOut = vOut.length();
      if (lenIn < 1e-4 || lenOut < 1e-4) {
        continue;
      }

      const dirIn = vIn.clone().divideScalar(lenIn);
      const dirOut = vOut.clone().divideScalar(lenOut);
      const cosAngle = THREE.MathUtils.clamp(dirIn.dot(dirOut), -1, 1);

      if (cosAngle < 0.97) {
        const filletLen = Math.min(lenIn * 0.35, lenOut * 0.35, 6.0);
        if (filletLen > 0.4) {
          const pA = curr.clone().addScaledVector(dirIn, -filletLen);
          const pB = curr.clone().addScaledVector(dirOut, filletLen);
          const steps = cosAngle < 0.7 ? 5 : 3;
          for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            const omt = 1 - t;
            const pt = new THREE.Vector3(
              omt * omt * pA.x + 2 * omt * t * curr.x + t * t * pB.x,
              omt * omt * pA.y + 2 * omt * t * curr.y + t * t * pB.y,
              omt * omt * pA.z + 2 * omt * t * curr.z + t * t * pB.z,
            );
            const last = result[result.length - 1]!;
            if (last.distanceToSquared(pt) > 1e-4) {
              result.push(pt);
            }
          }
          continue;
        }
      }

      const last = result[result.length - 1]!;
      if (last.distanceToSquared(curr) > 1e-4) {
        result.push(curr.clone());
      }
    }

    const endPt = points[points.length - 1]!;
    if (result[result.length - 1]!.distanceToSquared(endPt) > 1e-6) {
      result.push(endPt.clone());
    } else {
      result[result.length - 1]!.copy(endPt);
    }
    return result;
  }

  private computeFrameAlongPolyline(
    points: THREE.Vector3[],
    allowBank: boolean,
  ): {
    tangents: THREE.Vector3[];
    rights: THREE.Vector3[];
    normals: THREE.Vector3[];
    miterScales: number[];
    distances: number[];
  } {
    const n = points.length;
    const segDirs: THREE.Vector3[] = [];
    const distances: number[] = [0];
    let accumDist = 0;

    for (let i = 0; i < n - 1; i++) {
      const dir = new THREE.Vector3().subVectors(points[i + 1]!, points[i]!);
      const len = dir.length();
      accumDist += len;
      distances.push(accumDist);
      if (len > 1e-6) {
        dir.divideScalar(len);
      } else {
        dir.set(0, 0, -1);
      }
      segDirs.push(dir);
    }

    const tangents: THREE.Vector3[] = [];
    for (let i = 0; i < n; i++) {
      if (i === 0) {
        tangents.push(segDirs[0]!.clone());
      } else if (i === n - 1) {
        tangents.push(segDirs[n - 2]!.clone());
      } else {
        const blended = new THREE.Vector3().addVectors(
          segDirs[i - 1]!,
          segDirs[i]!,
        );
        if (blended.lengthSq() > 1e-8) {
          blended.normalize();
        } else {
          blended.copy(segDirs[i]!);
        }
        tangents.push(blended);
      }
    }

    const rights: THREE.Vector3[] = [];
    const normals: THREE.Vector3[] = [];
    const miterScales: number[] = [];

    for (let i = 0; i < n; i++) {
      const tangent = tangents[i]!;
      const horizRight = new THREE.Vector3().crossVectors(tangent, WORLD_UP);
      if (horizRight.lengthSq() < 1e-8) {
        horizRight.set(1, 0, 0);
      } else {
        horizRight.normalize();
      }

      let miterScale = 1.0;
      if (i > 0 && i < n - 1) {
        const segRight = new THREE.Vector3().crossVectors(
          segDirs[i]!,
          WORLD_UP,
        );
        if (segRight.lengthSq() > 1e-8) {
          segRight.normalize();
          const cosHalf = Math.max(0.5, horizRight.dot(segRight));
          miterScale = Math.min(MAX_MITER_SCALE, 1.0 / cosHalf);
        }
      }
      miterScales.push(miterScale);

      const right = horizRight.clone();
      if (allowBank && i > 0 && i < n - 1 && accumDist > 1) {
        const prevDir = segDirs[i - 1]!;
        const nextDir = segDirs[i]!;
        const crossY = prevDir.z * nextDir.x - prevDir.x * nextDir.z;
        const progress = distances[i]! / accumDist;
        const endpointTaper = Math.sin(Math.PI * progress);
        const maxBankRad = THREE.MathUtils.degToRad(3.5);
        const bankAngle =
          THREE.MathUtils.clamp(crossY * 2.5, -1, 1) *
          maxBankRad *
          endpointTaper;
        if (Math.abs(bankAngle) > 1e-5) {
          right.applyAxisAngle(tangent, bankAngle).normalize();
        }
      }

      const normal = new THREE.Vector3().crossVectors(right, tangent);
      if (normal.lengthSq() < 1e-8) {
        normal.set(0, 1, 0);
      } else {
        normal.normalize();
      }

      rights.push(right);
      normals.push(normal);
    }

    return { tangents, rights, normals, miterScales, distances };
  }

  private createRibbonBuffers(
    points: THREE.Vector3[],
    widthMeters: number,
    allowBank: boolean,
    originOffset: THREE.Vector3,
  ): RibbonBuffers {
    const halfWidth = widthMeters * 0.5;
    return this.createRibbonBuffersWithOffsets(
      points,
      -halfWidth,
      halfWidth,
      allowBank,
      originOffset,
    );
  }

  private slicePolylineByDistance(
    points: THREE.Vector3[],
    cumDists: number[],
    startDist: number,
    endDist: number,
  ): THREE.Vector3[] {
    const total = cumDists[cumDists.length - 1] ?? 0;
    const s0 = THREE.MathUtils.clamp(startDist, 0, total);
    const s1 = THREE.MathUtils.clamp(endDist, 0, total);
    if (s1 - s0 < 0.15 || points.length < 2) {
      return [];
    }

    const interpolateAt = (s: number): THREE.Vector3 => {
      for (let i = 0; i < cumDists.length - 1; i++) {
        const d0 = cumDists[i]!;
        const d1 = cumDists[i + 1]!;
        if (s <= d1 || i === cumDists.length - 2) {
          const seg = d1 - d0;
          const alpha = seg > 1e-6 ? THREE.MathUtils.clamp((s - d0) / seg, 0, 1) : 0;
          return new THREE.Vector3().lerpVectors(points[i]!, points[i + 1]!, alpha);
        }
      }
      return points[points.length - 1]!.clone();
    };

    const out: THREE.Vector3[] = [interpolateAt(s0)];
    for (let i = 0; i < points.length; i++) {
      const d = cumDists[i]!;
      if (d > s0 + 0.05 && d < s1 - 0.05) {
        out.push(points[i]!.clone());
      }
    }
    out.push(interpolateAt(s1));
    return out;
  }

  private createRibbonBuffersWithOffsets(
    points: THREE.Vector3[],
    leftOffsetM: number,
    rightOffsetM: number,
    allowBank: boolean,
    originOffset: THREE.Vector3,
    uStart = 0,
    uEnd = 1,
    pinnedStartRight?: THREE.Vector3,
    pinnedEndRight?: THREE.Vector3,
    vDistOffsetM = 0,
  ): RibbonBuffers {
    const n = points.length;
    if (n < 2) {
      return createEmptyBuffers();
    }
    const { rights, normals, miterScales, distances } =
      this.computeFrameAlongPolyline(points, allowBank);
    if (pinnedStartRight && rights.length > 0) {
      rights[0] = pinnedStartRight.clone().normalize();
      miterScales[0] = 1;
    }
    if (pinnedEndRight && rights.length > 1) {
      rights[rights.length - 1] = pinnedEndRight.clone().normalize();
      miterScales[miterScales.length - 1] = 1;
    }

    const positions: number[] = [];
    const normOut: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    for (let i = 0; i < n; i++) {
      const p = points[i]!;
      const r = rights[i]!;
      const norm = normals[i]!;
      const scale = miterScales[i]!;
      const lOff = leftOffsetM * scale;
      const rOff = rightOffsetM * scale;
      const vCoord = (vDistOffsetM + distances[i]!) / ROAD_TILE_LENGTH_METERS;

      const lx = p.x + r.x * lOff - originOffset.x;
      const ly = p.y + r.y * lOff - originOffset.y;
      const lz = p.z + r.z * lOff - originOffset.z;

      const rx = p.x + r.x * rOff - originOffset.x;
      const ry = p.y + r.y * rOff - originOffset.y;
      const rz = p.z + r.z * rOff - originOffset.z;

      positions.push(lx, ly, lz, rx, ry, rz);
      normOut.push(norm.x, norm.y, norm.z, norm.x, norm.y, norm.z);
      uvs.push(uStart, vCoord, uEnd, vCoord);
    }

    for (let i = 0; i < n - 1; i++) {
      const base0 = i * 2;
      const base1 = (i + 1) * 2;
      indices.push(base0, base0 + 1, base1 + 1);
      indices.push(base0, base1 + 1, base1);
    }

    return { positions, normals: normOut, uvs, indices };
  }

  private appendTaperSegment(
    roadTarget: RibbonBuffers,
    apronTarget: RibbonBuffers,
    whiteEdgeTarget: RibbonBuffers,
    yellowEdgeTarget: RibbonBuffers,
    rawPoints: THREE.Vector3[],
    fromLeftM: number,
    fromRightM: number,
    toLeftM: number,
    toRightM: number,
    steadyLeftM: number,
    steadyRightM: number,
    oneway: boolean,
    allowBank: boolean,
    originOffset: THREE.Vector3,
    pinnedStartRight: THREE.Vector3 | undefined,
    pinnedEndRight: THREE.Vector3 | undefined,
    vDistOffsetM: number,
    dashedDropLatM?: number,
    smoothLeftCurve = false,
    leftEntryDividerLatM?: number,
  ): void {
    if (rawPoints.length < 2) {
      return;
    }
    let points = rawPoints;
    if (smoothLeftCurve) {
      const dense: THREE.Vector3[] = [rawPoints[0]!];
      for (let i = 0; i < rawPoints.length - 1; i++) {
        const a = rawPoints[i]!;
        const b = rawPoints[i + 1]!;
        const segLen = a.distanceTo(b);
        const steps = Math.max(1, Math.ceil(segLen / 2.0));
        for (let k = 1; k <= steps; k++) {
          dense.push(new THREE.Vector3().lerpVectors(a, b, k / steps));
        }
      }
      points = dense;
    }
    const n = points.length;
    const { rights, normals, distances } = this.computeFrameAlongPolyline(points, allowBank);
    if (pinnedStartRight && rights.length > 0) {
      rights[0] = pinnedStartRight.clone().normalize();
    }
    if (pinnedEndRight && rights.length > 1) {
      rights[rights.length - 1] = pinnedEndRight.clone().normalize();
    }
    const totalLen = Math.max(1e-3, distances[n - 1] ?? 0);
    const steadyWidth = Math.max(0.5, steadyRightM - steadyLeftM);

    // Extrude tapered outer shoulder wedges + crisp angled outer edge stripes
    const leftChanges = Math.abs(toLeftM - fromLeftM) > 0.08;
    const rightChanges = Math.abs(toRightM - fromRightM) > 0.08;
    const widthDelta = Math.abs((toRightM - toLeftM) - (fromRightM - fromLeftM));
    const symmetricLaneChange =
      dashedDropLatM === undefined && leftChanges && rightChanges && widthDelta >= 1.5;

    // Extrude continuing parallel core strictly inside constant bounds so lane lines never warp/skew.
    // Skip coreBuf on symmetric lane-count transitions (e.g. 3->4 centered) where the wider texture's
    // lane dividers would otherwise clash with the narrower segment's dividers as short stub dashes.
    const coreLeftM = Math.max(fromLeftM, toLeftM);
    const coreRightM = Math.min(fromRightM, toRightM);
    if (!symmetricLaneChange && coreRightM - coreLeftM >= 0.8) {
      const uCoreL = THREE.MathUtils.clamp((coreLeftM - steadyLeftM) / steadyWidth, 0, 1);
      const uCoreR = THREE.MathUtils.clamp((coreRightM - steadyLeftM) / steadyWidth, 0, 1);
      const coreBuf = this.createRibbonBuffersWithOffsets(
        points,
        coreLeftM,
        coreRightM,
        allowBank,
        originOffset,
        uCoreL,
        uCoreR,
        pinnedStartRight,
        pinnedEndRight,
        vDistOffsetM,
      );
      appendBuffers(roadTarget, coreBuf);
    }

    const edgeStripeHalfW = 0.075;
    const smoothstep = (t: number) => t * t * (3 - 2 * t);
    const needRetractedRightStripe = !rightChanges && toRightM < steadyRightM - 0.1;

    for (let i = 0; i < n - 1; i++) {
      const d0 = distances[i] ?? 0;
      const d1 = distances[i + 1] ?? totalLen;
      const a0 = THREE.MathUtils.clamp(d0 / totalLen, 0, 1);
      const a1 = THREE.MathUtils.clamp(d1 / totalLen, 0, 1);
      const p0 = points[i]!;
      const p1 = points[i + 1]!;
      const r0 = rights[i]!;
      const r1 = rights[i + 1]!;
      const n0 = normals[i]!;

      const curL0 = THREE.MathUtils.lerp(fromLeftM, toLeftM, smoothLeftCurve ? smoothstep(a0) : a0);
      const curL1 = THREE.MathUtils.lerp(fromLeftM, toLeftM, smoothLeftCurve ? smoothstep(a1) : a1);
      const curR0 = THREE.MathUtils.lerp(fromRightM, toRightM, a0);
      const curR1 = THREE.MathUtils.lerp(fromRightM, toRightM, a1);

      const mkPt = (p: THREE.Vector3, r: THREE.Vector3, nrm: THREE.Vector3, lat: number, yLift = 0) =>
        new THREE.Vector3(
          p.x + r.x * lat + nrm.x * yLift - originOffset.x,
          p.y + r.y * lat + nrm.y * yLift - originOffset.y,
          p.z + r.z * lat + nrm.z * yLift - originOffset.z,
        );

      if (symmetricLaneChange) {
        pushQuad(
          apronTarget,
          mkPt(p0, r0, n0, curL0, -0.002),
          mkPt(p0, r0, n0, curR0, -0.002),
          mkPt(p1, r1, n0, curR1, -0.002),
          mkPt(p1, r1, n0, curL1, -0.002),
          n0,
        );
        // Connect continuing through-lane dividers linearly across the taper using the 3m/9m dash cycle
        const fromW = fromRightM - fromLeftM;
        const toW = toRightM - toLeftM;
        const minLanes = Math.max(1, Math.round(Math.min(fromW, toW) / LANE_WIDTH_METERS));
        if (minLanes >= 2) {
          const segLen = Math.max(1e-3, d1 - d0);
          const subSteps = Math.max(1, Math.ceil(segLen / 0.75));
          for (let sIdx = 0; sIdx < subSteps; sIdx++) {
            const f0 = sIdx / subSteps;
            const f1 = (sIdx + 1) / subSteps;
            const aSub0 = THREE.MathUtils.lerp(a0, a1, f0);
            const aSub1 = THREE.MathUtils.lerp(a0, a1, f1);
            const dSubMid = vDistOffsetM + THREE.MathUtils.lerp(d0, d1, 0.5 * (f0 + f1));
            if (dSubMid % 9.0 >= 3.0) {
              continue;
            }
            const ps0 = new THREE.Vector3().lerpVectors(p0, p1, f0);
            const ps1 = new THREE.Vector3().lerpVectors(p0, p1, f1);
            const rs0 = new THREE.Vector3().lerpVectors(r0, r1, f0).normalize();
            const rs1 = new THREE.Vector3().lerpVectors(r0, r1, f1).normalize();
            for (let k = 1; k < minLanes; k++) {
              const latFrom = oneway
                ? fromRightM - k * LANE_WIDTH_METERS
                : fromLeftM + (fromW * k) / minLanes;
              const latTo = oneway
                ? toRightM - k * LANE_WIDTH_METERS
                : toLeftM + (toW * k) / minLanes;
              const lat0 = THREE.MathUtils.lerp(latFrom, latTo, aSub0);
              const lat1 = THREE.MathUtils.lerp(latFrom, latTo, aSub1);
              pushQuad(
                whiteEdgeTarget,
                mkPt(ps0, rs0, n0, lat0 - 0.07, 0.014),
                mkPt(ps0, rs0, n0, lat0 + 0.07, 0.014),
                mkPt(ps1, rs1, n0, lat1 + 0.07, 0.014),
                mkPt(ps1, rs1, n0, lat1 - 0.07, 0.014),
                n0,
              );
            }
          }
        }
      } else {
        const fillLeftStart = Math.min(curL0, coreLeftM);
        const fillLeftEnd = Math.min(curL1, coreLeftM);
        if (coreLeftM - fillLeftStart > 0.04 || coreLeftM - fillLeftEnd > 0.04) {
          pushQuad(
            apronTarget,
            mkPt(p0, r0, n0, fillLeftStart, -0.002),
            mkPt(p0, r0, n0, coreLeftM, -0.002),
            mkPt(p1, r1, n0, coreLeftM, -0.002),
            mkPt(p1, r1, n0, fillLeftEnd, -0.002),
            n0,
          );
        }

        const fillRightStart = Math.max(curR0, coreRightM);
        const fillRightEnd = Math.max(curR1, coreRightM);
        if (fillRightStart - coreRightM > 0.04 || fillRightEnd - coreRightM > 0.04) {
          pushQuad(
            apronTarget,
            mkPt(p0, r0, n0, coreRightM, -0.002),
            mkPt(p0, r0, n0, fillRightStart, -0.002),
            mkPt(p1, r1, n0, fillRightEnd, -0.002),
            mkPt(p1, r1, n0, coreRightM, -0.002),
            n0,
          );
        }
      }

      if (leftChanges) {
        const stripeTarget = oneway ? yellowEdgeTarget : whiteEdgeTarget;
        pushQuad(
          stripeTarget,
          mkPt(p0, r0, n0, curL0 + 0.02, 0.014),
          mkPt(p0, r0, n0, curL0 + 0.02 + edgeStripeHalfW * 2, 0.014),
          mkPt(p1, r1, n0, curL1 + 0.02 + edgeStripeHalfW * 2, 0.014),
          mkPt(p1, r1, n0, curL1 + 0.02, 0.014),
          n0,
        );
      }
      if (rightChanges || needRetractedRightStripe) {
        pushQuad(
          whiteEdgeTarget,
          mkPt(p0, r0, n0, curR0 - 0.02 - edgeStripeHalfW * 2, 0.014),
          mkPt(p0, r0, n0, curR0 - 0.02, 0.014),
          mkPt(p1, r1, n0, curR1 - 0.02, 0.014),
          mkPt(p1, r1, n0, curR1 - 0.02 - edgeStripeHalfW * 2, 0.014),
          n0,
        );
      }
      if (smoothLeftCurve && leftEntryDividerLatM !== undefined) {
        const aMid = 0.5 * (a0 + a1);
        if (aMid >= 0.25) {
          const segLen = Math.max(1e-3, d1 - d0);
          const subSteps = Math.max(1, Math.ceil(segLen / 0.75));
          for (let sIdx = 0; sIdx < subSteps; sIdx++) {
            const f0 = sIdx / subSteps;
            const f1 = (sIdx + 1) / subSteps;
            const dMid = THREE.MathUtils.lerp(d0, d1, 0.5 * (f0 + f1));
            if (dMid % 3.0 >= 1.5) {
              continue;
            }
            const ps0 = new THREE.Vector3().lerpVectors(p0, p1, f0);
            const ps1 = new THREE.Vector3().lerpVectors(p0, p1, f1);
            const rs0 = new THREE.Vector3().lerpVectors(r0, r1, f0).normalize();
            const rs1 = new THREE.Vector3().lerpVectors(r0, r1, f1).normalize();
            pushQuad(
              whiteEdgeTarget,
              mkPt(ps0, rs0, n0, leftEntryDividerLatM - 0.07, 0.014),
              mkPt(ps0, rs0, n0, leftEntryDividerLatM + 0.07, 0.014),
              mkPt(ps1, rs1, n0, leftEntryDividerLatM + 0.07, 0.014),
              mkPt(ps1, rs1, n0, leftEntryDividerLatM - 0.07, 0.014),
              n0,
            );
          }
        }
      }
      if (dashedDropLatM !== undefined) {
        const dMid = 0.5 * (d0 + d1);
        if (dMid % 3.2 < 1.6) {
          pushQuad(
            whiteEdgeTarget,
            mkPt(p0, r0, n0, dashedDropLatM - 0.07, 0.014),
            mkPt(p0, r0, n0, dashedDropLatM + 0.07, 0.014),
            mkPt(p1, r1, n0, dashedDropLatM + 0.07, 0.014),
            mkPt(p1, r1, n0, dashedDropLatM - 0.07, 0.014),
            n0,
          );
        }
      }
    }
  }

  private appendRoadSurfaceWithTapers(
    roadTarget: RibbonBuffers,
    apronTarget: RibbonBuffers,
    whiteEdgeTarget: RibbonBuffers,
    yellowEdgeTarget: RibbonBuffers,
    points: THREE.Vector3[],
    cs: EdgeCrossSectionProfile,
    trans: EdgeTransitionPlan | undefined,
    allowBank: boolean,
    originOffset: THREE.Vector3,
    extraVOffsetM = 0,
  ): void {
    if (points.length < 2) {
      return;
    }
    const startTaper = trans?.startTaperLenM ?? 0;
    const startLeadIn = trans?.startLeadInM ?? 0;
    const endTaper = trans?.endTaperLenM ?? 0;
    if (trans?.isPlacementTransition) {
      this.appendTaperSegment(
        roadTarget,
        apronTarget,
        whiteEdgeTarget,
        yellowEdgeTarget,
        points,
        trans.startLeftM,
        trans.startRightM,
        trans.endLeftM,
        trans.endRightM,
        cs.leftOffsetM,
        cs.rightOffsetM,
        cs.oneway,
        allowBank,
        originOffset,
        trans.pinnedStartRight,
        trans.pinnedEndRight,
        extraVOffsetM,
      );
      return;
    }
    if (startTaper <= 0.15 && startLeadIn <= 0.15 && endTaper <= 0.15) {
      const buf = this.createRibbonBuffersWithOffsets(
        points,
        cs.leftOffsetM,
        cs.rightOffsetM,
        allowBank,
        originOffset,
        0,
        1,
        trans?.pinnedStartRight,
        trans?.pinnedEndRight,
        extraVOffsetM,
      );
      appendBuffers(roadTarget, buf);
      return;
    }

    const cumDists: number[] = [0];
    for (let i = 1; i < points.length; i++) {
      cumDists.push(cumDists[i - 1]! + points[i - 1]!.distanceTo(points[i]!));
    }
    const totalLen = cumDists[cumDists.length - 1] ?? 0;
    if (totalLen < 1.0) {
      return;
    }
    const steadyWidth = Math.max(0.5, cs.rightOffsetM - cs.leftOffsetM);
    const emitSolidRightEdge = (
      subPts: THREE.Vector3[],
      latRightM: number,
      pinStart?: THREE.Vector3,
    ) => {
      if (subPts.length < 2) {
        return;
      }
      const lFrame = this.computeFrameAlongPolyline(subPts, allowBank);
      if (pinStart && lFrame.rights.length > 0) {
        lFrame.rights[0] = pinStart.clone().normalize();
      }
      const edgeW = 0.15;
      for (let k = 0; k < subPts.length - 1; k++) {
        const p0 = subPts[k]!;
        const p1 = subPts[k + 1]!;
        const r0 = lFrame.rights[k]!;
        const r1 = lFrame.rights[k + 1]!;
        const n0 = lFrame.normals[k]!;
        const mkEdgePt = (p: THREE.Vector3, r: THREE.Vector3, nrm: THREE.Vector3, lat: number) =>
          new THREE.Vector3(
            p.x + r.x * lat + nrm.x * 0.014 - originOffset.x,
            p.y + r.y * lat + nrm.y * 0.014 - originOffset.y,
            p.z + r.z * lat + nrm.z * 0.014 - originOffset.z,
          );
        pushQuad(
          whiteEdgeTarget,
          mkEdgePt(p0, r0, n0, latRightM - edgeW),
          mkEdgePt(p0, r0, n0, latRightM),
          mkEdgePt(p1, r1, n0, latRightM),
          mkEdgePt(p1, r1, n0, latRightM - edgeW),
          n0,
        );
      }
    };

    if (trans?.rightPocketTaperM && trans.rightPocketCoreRightM !== undefined) {
      const coreRightM = trans.rightPocketCoreRightM;
      const sLeftEnd = Math.min(startTaper, totalLen * 0.45);
      const sRightStart = Math.max(
        sLeftEnd,
        Math.min(trans.rightPocketLeadInM ?? sLeftEnd, totalLen - 6.0),
      );
      const sRightEnd = Math.min(sRightStart + trans.rightPocketTaperM, totalLen - 2.0);

      if (sLeftEnd > 0.15) {
        const sub1 = this.slicePolylineByDistance(points, cumDists, 0, sLeftEnd);
        this.appendTaperSegment(
          roadTarget,
          apronTarget,
          whiteEdgeTarget,
          yellowEdgeTarget,
          sub1,
          trans.startLeftM,
          coreRightM,
          cs.leftOffsetM,
          coreRightM,
          cs.leftOffsetM,
          cs.rightOffsetM,
          cs.oneway,
          allowBank,
          originOffset,
          trans.pinnedStartRight,
          undefined,
          extraVOffsetM,
          undefined,
          Boolean(trans.leftBaySmoothCurve),
          trans.leftBayEntryDividerLatM,
        );
      }

      if (sRightStart - sLeftEnd > 0.15) {
        const sub2 = this.slicePolylineByDistance(points, cumDists, sLeftEnd, sRightStart);
        const u2R = THREE.MathUtils.clamp((coreRightM - cs.leftOffsetM) / steadyWidth, 0, 1);
        const midBuf = this.createRibbonBuffersWithOffsets(
          sub2,
          cs.leftOffsetM,
          coreRightM,
          allowBank,
          originOffset,
          0,
          u2R,
          sLeftEnd <= 0.15 ? trans.pinnedStartRight : undefined,
          undefined,
          extraVOffsetM + sLeftEnd,
        );
        appendBuffers(roadTarget, midBuf);
        emitSolidRightEdge(sub2, coreRightM, sLeftEnd <= 0.15 ? trans.pinnedStartRight : undefined);
      }

      if (sRightEnd - sRightStart > 0.15) {
        const sub3 = this.slicePolylineByDistance(points, cumDists, sRightStart, sRightEnd);
        this.appendTaperSegment(
          roadTarget,
          apronTarget,
          whiteEdgeTarget,
          yellowEdgeTarget,
          sub3,
          cs.leftOffsetM,
          coreRightM,
          cs.leftOffsetM,
          cs.rightOffsetM,
          cs.leftOffsetM,
          cs.rightOffsetM,
          cs.oneway,
          allowBank,
          originOffset,
          undefined,
          totalLen - sRightEnd <= 0.15 ? trans.pinnedEndRight : undefined,
          extraVOffsetM + sRightStart,
          trans.pocketDividerLatM,
        );
      }

      if (totalLen - sRightEnd > 0.15) {
        const sub4 = this.slicePolylineByDistance(points, cumDists, sRightEnd, totalLen);
        const endBuf = this.createRibbonBuffersWithOffsets(
          sub4,
          cs.leftOffsetM,
          cs.rightOffsetM,
          allowBank,
          originOffset,
          0,
          1,
          undefined,
          trans.pinnedEndRight,
          extraVOffsetM + sRightEnd,
        );
        appendBuffers(roadTarget, endBuf);
      }
      return;
    }

    const endT = Math.min(endTaper, totalLen * 0.48);
    const sB = totalLen - endT;
    const sA0 = Math.min(Math.max(0, startLeadIn), Math.max(0, sB - 4.0));
    const sA = Math.min(sA0 + startTaper, sB);

    if (sA0 > 0.15 && trans) {
      const subLead = this.slicePolylineByDistance(points, cumDists, 0, sA0);
      const u0L = THREE.MathUtils.clamp((trans.startLeftM - cs.leftOffsetM) / steadyWidth, 0, 1);
      const u0R = THREE.MathUtils.clamp((trans.startRightM - cs.leftOffsetM) / steadyWidth, 0, 1);
      const leadBuf = this.createRibbonBuffersWithOffsets(
        subLead,
        trans.startLeftM,
        trans.startRightM,
        allowBank,
        originOffset,
        u0L,
        u0R,
        trans.pinnedStartRight,
        undefined,
        extraVOffsetM,
      );
      appendBuffers(roadTarget, leadBuf);

      // Draw crisp white outer curb stripe along lead-in where right pocket hasn't flared yet
      if (trans.startRightM < cs.rightOffsetM - 0.1) {
        emitSolidRightEdge(subLead, trans.startRightM, trans.pinnedStartRight);
      }
    }

    if (sA - sA0 > 0.15 && trans) {
      const subA = this.slicePolylineByDistance(points, cumDists, sA0, sA);
      this.appendTaperSegment(
        roadTarget,
        apronTarget,
        whiteEdgeTarget,
        yellowEdgeTarget,
        subA,
        trans.startLeftM,
        trans.startRightM,
        cs.leftOffsetM,
        cs.rightOffsetM,
        cs.leftOffsetM,
        cs.rightOffsetM,
        cs.oneway,
        allowBank,
        originOffset,
        sA0 <= 0.15 ? trans.pinnedStartRight : undefined,
        undefined,
        extraVOffsetM + sA0,
        trans.pocketDividerLatM,
        Boolean(trans.leftBaySmoothCurve),
        trans.leftBayEntryDividerLatM,
      );
    }

    if (sB - sA > 0.15) {
      const subMid = this.slicePolylineByDistance(points, cumDists, sA, sB);
      const midBuf = this.createRibbonBuffersWithOffsets(
        subMid,
        cs.leftOffsetM,
        cs.rightOffsetM,
        allowBank,
        originOffset,
        0,
        1,
        sA <= 0.15 ? trans?.pinnedStartRight : undefined,
        totalLen - sB <= 0.15 ? trans?.pinnedEndRight : undefined,
        extraVOffsetM + sA,
      );
      appendBuffers(roadTarget, midBuf);
    }

    if (totalLen - sB > 0.15 && trans) {
      const subB = this.slicePolylineByDistance(points, cumDists, sB, totalLen);
      this.appendTaperSegment(
        roadTarget,
        apronTarget,
        whiteEdgeTarget,
        yellowEdgeTarget,
        subB,
        cs.leftOffsetM,
        cs.rightOffsetM,
        trans.endLeftM,
        trans.endRightM,
        cs.leftOffsetM,
        cs.rightOffsetM,
        cs.oneway,
        allowBank,
        originOffset,
        undefined,
        trans.pinnedEndRight,
        extraVOffsetM + sB,
      );
    }
  }

  private buildChunkTerrainSkirt(
    chunk: ChunkData,
    originOffset: THREE.Vector3,
  ): RibbonBuffers {
    const buf = createEmptyBuffers();
    const b = chunk.chunk.bounds_m;
    const minX = b.min_x;
    const maxX = b.max_x;
    const minZ = b.min_z;
    const maxZ = b.max_z;

    // Fast path: globally consistent, cross-chunk-clamped heightfield computed across all city roads
    if (chunk.terrain_grid && chunk.terrain_grid.length >= 2) {
      const rows = chunk.terrain_grid;
      const grid = rows.length - 1;
      for (let iz = 0; iz < grid; iz++) {
        const row0 = rows[iz];
        const row1 = rows[iz + 1];
        if (!row0 || !row1) {
          continue;
        }
        const z0 = minZ + ((maxZ - minZ) * iz) / grid - originOffset.z;
        const z1 = minZ + ((maxZ - minZ) * (iz + 1)) / grid - originOffset.z;
        const colLimit = Math.min(grid, row0.length - 1, row1.length - 1);
        for (let ix = 0; ix < colLimit; ix++) {
          const y00 = row0[ix];
          const y01 = row1[ix];
          const y11 = row1[ix + 1];
          const y10 = row0[ix + 1];
          if (
            y00 === undefined ||
            y01 === undefined ||
            y11 === undefined ||
            y10 === undefined
          ) {
            continue;
          }
          const x0 = minX + ((maxX - minX) * ix) / grid - originOffset.x;
          const x1 = minX + ((maxX - minX) * (ix + 1)) / grid - originOffset.x;
          const p00 = new THREE.Vector3(x0, y00 - originOffset.y, z0);
          const p01 = new THREE.Vector3(x0, y01 - originOffset.y, z1);
          const p11 = new THREE.Vector3(x1, y11 - originOffset.y, z1);
          const p10 = new THREE.Vector3(x1, y10 - originOffset.y, z0);
          pushQuad(buf, p00, p01, p11, p10, WORLD_UP);
        }
      }
      return buf;
    }

    const nodes = chunk.nodes;
    if (nodes.length === 0) {
      return buf;
    }

    const samples: Array<{ x: number; y: number; z: number }> = [];
    for (const nd of nodes) {
      samples.push({ x: nd.x, y: nd.ground_y ?? nd.y, z: nd.z });
    }
    for (const edge of chunk.edges) {
      if (edge.layer !== 0 || edge.bridge || edge.tunnel || edge.geometry.length === 0) {
        continue;
      }
      const stride = edge.geometry.length > 24 ? 3 : 1;
      for (let i = 0; i < edge.geometry.length; i += stride) {
        const pt = edge.geometry[i]!;
        samples.push({ x: pt[0], y: pt[1], z: pt[2] });
      }
      const last = edge.geometry[edge.geometry.length - 1]!;
      samples.push({ x: last[0], y: last[1], z: last[2] });
    }

    const grid = 18;
    const guardRadiusSq = 58 * 58;

    const sampleIdwGround = (wx: number, wz: number): number => {
      let wSum = 0;
      let ySum = 0;
      let localMinY = Infinity;
      for (const sp of samples) {
        const dx = wx - sp.x;
        const dz = wz - sp.z;
        const d2NoReg = dx * dx + dz * dz;
        if (d2NoReg < guardRadiusSq && sp.y < localMinY) {
          localMinY = sp.y;
        }
        const d2 = d2NoReg + 360;
        const w = 1 / d2;
        wSum += w;
        ySum += w * sp.y;
      }
      const idwY = (wSum > 0 ? ySum / wSum : samples[0]!.y) - 0.42;
      if (Number.isFinite(localMinY)) {
        return Math.min(idwY, localMinY - 0.34);
      }
      return idwY;
    };

    const yGrid: number[][] = [];
    for (let iz = 0; iz <= grid; iz++) {
      const row: number[] = [];
      const wz = minZ + ((maxZ - minZ) * iz) / grid;
      for (let ix = 0; ix <= grid; ix++) {
        const wx = minX + ((maxX - minX) * ix) / grid;
        row.push(sampleIdwGround(wx, wz) - originOffset.y);
      }
      yGrid.push(row);
    }

    for (let iz = 0; iz < grid; iz++) {
      const z0 = minZ + ((maxZ - minZ) * iz) / grid - originOffset.z;
      const z1 = minZ + ((maxZ - minZ) * (iz + 1)) / grid - originOffset.z;
      for (let ix = 0; ix < grid; ix++) {
        const x0 = minX + ((maxX - minX) * ix) / grid - originOffset.x;
        const x1 = minX + ((maxX - minX) * (ix + 1)) / grid - originOffset.x;

        const y00 = yGrid[iz]![ix]!;
        const y10 = yGrid[iz]![ix + 1]!;
        const y11 = yGrid[iz + 1]![ix + 1]!;
        const y01 = yGrid[iz + 1]![ix]!;

        const p00 = new THREE.Vector3(x0, y00, z0);
        const p01 = new THREE.Vector3(x0, y01, z1);
        const p11 = new THREE.Vector3(x1, y11, z1);
        const p10 = new THREE.Vector3(x1, y10, z0);
        pushQuad(buf, p00, p01, p11, p10, WORLD_UP);
      }
    }
    return buf;
  }

  private createBridgeDeckBuffers(
    points: THREE.Vector3[],
    widthMeters: number,
    allowBank: boolean,
    isMotorwayBridge: boolean,
    originOffset: THREE.Vector3,
    uGroundY = points[0]?.y ?? 0,
    vGroundY = points[points.length - 1]?.y ?? 0,
  ): RibbonBuffers {
    const n = points.length;
    const { rights, normals, miterScales, distances } = this.computeFrameAlongPolyline(
      points,
      allowBank,
    );
    const totalLen = Math.max(1e-3, distances[n - 1] ?? 1);

    const halfRoad = widthMeters * 0.5;
    const maxBarrierHeight = isMotorwayBridge
      ? BRIDGE_BARRIER_HEIGHT_HWY_METERS
      : BRIDGE_CURB_HEIGHT_CITY_METERS;
    const deckBuffers = createEmptyBuffers();

    // Compute per-vertex ground clearance & taper factor so ramp touchdowns never form square blocking walls
    const clearances: number[] = [];
    const deckFactors: number[] = [];
    const groundYs: number[] = [];
    for (let i = 0; i < n; i++) {
      const frac = (distances[i] ?? 0) / totalLen;
      const gY = THREE.MathUtils.lerp(uGroundY, vGroundY, frac);
      groundYs.push(gY);
      const clr = points[i]!.y - gY;
      clearances.push(clr);
      deckFactors.push(THREE.MathUtils.clamp((clr - 0.35) / 1.15, 0, 1));
    }

    const makePoint = (
      i: number,
      lateralOffset: number,
      normalOffset: number,
    ): THREE.Vector3 => {
      const p = points[i]!;
      const r = rights[i]!;
      const norm = normals[i]!;
      return new THREE.Vector3(
        p.x + r.x * lateralOffset + norm.x * normalOffset - originOffset.x,
        p.y + r.y * lateralOffset + norm.y * normalOffset - originOffset.y,
        p.z + r.z * lateralOffset + norm.z * normalOffset - originOffset.z,
      );
    };

    for (let i = 0; i < n - 1; i++) {
      const f0 = deckFactors[i]!;
      const f1 = deckFactors[i + 1]!;
      if (f0 <= 0.02 && f1 <= 0.02) {
        continue;
      }

      const bh0 = maxBarrierHeight * f0;
      const bh1 = maxBarrierHeight * f1;
      const th0 = BRIDGE_DECK_THICKNESS_METERS * f0;
      const th1 = BRIDGE_DECK_THICKNESS_METERS * f1;

      const w0 = (halfRoad + BRIDGE_CURB_WIDTH_METERS) * miterScales[i]!;
      const w1 = (halfRoad + BRIDGE_CURB_WIDTH_METERS) * miterScales[i + 1]!;
      const r0 = halfRoad * miterScales[i]!;
      const r1 = halfRoad * miterScales[i + 1]!;
      const innerTop0 = (halfRoad + 0.14) * miterScales[i]!;
      const innerTop1 = (halfRoad + 0.14) * miterScales[i + 1]!;

      const lTopOut0 = makePoint(i, -w0, bh0);
      const lTopOut1 = makePoint(i + 1, -w1, bh1);
      const lTopIn0 = makePoint(i, -innerTop0, bh0);
      const lTopIn1 = makePoint(i + 1, -innerTop1, bh1);
      const lRoad0 = makePoint(i, -r0, -0.02);
      const lRoad1 = makePoint(i + 1, -r1, -0.02);
      const lBot0 = makePoint(i, -w0, -th0);
      const lBot1 = makePoint(i + 1, -w1, -th1);

      const rTopOut0 = makePoint(i, w0, bh0);
      const rTopOut1 = makePoint(i + 1, w1, bh1);
      const rTopIn0 = makePoint(i, innerTop0, bh0);
      const rTopIn1 = makePoint(i + 1, innerTop1, bh1);
      const rRoad0 = makePoint(i, r0, -0.02);
      const rRoad1 = makePoint(i + 1, r1, -0.02);
      const rBot0 = makePoint(i, w0, -th0);
      const rBot1 = makePoint(i + 1, w1, -th1);

      const avgNorm = new THREE.Vector3()
        .addVectors(normals[i]!, normals[i + 1]!)
        .normalize();
      const downNorm = avgNorm.clone().negate();
      const leftOutNorm = new THREE.Vector3()
        .addVectors(rights[i]!, rights[i + 1]!)
        .normalize()
        .negate();
      const rightOutNorm = leftOutNorm.clone().negate();

      // Left Jersey barrier / curb top, sloped inner face, outer wall
      pushQuad(deckBuffers, lTopOut0, lTopIn0, lTopIn1, lTopOut1, avgNorm);
      pushQuad(deckBuffers, lTopIn0, lRoad0, lRoad1, lTopIn1, rightOutNorm);
      pushQuad(deckBuffers, lBot0, lTopOut0, lTopOut1, lBot1, leftOutNorm);

      // Right Jersey barrier / curb top, sloped inner face, outer wall
      pushQuad(deckBuffers, rTopIn0, rTopOut0, rTopOut1, rTopIn1, avgNorm);
      pushQuad(deckBuffers, rRoad0, rTopIn0, rTopIn1, rRoad1, leftOutNorm);
      pushQuad(deckBuffers, rTopOut0, rBot0, rBot1, rTopOut1, rightOutNorm);

      // Solid underside deck slab
      pushQuad(deckBuffers, rBot0, lBot0, lBot1, rBot1, downNorm);
    }

    // Add structural reinforced concrete bridge piers under genuinely elevated spans (>= 3.4m clearance)
    const pierStepMeters = 28.0;
    const endBuffer = totalLen <= 68.0 ? 9.0 : 14.0;
    let nextPierDist = endBuffer;
    for (let i = 1; i < n - 1; i++) {
      const s = distances[i] ?? 0;
      if (s < nextPierDist || s > totalLen - endBuffer) {
        continue;
      }
      nextPierDist = s + pierStepMeters;
      const clr = clearances[i]!;
      if (clr < 3.4) {
        continue;
      }
      // On single-span short overpasses (<65m), put piers near outer shoulders away from middle crossing
      if (totalLen <= 65.0 && Math.abs(s - totalLen * 0.5) < 12.0) {
        continue;
      }

      const p = points[i]!;
      const r = rights[i]!;
      const gBot = groundYs[i]! - 1.5 - originOffset.y;
      const topY = p.y - BRIDGE_DECK_THICKNESS_METERS * 0.9 - originOffset.y;
      if (topY <= gBot + 0.5) {
        continue;
      }

      // Twin shoulder pier columns + top bent cap beam
      const pierLateralOffsets = halfRoad >= 4.5 ? [-halfRoad * 0.68, halfRoad * 0.68] : [0];
      const tan = new THREE.Vector3(-r.z, 0, r.x).normalize();
      for (const latOff of pierLateralOffsets) {
        const cx = p.x + r.x * latOff - originOffset.x;
        const cz = p.z + r.z * latOff - originOffset.z;
        const hwCol = 0.55;
        const hdCol = 0.55;
        const corner = (sx: number, sy: number, sz: number) =>
          new THREE.Vector3(
            cx + r.x * sx * hwCol + tan.x * sz * hdCol,
            sy,
            cz + r.z * sx * hwCol + tan.z * sz * hdCol,
          );
        const b00 = corner(-1, gBot, -1);
        const b10 = corner(1, gBot, -1);
        const b11 = corner(1, gBot, 1);
        const b01 = corner(-1, gBot, 1);
        const t00 = corner(-1, topY, -1);
        const t10 = corner(1, topY, -1);
        const t11 = corner(1, topY, 1);
        const t01 = corner(-1, topY, 1);
        pushQuad(deckBuffers, b01, b11, t11, t01, tan);
        pushQuad(deckBuffers, b10, b00, t00, t10, tan.clone().negate());
        pushQuad(deckBuffers, b11, b10, t10, t11, r);
        pushQuad(deckBuffers, b00, b01, t01, t00, r.clone().negate());
      }
    }

    return deckBuffers;
  }

  private getMaterialKey(
    lanes: number,
    bidirectional: boolean,
    oneway: boolean,
    forwardLanes: number,
    reverseLanes: number,
    hasStreetcar: boolean,
    isBridge: boolean,
    extras?: RoadMaterialExtras,
  ): string {
    const both = extras?.lanesBothWays ?? 0;
    const revC = extras?.lanesReversible ?? 0;
    const bL = (extras?.bikeLaneLeftM ?? 0).toFixed(2);
    const bR = (extras?.bikeLaneRightM ?? 0).toFixed(2);
    const bLT = extras?.bikeLaneLeftType ?? 'none';
    const bRT = extras?.bikeLaneRightType ?? 'none';
    const busF = extras?.busLanesForward?.map((v) => (v ? '1' : '0')).join('') ?? '';
    const busR = extras?.busLanesBackward?.map((v) => (v ? '1' : '0')).join('') ?? '';
    const hovF = extras?.hovLanesForward?.map((v) => (v ? '1' : '0')).join('') ?? '';
    const chgF = extras?.changeLanesForward?.join('|') ?? '';
    const sch = extras?.isSchoolZone ? 1 : 0;
    const hwy = extras?.isHighwayOrRamp ? 1 : 0;
    return `${lanes}:${bidirectional ? 1 : 0}:${oneway ? 1 : 0}:${forwardLanes}:${reverseLanes}:${both}:${revC}:${hasStreetcar ? 1 : 0}:${isBridge ? 1 : 0}:${bL}:${bR}:${bLT}:${bRT}:${busF}:${busR}:${hovF}:${chgF}:${sch}:${hwy}`;
  }

  private getRoadMaterial(
    lanes: number,
    bidirectional: boolean,
    oneway: boolean,
    forwardLanes: number,
    reverseLanes: number,
    hasStreetcar: boolean,
    isBridge: boolean,
    extras?: RoadMaterialExtras,
  ): THREE.MeshStandardMaterial {
    const key = this.getMaterialKey(
      lanes,
      bidirectional,
      oneway,
      forwardLanes,
      reverseLanes,
      hasStreetcar,
      isBridge,
      extras,
    );
    const existing = this.materialCache.get(key);
    if (existing) {
      return existing.material;
    }

    const textureSet = this.generateProceduralRoadTextures(
      lanes,
      bidirectional,
      oneway,
      forwardLanes,
      reverseLanes,
      hasStreetcar,
      isBridge,
      extras,
    );
    this.materialCache.set(key, textureSet);
    return textureSet.material;
  }

  private generateProceduralRoadTextures(
    lanes: number,
    bidirectional: boolean,
    oneway: boolean,
    forwardLanes: number,
    reverseLanes: number,
    hasStreetcar: boolean,
    isBridge: boolean,
    extras?: RoadMaterialExtras,
  ): RoadTextureSet {
    const lanesBothWays = !oneway && bidirectional ? (extras?.lanesBothWays ?? 0) : 0;
    const lanesReversible = !oneway && bidirectional && lanesBothWays === 0 ? (extras?.lanesReversible ?? 0) : 0;
    const centerExtra = lanesBothWays + lanesReversible;
    const bikeLeftM = extras?.bikeLaneLeftM ?? 0;
    const bikeRightM = extras?.bikeLaneRightM ?? 0;
    const bikeLeftType = extras?.bikeLaneLeftType ?? 'none';
    const bikeRightType = extras?.bikeLaneRightType ?? 'none';
    const isHighwayOrRamp = Boolean(extras?.isHighwayOrRamp);
    const busLanesFwd = extras?.busLanesForward ?? null;
    const busLanesRev = extras?.busLanesBackward ?? null;
    const hovLanesFwd = extras?.hovLanesForward ?? null;
    const chgLanesFwd = extras?.changeLanesForward ?? null;
    const isSchoolZone = Boolean(extras?.isSchoolZone);
    const trafficWidthMeters = lanes * LANE_WIDTH_METERS;
    const roadWidthMeters = trafficWidthMeters + bikeLeftM + bikeRightM;
    const widthPx = roadWidthMeters >= 17.5 ? 768 : 512;
    const heightPx = 512;
    const pxPerMeterX = widthPx / roadWidthMeters;
    const pxPerMeterY = heightPx / ROAD_TILE_LENGTH_METERS;
    const trafficStartPx = bikeLeftM * pxPerMeterX;
    const trafficEndPx = (bikeLeftM + trafficWidthMeters) * pxPerMeterX;

    const albedoCanvas = document.createElement('canvas');
    albedoCanvas.width = widthPx;
    albedoCanvas.height = heightPx;
    const ctx = albedoCanvas.getContext('2d')!;

    const roughCanvas = document.createElement('canvas');
    roughCanvas.width = widthPx;
    roughCanvas.height = heightPx;
    const rCtx = roughCanvas.getContext('2d')!;

    const metalCanvas = document.createElement('canvas');
    metalCanvas.width = widthPx;
    metalCanvas.height = heightPx;
    const mCtx = metalCanvas.getContext('2d')!;

    // Base asphalt matching intersection apron color (#262b33)
    ctx.fillStyle = isBridge ? '#2c323b' : '#262b33';
    ctx.fillRect(0, 0, widthPx, heightPx);

    rCtx.fillStyle = 'rgb(228, 228, 228)';
    rCtx.fillRect(0, 0, widthPx, heightPx);

    mCtx.fillStyle = 'rgb(10, 10, 10)';
    mCtx.fillRect(0, 0, widthPx, heightPx);

    const rng = createPrng(
      lanes * 977 +
        (bidirectional ? 17 : 31) +
        forwardLanes * 13 +
        lanesBothWays * 53 +
        lanesReversible * 79 +
        (hasStreetcar ? 103 : 0),
    );
    for (let i = 0; i < 8200; i++) {
      const sx = Math.floor(rng() * widthPx);
      const sy = Math.floor(rng() * heightPx);
      const shade =
        rng() > 0.5 ? 'rgba(255,255,255,0.048)' : 'rgba(0,0,0,0.08)';
      ctx.fillStyle = shade;
      ctx.fillRect(sx, sy, 2, 2);
    }

    const revCount = !oneway && bidirectional ? THREE.MathUtils.clamp(reverseLanes, 1, Math.max(1, lanes - 1)) : 0;
    const fwdStartIdx = bidirectional && !oneway ? Math.min(lanes - 1, revCount + centerExtra) : 0;

    // Resolve lane roles across canvas [0 .. lanes - 1]
    const laneIsBus = new Array<boolean>(lanes).fill(false);
    const laneIsFwd = new Array<boolean>(lanes).fill(true);
    const laneIsHov = new Array<boolean>(lanes).fill(false);

    if (bidirectional && !oneway) {
      for (let i = 0; i < revCount; i++) {
        laneIsFwd[i] = false;
      }
    }
    if (busLanesFwd) {
      for (let j = 0; j < busLanesFwd.length; j++) {
        const li = fwdStartIdx + j;
        if (busLanesFwd[j] && li >= 0 && li < lanes) {
          laneIsBus[li] = true;
        }
      }
    }
    if (bidirectional && !oneway && busLanesRev) {
      for (let j = 0; j < busLanesRev.length; j++) {
        const li = revCount - 1 - j;
        if (busLanesRev[j] && li >= 0 && li < revCount) {
          laneIsBus[li] = true;
        }
      }
    }
    if (hovLanesFwd) {
      for (let j = 0; j < hovLanesFwd.length; j++) {
        const li = fwdStartIdx + j;
        if (hovLanesFwd[j] && li >= 0 && li < lanes) {
          laneIsHov[li] = true;
        }
      }
    }

    const drawDiamond = (cx: number, cy: number, dwPx: number, dhPx: number, lw: number) => {
      ctx.beginPath();
      ctx.moveTo(cx, cy - dhPx);
      ctx.lineTo(cx + dwPx, cy);
      ctx.lineTo(cx, cy + dhPx);
      ctx.lineTo(cx - dwPx, cy);
      ctx.closePath();
      ctx.lineWidth = lw;
      ctx.strokeStyle = 'rgba(248, 250, 252, 0.92)';
      ctx.stroke();
    };

    // RapidTO terracotta red dedicated bus lanes + crisp white BUS ONLY stencils
    for (let laneIdx = 0; laneIdx < lanes; laneIdx++) {
      if (!laneIsBus[laneIdx]) {
        continue;
      }
      const x0 = (bikeLeftM + laneIdx * LANE_WIDTH_METERS) * pxPerMeterX;
      const wPx = LANE_WIDTH_METERS * pxPerMeterX;
      ctx.fillStyle = 'rgba(153, 38, 38, 0.86)';
      ctx.fillRect(x0, 0, wPx, heightPx);
      rCtx.fillStyle = 'rgb(218, 218, 218)';
      rCtx.fillRect(x0, 0, wPx, heightPx);

      const cx = x0 + wPx * 0.5;
      const forwardDir = laneIsFwd[laneIdx] !== false;
      ctx.save();
      ctx.translate(cx, heightPx * 0.5);
      if (!forwardDir) {
        ctx.rotate(Math.PI);
      }
      drawDiamond(0, -heightPx * 0.24, 0.48 * pxPerMeterX, 1.05 * pxPerMeterY, Math.max(2.6, 0.13 * pxPerMeterX));
      ctx.fillStyle = '#f8fafc';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `900 ${Math.max(16, Math.round(wPx * 0.28))}px Arial, sans-serif`;
      ctx.fillText('BUS', 0, heightPx * 0.08);
      ctx.fillText('ONLY', 0, heightPx * 0.28);
      ctx.restore();
    }

    // Highway HOV white diamond stencils
    for (let laneIdx = 0; laneIdx < lanes; laneIdx++) {
      if (!laneIsHov[laneIdx] || laneIsBus[laneIdx]) {
        continue;
      }
      const cx = (bikeLeftM + (laneIdx + 0.5) * LANE_WIDTH_METERS) * pxPerMeterX;
      drawDiamond(cx, heightPx * 0.5, 0.45 * pxPerMeterX, 1.15 * pxPerMeterY, Math.max(2.6, 0.14 * pxPerMeterX));
    }

    // Subtle tire wear tracks down each motorized lane center
    for (let laneIdx = 0; laneIdx < lanes; laneIdx++) {
      const laneCenterPx = (bikeLeftM + (laneIdx + 0.5) * LANE_WIDTH_METERS) * pxPerMeterX;
      const trackOffsetPx = 0.72 * pxPerMeterX;
      const trackWidthPx = Math.max(4, 0.52 * pxPerMeterX);
      ctx.fillStyle = 'rgba(10, 12, 16, 0.18)';
      ctx.fillRect(
        laneCenterPx - trackOffsetPx - trackWidthPx * 0.5,
        0,
        trackWidthPx,
        heightPx,
      );
      ctx.fillRect(
        laneCenterPx + trackOffsetPx - trackWidthPx * 0.5,
        0,
        trackWidthPx,
        heightPx,
      );
    }

    // Sharrow double-chevron markings on shared bike-route curb lanes
    const drawSharrow = (laneIdx: number, forwardDir: boolean) => {
      if (laneIdx < 0 || laneIdx >= lanes) {
        return;
      }
      const cx = (bikeLeftM + (laneIdx + 0.5) * LANE_WIDTH_METERS) * pxPerMeterX;
      ctx.save();
      ctx.translate(cx, heightPx * 0.5);
      if (!forwardDir) {
        ctx.rotate(Math.PI);
      }
      ctx.strokeStyle = 'rgba(248, 250, 252, 0.85)';
      ctx.lineWidth = Math.max(2.4, 0.11 * pxPerMeterX);
      const wHalf = 0.46 * pxPerMeterX;
      const hStep = 0.42 * pxPerMeterY;
      for (const yOff of [-0.55 * pxPerMeterY, -0.05 * pxPerMeterY]) {
        ctx.beginPath();
        ctx.moveTo(-wHalf, yOff + hStep);
        ctx.lineTo(0, yOff);
        ctx.lineTo(wHalf, yOff + hStep);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(-0.34 * pxPerMeterX, 0.72 * pxPerMeterY, 0.22 * pxPerMeterX, 0, Math.PI * 2);
      ctx.arc(0.34 * pxPerMeterX, 0.72 * pxPerMeterY, 0.22 * pxPerMeterX, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    };
    if (bikeLeftType === 'shared' && !laneIsBus[0]) {
      drawSharrow(0, !bidirectional || oneway);
    }
    if (bikeRightType === 'shared' && !laneIsBus[lanes - 1]) {
      drawSharrow(lanes - 1, true);
    }

    // Green-tinted & white-buffered 1.6m bike lanes / protected cycle tracks
    const lineWidthPx = Math.max(2.6, 0.15 * pxPerMeterX);
    const drawBikeLane = (x0Px: number, laneWpx: number, bufX: number, kind: BikeLaneKind, forwardDir: boolean) => {
      if (laneWpx <= 2) {
        return;
      }
      const isTrack = kind === 'track';
      ctx.fillStyle = isTrack ? 'rgba(18, 128, 82, 0.78)' : 'rgba(22, 114, 72, 0.64)';
      ctx.fillRect(x0Px, 0, laneWpx, heightPx);
      rCtx.fillStyle = 'rgb(236, 236, 236)';
      rCtx.fillRect(x0Px, 0, laneWpx, heightPx);

      ctx.fillStyle = '#f8fafc';
      rCtx.fillStyle = 'rgb(165, 165, 165)';
      ctx.fillRect(bufX - lineWidthPx * 0.5, 0, lineWidthPx, heightPx);
      rCtx.fillRect(bufX - lineWidthPx * 0.5, 0, lineWidthPx, heightPx);
      if (isTrack) {
        const innerX = bufX + (x0Px < bufX ? -lineWidthPx * 2.2 : lineWidthPx * 2.2);
        ctx.fillRect(innerX - lineWidthPx * 0.4, 0, lineWidthPx * 0.8, heightPx);
      }

      const cx = x0Px + laneWpx * 0.5;
      ctx.save();
      ctx.translate(cx, heightPx * 0.5);
      if (!forwardDir) {
        ctx.rotate(Math.PI);
      }
      drawDiamond(0, -heightPx * 0.15, Math.min(laneWpx * 0.28, 0.34 * pxPerMeterX), 0.78 * pxPerMeterY, Math.max(2, 0.08 * pxPerMeterX));
      ctx.strokeStyle = 'rgba(248, 250, 252, 0.88)';
      ctx.lineWidth = Math.max(2, 0.07 * pxPerMeterX);
      const rWheel = Math.min(laneWpx * 0.16, 0.20 * pxPerMeterX);
      ctx.beginPath();
      ctx.arc(0, 0.85 * pxPerMeterY, rWheel, 0, Math.PI * 2);
      ctx.arc(0, 1.55 * pxPerMeterY, rWheel, 0, Math.PI * 2);
      ctx.moveTo(0, 0.85 * pxPerMeterY);
      ctx.lineTo(0, 1.55 * pxPerMeterY);
      ctx.stroke();
      ctx.restore();
    };
    if (bikeLeftM > 0) {
      drawBikeLane(0, trafficStartPx, trafficStartPx, bikeLeftType, !bidirectional || oneway);
    }
    if (bikeRightM > 0) {
      drawBikeLane(trafficEndPx, widthPx - trafficEndPx, trafficEndPx, bikeRightType, true);
    }

    // Embedded TTC steel streetcar tracks (1.495 m gauge) from extracted railway=tram network
    if (hasStreetcar) {
      const railLanes: number[] = [];
      if (bidirectional && !oneway) {
        if (lanes === 1) {
          railLanes.push(0);
        } else if (centerExtra === 1 && lanes >= 3) {
          railLanes.push(revCount - 1, revCount + 1);
        } else {
          railLanes.push(revCount - 1, revCount);
        }
      } else {
        railLanes.push(0);
      }

      for (const laneIdx of railLanes) {
        if (laneIdx < 0 || laneIdx >= lanes) {
          continue;
        }
        const laneCenterMeters = bikeLeftM + (laneIdx + 0.5) * LANE_WIDTH_METERS;
        const bedHalfWidthPx = 0.98 * pxPerMeterX;
        const laneCenterPx = laneCenterMeters * pxPerMeterX;

        ctx.fillStyle = '#303641';
        ctx.fillRect(
          laneCenterPx - bedHalfWidthPx,
          0,
          bedHalfWidthPx * 2,
          heightPx,
        );
        rCtx.fillStyle = 'rgb(205, 205, 205)';
        rCtx.fillRect(
          laneCenterPx - bedHalfWidthPx,
          0,
          bedHalfWidthPx * 2,
          heightPx,
        );

        ctx.fillStyle = 'rgba(12, 15, 20, 0.34)';
        for (let s = 0; s < 4; s++) {
          const seamY = Math.floor(((s + 0.5) / 4) * heightPx);
          ctx.fillRect(
            laneCenterPx - bedHalfWidthPx,
            seamY,
            bedHalfWidthPx * 2,
            2,
          );
        }

        const halfGaugePx = TTC_TRACK_GAUGE_METERS * 0.5 * pxPerMeterX;
        const railWidthPx = Math.max(3.6, 0.115 * pxPerMeterX);
        const grooveWidthPx = Math.max(2.2, 0.07 * pxPerMeterX);

        for (const side of [-1, 1]) {
          const railCenterPx = laneCenterPx + side * halfGaugePx;
          const grooveCenterPx = railCenterPx - side * (railWidthPx * 0.72);

          ctx.fillStyle = '#0b0e14';
          ctx.fillRect(
            grooveCenterPx - grooveWidthPx * 0.5,
            0,
            grooveWidthPx,
            heightPx,
          );

          ctx.fillStyle = '#cbd5e1';
          ctx.fillRect(
            railCenterPx - railWidthPx * 0.5,
            0,
            railWidthPx,
            heightPx,
          );
          ctx.fillStyle = '#f8fafc';
          ctx.fillRect(
            railCenterPx - railWidthPx * 0.24,
            0,
            Math.max(2.0, railWidthPx * 0.48),
            heightPx,
          );

          rCtx.fillStyle = 'rgb(112, 112, 112)';
          rCtx.fillRect(
            railCenterPx - railWidthPx * 0.5,
            0,
            railWidthPx,
            heightPx,
          );
          mCtx.fillStyle = 'rgb(88, 88, 88)';
          mCtx.fillRect(
            railCenterPx - railWidthPx * 0.5,
            0,
            railWidthPx,
            heightPx,
          );
        }
      }
    }

    const edgeLinePx = Math.max(2.6, 0.15 * pxPerMeterX);
    const gapPx = Math.max(2.4, 0.15 * pxPerMeterX);

    if (bidirectional && !oneway) {
      // Two-way edge markings (solid white edge stripe along non-bike curbs)
      ctx.fillStyle = isHighwayOrRamp ? '#f8fafc' : 'rgba(229, 231, 235, 0.85)';
      if (bikeLeftM <= 0) {
        ctx.fillRect(trafficStartPx + 1, 0, edgeLinePx, heightPx);
      }
      if (bikeRightM <= 0) {
        ctx.fillRect(trafficEndPx - edgeLinePx - 1, 0, edgeLinePx, heightPx);
      }

      ctx.fillStyle = '#facc15';
      rCtx.fillStyle = 'rgb(160, 160, 160)';

      if (lanesBothWays === 1 && lanes >= 3) {
        // Center Two-Way Left-Turn Lane (TWLTL): solid outer yellow + dashed inner yellow on both sides
        const twltlLeftX = (bikeLeftM + revCount * LANE_WIDTH_METERS) * pxPerMeterX;
        const twltlRightX = (bikeLeftM + (revCount + 1) * LANE_WIDTH_METERS) * pxPerMeterX;
        const dashLenPx = 3.0 * pxPerMeterY;
        const cyclePx = 6.0 * pxPerMeterY;
        const offsetPx = 1.5 * pxPerMeterY;

        const leftOuterX = twltlLeftX - gapPx * 0.5 - lineWidthPx;
        const leftInnerX = twltlLeftX + gapPx * 0.5;
        ctx.fillRect(leftOuterX, 0, lineWidthPx, heightPx);
        rCtx.fillRect(leftOuterX, 0, lineWidthPx, heightPx);

        const rightInnerX = twltlRightX - gapPx * 0.5 - lineWidthPx;
        const rightOuterX = twltlRightX + gapPx * 0.5;
        ctx.fillRect(rightOuterX, 0, lineWidthPx, heightPx);
        rCtx.fillRect(rightOuterX, 0, lineWidthPx, heightPx);

        for (let c = 0; c < 2; c++) {
          const yDash = c * cyclePx + offsetPx;
          ctx.fillRect(leftInnerX, yDash, lineWidthPx, dashLenPx);
          rCtx.fillRect(leftInnerX, yDash, lineWidthPx, dashLenPx);
          ctx.fillRect(rightInnerX, yDash, lineWidthPx, dashLenPx);
          rCtx.fillRect(rightInnerX, yDash, lineWidthPx, dashLenPx);
        }
      } else if (lanesReversible === 1 && lanes >= 3) {
        // Reversible center lane (Jarvis St): double broken/dashed yellow lines on BOTH sides
        const revLeftX = (bikeLeftM + revCount * LANE_WIDTH_METERS) * pxPerMeterX;
        const revRightX = (bikeLeftM + (revCount + 1) * LANE_WIDTH_METERS) * pxPerMeterX;
        const dashLenPx = 3.0 * pxPerMeterY;
        const cyclePx = 6.0 * pxPerMeterY;
        const offsetPx = 1.5 * pxPerMeterY;

        for (const baseX of [revLeftX, revRightX]) {
          const lx = baseX - gapPx * 0.5 - lineWidthPx;
          const rx = baseX + gapPx * 0.5;
          for (let c = 0; c < 2; c++) {
            const yDash = c * cyclePx + offsetPx;
            ctx.fillRect(lx, yDash, lineWidthPx, dashLenPx);
            rCtx.fillRect(lx, yDash, lineWidthPx, dashLenPx);
            ctx.fillRect(rx, yDash, lineWidthPx, dashLenPx);
            rCtx.fillRect(rx, yDash, lineWidthPx, dashLenPx);
          }
        }
      } else if (lanes >= 2) {
        // Double solid yellow centerline
        const centerX = (bikeLeftM + revCount * LANE_WIDTH_METERS) * pxPerMeterX;
        const leftStripeX = centerX - gapPx * 0.5 - lineWidthPx;
        const rightStripeX = centerX + gapPx * 0.5;
        ctx.fillRect(leftStripeX, 0, lineWidthPx, heightPx);
        ctx.fillRect(rightStripeX, 0, lineWidthPx, heightPx);
        rCtx.fillRect(leftStripeX, 0, lineWidthPx, heightPx);
        rCtx.fillRect(rightStripeX, 0, lineWidthPx, heightPx);
      }
    } else {
      // One-way road, divided avenue carriageway, highway, or ramp:
      // solid yellow left outer edge line + solid white right outer edge line
      ctx.fillStyle = '#facc15';
      rCtx.fillStyle = 'rgb(160, 160, 160)';
      ctx.fillRect(trafficStartPx + 1, 0, edgeLinePx, heightPx);
      rCtx.fillRect(trafficStartPx + 1, 0, edgeLinePx, heightPx);

      ctx.fillStyle = isHighwayOrRamp ? '#f8fafc' : 'rgba(241, 245, 249, 0.92)';
      if (bikeRightM <= 0) {
        ctx.fillRect(trafficEndPx - edgeLinePx - 1, 0, edgeLinePx, heightPx);
        rCtx.fillRect(trafficEndPx - edgeLinePx - 1, 0, edgeLinePx, heightPx);
      }
    }

    // Same-direction lane dividers: HOV double solid white, RapidTO/change=no solid white, or Ontario 3m/9m dashed white
    const dashLenPx = (3.0 / ROAD_TILE_LENGTH_METERS) * heightPx;
    const dashStartY = (heightPx - dashLenPx) * 0.5;

    for (let k = 1; k < lanes; k++) {
      if (bidirectional && !oneway) {
        if (k === revCount || (centerExtra === 1 && k === revCount + 1)) {
          continue;
        }
      }
      const divX = (bikeLeftM + k * LANE_WIDTH_METERS) * pxPerMeterX;
      const isHovBoundary = laneIsHov[k - 1] !== laneIsHov[k];
      const isBusBoundary = laneIsBus[k - 1] !== laneIsBus[k];

      let isNoChange = false;
      if (chgLanesFwd && k >= fwdStartIdx + 1) {
        const jLeft = k - fwdStartIdx - 1;
        const jRight = jLeft + 1;
        const cl = chgLanesFwd[jLeft];
        const cr = chgLanesFwd[jRight];
        if (
          cl === 'no' ||
          cl === 'not_right' ||
          cr === 'no' ||
          cr === 'not_left'
        ) {
          isNoChange = true;
        }
      }

      if (isHovBoundary) {
        // Double solid white HOV buffer lines
        ctx.fillStyle = '#f8fafc';
        rCtx.fillStyle = 'rgb(165, 165, 165)';
        ctx.fillRect(divX - gapPx * 0.65 - lineWidthPx, 0, lineWidthPx, heightPx);
        ctx.fillRect(divX + gapPx * 0.65, 0, lineWidthPx, heightPx);
        rCtx.fillRect(divX - gapPx * 0.65 - lineWidthPx, 0, lineWidthPx, heightPx);
        rCtx.fillRect(divX + gapPx * 0.65, 0, lineWidthPx, heightPx);
      } else if (isBusBoundary || isNoChange) {
        ctx.fillStyle = '#f8fafc';
        rCtx.fillStyle = 'rgb(165, 165, 165)';
        ctx.fillRect(divX - lineWidthPx * 0.5, 0, lineWidthPx, heightPx);
        rCtx.fillRect(divX - lineWidthPx * 0.5, 0, lineWidthPx, heightPx);
      } else {
        ctx.fillStyle = '#f1f5f9';
        rCtx.fillStyle = 'rgb(165, 165, 165)';
        ctx.fillRect(divX - lineWidthPx * 0.5, dashStartY, lineWidthPx, dashLenPx);
        rCtx.fillRect(divX - lineWidthPx * 0.5, dashStartY, lineWidthPx, dashLenPx);
      }
    }

    if (isSchoolZone && lanes >= 2) {
      // Subtle yellow-green curbside dashed advisory accent near school frontages
      ctx.fillStyle = 'rgba(217, 249, 157, 0.25)';
      ctx.fillRect(trafficEndPx - edgeLinePx * 2.2, dashStartY, edgeLinePx * 0.8, dashLenPx);
    }

    const configureTexture = (
      canvas: HTMLCanvasElement,
      isSrgb: boolean,
    ): THREE.CanvasTexture => {
      const tex = new THREE.CanvasTexture(canvas);
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.anisotropy = 8;
      if (isSrgb) {
        tex.colorSpace = THREE.SRGBColorSpace;
      }
      tex.needsUpdate = true;
      return tex;
    };

    const map = configureTexture(albedoCanvas, true);
    const roughnessMap = configureTexture(roughCanvas, false);
    const metalnessMap = configureTexture(metalCanvas, false);

    const material = new THREE.MeshStandardMaterial({
      map,
      roughnessMap,
      metalnessMap,
      roughness: 1.0,
      metalness: 1.0,
    });

    return { map, roughnessMap, metalnessMap, material };
  }
}
