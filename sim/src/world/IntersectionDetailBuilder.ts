import * as THREE from 'three';
import type {
  IntersectionGroup,
  IntersectionGroupApproach,
  MapEdge,
  MedianIsland,
  MedianTransition,
  Vec3Tuple,
} from './MapTypes.ts';

export interface DetailBuffers {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

export interface SignalApproachPlacement {
  anchorPos: THREE.Vector3;
  /** Unit XZ direction that approaching drivers travel (+forward toward intersection). */
  inTravelDirX: number;
  inTravelDirZ: number;
  incomingWidthMeters: number;
  incomingLanes: number;
  hasLeftPriority: boolean;
  /** Width of cross-street corridor for corner sidewalk & ped head placement. */
  crosswalkSpanMeters: number;
}

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const CROSSWALK_DEPTH_METERS = 3.0;
const CROSSWALK_STRIPE_WIDTH_METERS = 0.5;
const CROSSWALK_STRIPE_PITCH_METERS = 1.1;
const STOP_BAR_DEPTH_METERS = 0.6;
const STOP_BAR_CLEARANCE_METERS = 1.5;

export function createDetailBuffers(): DetailBuffers {
  return { positions: [], normals: [], uvs: [], indices: [] };
}

export function buffersToMeshGeometry(
  buffers: DetailBuffers,
  planarUvScale = 0,
): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(buffers.positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(buffers.normals, 3));
  if (planarUvScale > 0) {
    const uvOut = new Float32Array((buffers.positions.length / 3) * 2);
    for (let i = 0, j = 0; i < buffers.positions.length; i += 3, j += 2) {
      uvOut[j] = buffers.positions[i]! * planarUvScale;
      uvOut[j + 1] = buffers.positions[i + 2]! * planarUvScale;
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uvOut, 2));
  } else {
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(buffers.uvs, 2));
  }
  geo.setIndex(buffers.indices);
  geo.computeBoundingSphere();
  return geo;
}

export function appendQuadToBuffers(
  target: DetailBuffers,
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  d: THREE.Vector3,
  normal: THREE.Vector3,
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
  for (let i = 0; i < 4; i++) {
    target.normals.push(normal.x, normal.y, normal.z);
  }
  target.uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
  target.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

export interface LiveSplitEndpointCapture {
  cutPt: THREE.Vector3;
  leftPt: THREE.Vector3;
  rightPt: THREE.Vector3;
  outDir: THREE.Vector3;
  isTrunk: boolean;
  lanes: number;
  reverseLanes: number;
  width: number;
}

/**
 * Generates intersection-box asphalt aprons, ladder crosswalks, curved left-turn
 * guide arcs, turn-lane pavement arrows, raised concrete median islands & corner
 * sidewalk pads, and animated 3D traffic + pedestrian countdown signals.
 */
export class IntersectionDetailBuilder {
  private readonly whitePaintMaterial: THREE.MeshStandardMaterial;
  private readonly yellowPaintMaterial: THREE.MeshStandardMaterial;
  private readonly concreteTopMaterial: THREE.MeshStandardMaterial;
  private readonly concreteSideMaterial: THREE.MeshStandardMaterial;
  private readonly poleSteelMaterial: THREE.MeshStandardMaterial;
  private readonly housingBlackMaterial: THREE.MeshStandardMaterial;
  private readonly backplateYellowMaterial: THREE.MeshStandardMaterial;

  private readonly arrowMaterials = new Map<
    string,
    { texture: THREE.CanvasTexture; material: THREE.MeshStandardMaterial }
  >();

  // Pooled phase-driven signal lens materials (2 axes x 6 lens states)
  private readonly axisAGreen: THREE.MeshBasicMaterial;
  private readonly axisAAmber: THREE.MeshBasicMaterial;
  private readonly axisARed: THREE.MeshBasicMaterial;
  private readonly axisALeftGreen: THREE.MeshBasicMaterial;
  private readonly axisAPedWalk: THREE.MeshBasicMaterial;
  private readonly axisAPedWait: THREE.MeshBasicMaterial;

  private readonly axisBGreen: THREE.MeshBasicMaterial;
  private readonly axisBAmber: THREE.MeshBasicMaterial;
  private readonly axisBRed: THREE.MeshBasicMaterial;
  private readonly axisBLeftGreen: THREE.MeshBasicMaterial;
  private readonly axisBPedWalk: THREE.MeshBasicMaterial;
  private readonly axisBPedWait: THREE.MeshBasicMaterial;

  private readonly ownedTextures: THREE.CanvasTexture[] = [];

  constructor() {
    this.whitePaintMaterial = new THREE.MeshStandardMaterial({
      color: 0xf8fafc,
      roughness: 0.62,
      metalness: 0.02,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    this.yellowPaintMaterial = new THREE.MeshStandardMaterial({
      color: 0xfacc15,
      roughness: 0.65,
      metalness: 0.02,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    this.concreteTopMaterial = new THREE.MeshStandardMaterial({
      color: 0x8b95a5,
      roughness: 0.9,
      metalness: 0.03,
    });
    this.concreteSideMaterial = new THREE.MeshStandardMaterial({
      color: 0x647080,
      roughness: 0.92,
      metalness: 0.04,
    });
    this.poleSteelMaterial = new THREE.MeshStandardMaterial({
      color: 0x3b4454,
      roughness: 0.45,
      metalness: 0.65,
    });
    this.housingBlackMaterial = new THREE.MeshStandardMaterial({
      color: 0x11151d,
      roughness: 0.55,
      metalness: 0.25,
    });
    this.backplateYellowMaterial = new THREE.MeshStandardMaterial({
      color: 0xfacc15,
      roughness: 0.45,
      metalness: 0.05,
    });

    const leftArrowTex = this.createLeftPriorityArrowTexture();
    const walkTex = this.createPedestrianIconTexture('walk');
    const waitTex = this.createPedestrianIconTexture('wait');
    this.ownedTextures.push(leftArrowTex, walkTex, waitTex);

    this.axisAGreen = new THREE.MeshBasicMaterial({ color: 0x22c55e, side: THREE.DoubleSide });
    this.axisAAmber = new THREE.MeshBasicMaterial({ color: 0x272010, side: THREE.DoubleSide });
    this.axisARed = new THREE.MeshBasicMaterial({ color: 0x2a1010, side: THREE.DoubleSide });
    this.axisALeftGreen = new THREE.MeshBasicMaterial({
      map: leftArrowTex,
      color: 0x4ade80,
      side: THREE.DoubleSide,
    });
    this.axisAPedWalk = new THREE.MeshBasicMaterial({
      map: walkTex,
      color: 0xffffff,
      side: THREE.DoubleSide,
    });
    this.axisAPedWait = new THREE.MeshBasicMaterial({
      map: waitTex,
      color: 0x4a2010,
      side: THREE.DoubleSide,
    });

    this.axisBGreen = new THREE.MeshBasicMaterial({ color: 0x102818, side: THREE.DoubleSide });
    this.axisBAmber = new THREE.MeshBasicMaterial({ color: 0x272010, side: THREE.DoubleSide });
    this.axisBRed = new THREE.MeshBasicMaterial({ color: 0xef4444, side: THREE.DoubleSide });
    this.axisBLeftGreen = new THREE.MeshBasicMaterial({
      map: leftArrowTex,
      color: 0x163824,
      side: THREE.DoubleSide,
    });
    this.axisBPedWalk = new THREE.MeshBasicMaterial({
      map: walkTex,
      color: 0x22262e,
      side: THREE.DoubleSide,
    });
    this.axisBPedWait = new THREE.MeshBasicMaterial({
      map: waitTex,
      color: 0xff6b2c,
      side: THREE.DoubleSide,
    });
  }

  /**
   * Advances signal & pedestrian phases city-wide using a 28-second cycle
   * (4s advance left-turn priority, 7s through+walk, 3s amber clearance per axis).
   */
  public updateTrafficLights(elapsedSeconds: number): void {
    const cycle = ((elapsedSeconds % 28) + 28) % 28;
    const flashOn = Math.floor(elapsedSeconds * 2.5) % 2 === 0;

    // Axis A: 0-4s advance left, 4-11s green+walk, 11-14s amber+flash wait, 14-28s red
    const aLeft = cycle < 4.5;
    const aGreen = cycle < 11.0;
    const aAmber = cycle >= 11.0 && cycle < 14.0;
    const aRed = cycle >= 14.0;
    const aWalk = cycle >= 4.0 && cycle < 9.5;
    const aFlashWait = cycle >= 9.5 && cycle < 14.0;

    this.axisALeftGreen.color.setHex(aLeft ? 0x4ade80 : 0x142c1d);
    this.axisAGreen.color.setHex(aGreen ? 0x22c55e : 0x102418);
    this.axisAAmber.color.setHex(aAmber ? 0xf59e0b : 0x2b200e);
    this.axisARed.color.setHex(aRed ? 0xef4444 : 0x2d1010);
    this.axisAPedWalk.color.setHex(aWalk ? 0xf8fafc : 0x1f242c);
    this.axisAPedWait.color.setHex(
      aWalk ? 0x35180c : aFlashWait ? (flashOn ? 0xff6b2c : 0x35180c) : 0xff6b2c,
    );

    // Axis B: 14-18s advance left, 18-25s green+walk, 25-28s amber+flash wait, 0-14s red
    const bLeft = cycle >= 14.0 && cycle < 18.5;
    const bGreen = cycle >= 14.0 && cycle < 25.0;
    const bAmber = cycle >= 25.0;
    const bRed = cycle < 14.0;
    const bWalk = cycle >= 18.0 && cycle < 23.5;
    const bFlashWait = cycle >= 23.5 && cycle < 28.0;

    this.axisBLeftGreen.color.setHex(bLeft ? 0x4ade80 : 0x142c1d);
    this.axisBGreen.color.setHex(bGreen ? 0x22c55e : 0x102418);
    this.axisBAmber.color.setHex(bAmber ? 0xf59e0b : 0x2b200e);
    this.axisBRed.color.setHex(bRed ? 0xef4444 : 0x2d1010);
    this.axisBPedWalk.color.setHex(bWalk ? 0xf8fafc : 0x1f242c);
    this.axisBPedWait.color.setHex(
      bWalk ? 0x35180c : bFlashWait ? (flashOn ? 0xff6b2c : 0x35180c) : 0xff6b2c,
    );
  }

  public getWhitePaintMaterial(): THREE.MeshStandardMaterial {
    return this.whitePaintMaterial;
  }

  public getYellowPaintMaterial(): THREE.MeshStandardMaterial {
    return this.yellowPaintMaterial;
  }

  public getConcreteTopMaterial(): THREE.MeshStandardMaterial {
    return this.concreteTopMaterial;
  }

  public getConcreteSideMaterial(): THREE.MeshStandardMaterial {
    return this.concreteSideMaterial;
  }

  /**
   * Switches shared concrete sidewalk/median materials between CAD flat and PBR textured mode.
   */
  public setRealisticConcreteTextures(
    map: THREE.CanvasTexture | null,
    roughnessMap: THREE.CanvasTexture | null,
  ): void {
    const realistic = map !== null;
    this.concreteTopMaterial.map = map;
    this.concreteTopMaterial.roughnessMap = roughnessMap;
    this.concreteTopMaterial.color.setHex(realistic ? 0xdde2e8 : 0x8b95a5);
    this.concreteTopMaterial.needsUpdate = true;

    this.concreteSideMaterial.map = map;
    this.concreteSideMaterial.roughnessMap = roughnessMap;
    this.concreteSideMaterial.color.setHex(realistic ? 0xb8c0ca : 0x647080);
    this.concreteSideMaterial.needsUpdate = true;
  }

  /**
   * Builds unified asphalt apron, continuous ladder crosswalks, incoming stop bars,
   * left-turn curved guide arcs, corner sidewalk pads, and 3D signals for an
   * IntersectionGroup (merged 2-5 corner divided intersection box).
   */
  public appendIntersectionGroup(
    group: IntersectionGroup,
    apronTarget: DetailBuffers,
    bridgeDeckTarget: DetailBuffers | null,
    paintTarget: DetailBuffers,
    concreteTopTarget: DetailBuffers,
    concreteSideTarget: DetailBuffers,
    signalCtx: SignalMeshAccumulator,
    originOffset: THREE.Vector3,
    yellowPaintTarget?: DetailBuffers,
  ): void {
    const cx = group.center[0] - originOffset.x;
    const cy = group.center[1] - originOffset.y;
    const cz = group.center[2] - originOffset.z;
    const apps = group.approaches;
    if (apps.length < 3) {
      return;
    }

    // 1. Unified asphalt perimeter polygon sorted strictly monotonic CCW around center
    const centerVec = new THREE.Vector3(cx, cy, cz);
    const perimeter: THREE.Vector3[] = [];
    for (const app of apps) {
      const outX = app.out_dir_xz[0];
      const outZ = app.out_dir_xz[1];
      const rightX = -outZ;
      const rightZ = outX;
      const px = app.cut_point[0] - originOffset.x;
      const py = app.cut_point[1] - originOffset.y;
      const pz = app.cut_point[2] - originOffset.z;
      const hw = app.half_width;

      const pEarly = new THREE.Vector3(px + rightX * hw, py, pz + rightZ * hw);
      const pLate = new THREE.Vector3(px - rightX * hw, py, pz - rightZ * hw);

      // Guard against inverted or overlapping adjacent approach corners
      const prevPt = perimeter[perimeter.length - 1];
      if (prevPt) {
        const crossPrev =
          (prevPt.z - cz) * (pEarly.x - cx) - (prevPt.x - cx) * (pEarly.z - cz);
        if (crossPrev <= 0.05) {
          const midX = (prevPt.x + pEarly.x) * 0.5;
          const midY = (prevPt.y + pEarly.y) * 0.5;
          const midZ = (prevPt.z + pEarly.z) * 0.5;
          prevPt.set(midX, midY, midZ);
          pEarly.set(midX, midY, midZ);
        }
      }

      const crossSelf =
        (pEarly.z - cz) * (pLate.x - cx) - (pEarly.x - cx) * (pLate.z - cz);
      if (crossSelf > 0.05) {
        perimeter.push(pEarly, pLate);
      }
    }

    if (perimeter.length >= 3) {
      // Strictly sort perimeter vertices monotonically CCW around center so fan triangles never overlap
      perimeter.sort(
        (a, b) =>
          Math.atan2(-(a.z - cz), a.x - cx) - Math.atan2(-(b.z - cz), b.x - cx),
      );
      const lastPt = perimeter[perimeter.length - 1]!;
      const firstPt = perimeter[0]!;
      const crossWrap =
        (lastPt.z - cz) * (firstPt.x - cx) - (lastPt.x - cx) * (firstPt.z - cz);
      if (crossWrap <= 0.05) {
        const midX = (lastPt.x + firstPt.x) * 0.5;
        const midY = (lastPt.y + firstPt.y) * 0.5;
        const midZ = (lastPt.z + firstPt.z) * 0.5;
        lastPt.set(midX, midY, midZ);
        firstPt.set(midX, midY, midZ);
      }

      const centerIdx = apronTarget.positions.length / 3;
      const apronDrop = -0.004;
      apronTarget.positions.push(cx, cy + apronDrop, cz);
      apronTarget.normals.push(0, 1, 0);
      apronTarget.uvs.push(0.5, 0.5);
      for (const p of perimeter) {
        apronTarget.positions.push(p.x, p.y + apronDrop, p.z);
        apronTarget.normals.push(0, 1, 0);
        apronTarget.uvs.push(0.5, 0.5);
      }
      const n = perimeter.length;
      for (let i = 0; i < n; i++) {
        const next = (i + 1) % n;
        const vA = perimeter[i]!;
        const vB = perimeter[next]!;
        const windingY = (vA.z - cz) * (vB.x - cx) - (vA.x - cx) * (vB.z - cz);
        if (windingY > 1e-3) {
          apronTarget.indices.push(centerIdx, centerIdx + 1 + i, centerIdx + 1 + next);
        }
      }

      if (bridgeDeckTarget) {
        const deckThick = 0.8;
        const bIdx = bridgeDeckTarget.positions.length / 3;
        bridgeDeckTarget.positions.push(cx, cy - deckThick, cz);
        bridgeDeckTarget.normals.push(0, -1, 0);
        bridgeDeckTarget.uvs.push(0.5, 0.5);
        for (const p of perimeter) {
          bridgeDeckTarget.positions.push(p.x, p.y - deckThick, p.z);
          bridgeDeckTarget.normals.push(0, -1, 0);
          bridgeDeckTarget.uvs.push(0.5, 0.5);
        }
        for (let i = 0; i < n; i++) {
          const next = (i + 1) % n;
          const vA = perimeter[i]!;
          const vB = perimeter[next]!;
          const windingY = (vA.z - cz) * (vB.x - cx) - (vA.x - cx) * (vB.z - cz);
          if (windingY > 1e-3) {
            bridgeDeckTarget.indices.push(bIdx, bIdx + 1 + next, bIdx + 1 + i);
          }
        }
      }
    }

    const surfaceSampler = (lx: number, lz: number, fallbackY: number): number =>
      this.sampleFanY(centerVec, perimeter, lx, lz, fallbackY);

    // Group approaches by physical corridor leg_id
    const legsMap = new Map<number, IntersectionGroupApproach[]>();
    for (const app of apps) {
      let list = legsMap.get(app.leg_id);
      if (!list) {
        list = [];
        legsMap.set(app.leg_id, list);
      }
      list.push(app);
    }
    const legs = Array.from(legsMap.values());
    const hasStopOrCrosswalk = group.signalized || group.stop_controlled || group.has_crosswalks;

    // 2. Curved solid concrete corner sidewalks, seamless curved crosswalks & signals
    this.appendUnifiedLegsSidewalksAndCrosswalks(
      group.center,
      apps,
      legs,
      apronTarget,
      paintTarget,
      concreteTopTarget,
      concreteSideTarget,
      signalCtx,
      surfaceSampler,
      originOffset,
      {
        buildSidewalks: group.layer === 0 && hasStopOrCrosswalk,
        buildCrosswalks: group.has_crosswalks,
        buildSignals: group.layer === 0 && group.signalized,
        buildCollarApron: hasStopOrCrosswalk,
        ...(yellowPaintTarget ? { yellowPaintTarget } : {}),
      },
    );

    // 3. Solid white stop bars on incoming legs (just behind cut_point on textured road)
    if (group.signalized || group.stop_controlled) {
      for (const app of apps) {
        if (!app.is_incoming) {
          continue;
        }
        const cut = new THREE.Vector3(
          app.cut_point[0],
          app.cut_point[1],
          app.cut_point[2],
        );
        const outDir = new THREE.Vector2(app.out_dir_xz[0], app.out_dir_xz[1]).normalize();
        const incomingLanes = app.bidirectional
          ? Math.max(1, app.forward_lanes)
          : Math.max(1, app.lanes);
        this.appendStopBarQuadAtCut(
          paintTarget,
          cut,
          outDir,
          app.half_width,
          app.bidirectional,
          incomingLanes,
          app.lanes,
          originOffset,
        );
      }
    }

    // 4. Convergent curved dashed left-turn guide arcs extending tightly from each leg's middle island
    if (group.signalized && legs.length >= 3) {
      this.appendGroupedLeftTurnGuideArcs(paintTarget, legs, surfaceSampler, originOffset);
    }
  }

  /**
   * Renders a smooth Cubic Hermite transition asphalt & lane-marking wedge connecting
   * a bidirectional trunk road cleanly with two separated oneway divided carriageways.
   */
  public appendMedianSplitTransition(
    mt: MedianTransition,
    apronTarget: DetailBuffers,
    whitePaintTarget: DetailBuffers,
    yellowPaintTarget: DetailBuffers,
    originOffset: THREE.Vector3,
    liveCaptures?: LiveSplitEndpointCapture[],
  ): void {
    if (mt.branches.length < 2) {
      return;
    }

    const trunk = mt.trunk;
    let tPos = new THREE.Vector3(
      trunk.cut_point[0] - originOffset.x,
      trunk.cut_point[1] - originOffset.y,
      trunk.cut_point[2] - originOffset.z,
    );
    let tOutX = trunk.out_dir_xz[0];
    let tOutZ = trunk.out_dir_xz[1];

    const liveTrunk = liveCaptures?.find((c) => c.isTrunk);
    if (liveTrunk) {
      tPos = liveTrunk.cutPt.clone().sub(originOffset);
      tOutX = liveTrunk.outDir.x;
      tOutZ = liveTrunk.outDir.z;
    }

    // Unit XZ vectors in the frame facing FROM trunk INTO the median split
    const inX = -tOutX;
    const inZ = -tOutZ;
    // Right relative to facing INTO split: (-inZ, inX)
    const rightX = -inZ;
    const rightZ = inX;

    const halfWT = (liveTrunk ? liveTrunk.width : trunk.width_m) * 0.5;
    let trunkL = tPos.clone().addScaledVector(new THREE.Vector3(rightX, 0, rightZ), -halfWT);
    let trunkR = tPos.clone().addScaledVector(new THREE.Vector3(rightX, 0, rightZ), halfWT);
    if (liveTrunk) {
      const lp = liveTrunk.leftPt.clone().sub(originOffset);
      const rp = liveTrunk.rightPt.clone().sub(originOffset);
      const dL = (lp.x - tPos.x) * rightX + (lp.z - tPos.z) * rightZ;
      const dR = (rp.x - tPos.x) * rightX + (rp.z - tPos.z) * rightZ;
      trunkL = dL <= dR ? lp : rp;
      trunkR = dL <= dR ? rp : lp;
    }

    const b0 = mt.branches[0]!;
    const b1 = mt.branches[1]!;
    const proj0 =
      (b0.cut_point[0] - originOffset.x - tPos.x) * rightX +
      (b0.cut_point[2] - originOffset.z - tPos.z) * rightZ;
    const proj1 =
      (b1.cut_point[0] - originOffset.x - tPos.x) * rightX +
      (b1.cut_point[2] - originOffset.z - tPos.z) * rightZ;

    const bLeft = proj0 <= proj1 ? b0 : b1;
    const bRight = proj0 <= proj1 ? b1 : b0;

    // Compute exact double-yellow / TWLTL split offset matching RoadMeshBuilder's trunk texture
    const totalLanes = Math.max(1, trunk.lanes);
    const bothWays = trunk.lanes_both_ways && trunk.lanes_both_ways > 0 ? 1 : 0;
    const leftDirLanes = trunk.u_at_split
      ? Math.max(1, totalLanes - Math.max(1, trunk.reverse_lanes) - bothWays)
      : Math.max(1, trunk.reverse_lanes);
    let yellowFrac = leftDirLanes / totalLanes;
    if (bothWays === 1) {
      if (bRight.lanes > bLeft.lanes) {
        yellowFrac = leftDirLanes / totalLanes;
      } else if (bLeft.lanes > bRight.lanes) {
        yellowFrac = (leftDirLanes + 1) / totalLanes;
      } else {
        yellowFrac = (leftDirLanes + 0.5) / totalLanes;
      }
    }
    const trunkYellow = new THREE.Vector3().lerpVectors(trunkL, trunkR, yellowFrac);
    const yellowOffsetAlongTrunkRight =
      (trunkYellow.x - tPos.x) * rightX + (trunkYellow.z - tPos.z) * rightZ;
    const trunkYellowL = trunkYellow
      .clone()
      .addScaledVector(new THREE.Vector3(rightX, 0, rightZ), -0.11);
    const trunkYellowR = trunkYellow
      .clone()
      .addScaledVector(new THREE.Vector3(rightX, 0, rightZ), 0.11);

    const findLiveBranch = (b: typeof bLeft): LiveSplitEndpointCapture | undefined => {
      if (!liveCaptures) {
        return undefined;
      }
      let best: LiveSplitEndpointCapture | undefined;
      let bestD2 = 36.0;
      for (const cap of liveCaptures) {
        if (cap.isTrunk) {
          continue;
        }
        const dx = cap.cutPt.x - b.cut_point[0];
        const dz = cap.cutPt.z - b.cut_point[2];
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = cap;
        }
      }
      return best;
    };

    const extractBranchEdges = (b: typeof bLeft, expectLeftSide: boolean) => {
      const liveB = findLiveBranch(b);
      const c = liveB
        ? liveB.cutPt.clone().sub(originOffset)
        : new THREE.Vector3(
            b.cut_point[0] - originOffset.x,
            b.cut_point[1] - originOffset.y,
            b.cut_point[2] - originOffset.z,
          );
      const bx = liveB ? liveB.outDir.x : b.out_dir_xz[0];
      const bz = liveB ? liveB.outDir.z : b.out_dir_xz[1];
      const brX = -bz;
      const brZ = bx;
      const hw = (liveB ? liveB.width : b.width_m) * 0.5;
      const candA = liveB
        ? liveB.leftPt.clone().sub(originOffset)
        : new THREE.Vector3(c.x + brX * hw, c.y, c.z + brZ * hw);
      const candB = liveB
        ? liveB.rightPt.clone().sub(originOffset)
        : new THREE.Vector3(c.x - brX * hw, c.y, c.z - brZ * hw);
      const dotA = (candA.x - c.x) * rightX + (candA.z - c.z) * rightZ;
      const dotB = (candB.x - c.x) * rightX + (candB.z - c.z) * rightZ;
      const outer = expectLeftSide
        ? (dotA <= dotB ? candA : candB)
        : (dotA >= dotB ? candA : candB);
      const inner = expectLeftSide
        ? (dotA <= dotB ? candB : candA)
        : (dotA >= dotB ? candB : candA);
      const inwardDir = new THREE.Vector3().subVectors(c, inner);
      if (inwardDir.lengthSq() > 1e-6) {
        inwardDir.normalize();
      } else {
        inwardDir.set(expectLeftSide ? -rightX : rightX, 0, expectLeftSide ? -rightZ : rightZ);
      }
      const yellowLineAnchor = inner.clone().addScaledVector(inwardDir, 0.11);
      return {
        outer,
        inner,
        yellowLineAnchor,
        dir: new THREE.Vector3(bx, 0, bz),
        lanes: Math.max(1, liveB ? liveB.lanes : b.lanes),
      };
    };

    const brL = extractBranchEdges(bLeft, true);
    const brR = extractBranchEdges(bRight, false);
    const dirT = new THREE.Vector3(inX, 0, inZ);
    // Pure endpoint tangents so trunk & branch connect with zero shear corner or diagonal kink
    const endDirL = brL.dir.clone().normalize();
    const endDirR = brR.dir.clone().normalize();

    const tanScaleL = Math.max(4.0, trunkL.distanceTo(brL.outer)) * 0.44;
    const tanScaleR = Math.max(4.0, trunkR.distanceTo(brR.outer)) * 0.44;
    const tanScaleMid = Math.max(4.0, tPos.distanceTo(brL.inner)) * 0.44;

    const evalTransitionPt = (
      p0: THREE.Vector3,
      d0: THREE.Vector3,
      p1: THREE.Vector3,
      d1: THREE.Vector3,
      scale: number,
      t: number,
    ): THREE.Vector3 => {
      // Keep collinear arterial splits strictly linear so lane dividers & yellow gores never S-bend
      if (d0.dot(d1) >= 0.95) {
        return new THREE.Vector3().lerpVectors(p0, p1, t);
      }
      const t2 = t * t;
      const t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;
      return new THREE.Vector3(
        h00 * p0.x + h10 * d0.x * scale + h01 * p1.x + h11 * d1.x * scale,
        p0.y * (1 - t) + p1.y * t,
        h00 * p0.z + h10 * d0.z * scale + h01 * p1.z + h11 * d1.z * scale,
      );
    };

    const steps = 24;
    const outerL: THREE.Vector3[] = [];
    const innerL: THREE.Vector3[] = [];
    const yellowL: THREE.Vector3[] = [];
    const outerR: THREE.Vector3[] = [];
    const innerR: THREE.Vector3[] = [];
    const yellowR: THREE.Vector3[] = [];
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const oL = evalTransitionPt(trunkL, dirT, brL.outer, endDirL, tanScaleL, t);
      const iL = evalTransitionPt(trunkYellow, dirT, brL.inner, endDirL, tanScaleMid, t);
      const yL = evalTransitionPt(trunkYellowL, dirT, brL.yellowLineAnchor, endDirL, tanScaleMid, t);
      const iR = evalTransitionPt(trunkYellow, dirT, brR.inner, endDirR, tanScaleMid, t);
      const yR = evalTransitionPt(trunkYellowR, dirT, brR.yellowLineAnchor, endDirR, tanScaleMid, t);
      const oR = evalTransitionPt(trunkR, dirT, brR.outer, endDirR, tanScaleR, t);

      // Guard lateral ordering along trunk right axis so converging stripes never cross into an 'X'
      if (k > 0) {
        const projIL = (iL.x - tPos.x) * rightX + (iL.z - tPos.z) * rightZ;
        const projIR = (iR.x - tPos.x) * rightX + (iR.z - tPos.z) * rightZ;
        if (projIL > projIR) {
          const midP = 0.5 * (projIL + projIR);
          const corrL = midP - 0.02 - projIL;
          const corrR = midP + 0.02 - projIR;
          iL.x += rightX * corrL;
          iL.z += rightZ * corrL;
          yL.x += rightX * corrL;
          yL.z += rightZ * corrL;
          iR.x += rightX * corrR;
          iR.z += rightZ * corrR;
          yR.x += rightX * corrR;
          yR.z += rightZ * corrR;
        }
      }

      outerL.push(oL);
      innerL.push(iL);
      yellowL.push(yL);
      innerR.push(iR);
      yellowR.push(yR);
      outerR.push(oR);
    }

    const paintLift = 0.018;
    const emitLineStrip = (
      target: DetailBuffers,
      pts: THREE.Vector3[],
      halfWidthLine: number,
      dashed = false,
    ) => {
      let cumDist = 0;
      for (let k = 0; k < pts.length - 1; k++) {
        const a = pts[k]!;
        const b = pts[k + 1]!;
        const d = new THREE.Vector3(b.x - a.x, 0, b.z - a.z);
        const segLen = d.length();
        if (segLen < 1e-3) {
          continue;
        }
        const midS = cumDist + segLen * 0.5;
        cumDist += segLen;
        // Match RoadMeshBuilder's Ontario 3m/9m dashed lane divider cycle
        if (dashed && midS % 9.0 >= 3.0) {
          continue;
        }
        d.multiplyScalar(1 / segLen);
        const rx = -d.z * halfWidthLine;
        const rz = d.x * halfWidthLine;
        appendQuadToBuffers(
          target,
          new THREE.Vector3(a.x - rx, a.y + paintLift, a.z - rz),
          new THREE.Vector3(a.x + rx, a.y + paintLift, a.z + rz),
          new THREE.Vector3(b.x + rx, b.y + paintLift, b.z + rz),
          new THREE.Vector3(b.x - rx, b.y + paintLift, b.z - rz),
          WORLD_UP,
        );
      }
    };

    const emitSafeWedgeQuad = (
      a: THREE.Vector3,
      b: THREE.Vector3,
      c: THREE.Vector3,
      d: THREE.Vector3,
    ) => {
      // Ensure +Y normal regardless of orientation
      const crossY = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
      if (crossY >= 0) {
        appendQuadToBuffers(apronTarget, a, b, c, d, WORLD_UP);
      } else {
        appendQuadToBuffers(apronTarget, a, d, c, b, WORLD_UP);
      }
    };

    for (let k = 0; k < steps; k++) {
      emitSafeWedgeQuad(outerL[k]!, innerL[k]!, innerL[k + 1]!, outerL[k + 1]!);
      emitSafeWedgeQuad(innerR[k]!, outerR[k]!, outerR[k + 1]!, innerR[k + 1]!);
      if (k >= 1) {
        emitSafeWedgeQuad(innerL[k]!, innerR[k]!, innerR[k + 1]!, innerL[k + 1]!);
      } else {
        const triBase = apronTarget.positions.length / 3;
        const v0 = innerL[0]!;
        const v1 = innerL[1]!;
        const v2 = innerR[1]!;
        apronTarget.positions.push(
          v0.x,
          v0.y - 0.004,
          v0.z,
          v1.x,
          v1.y - 0.004,
          v1.z,
          v2.x,
          v2.y - 0.004,
          v2.z,
        );
        apronTarget.normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
        apronTarget.uvs.push(0.5, 0.5, 0.5, 0.5, 0.5, 0.5);
        const wY = (v1.z - v0.z) * (v2.x - v0.x) - (v1.x - v0.x) * (v2.z - v0.z);
        if (wY >= 0) {
          apronTarget.indices.push(triBase, triBase + 1, triBase + 2);
        } else {
          apronTarget.indices.push(triBase, triBase + 2, triBase + 1);
        }
      }
    }

    // Outer white edge lines & kink-free inner converging yellow stripes
    emitLineStrip(whitePaintTarget, outerL, 0.065, false);
    emitLineStrip(whitePaintTarget, outerR, 0.065, false);
    emitLineStrip(yellowPaintTarget, yellowL, 0.075, false);
    emitLineStrip(yellowPaintTarget, yellowR, 0.075, false);

    // Ontario OTM diagonal parallel yellow hatching across dividing median gore (never inverted chevrons)
    const goreCenters: THREE.Vector3[] = [];
    const goreCumDists: number[] = [0];
    for (let k = 0; k <= steps; k++) {
      const m = new THREE.Vector3().lerpVectors(yellowL[k]!, yellowR[k]!, 0.5);
      goreCenters.push(m);
      if (k > 0) {
        goreCumDists.push(goreCumDists[k - 1]! + goreCenters[k - 1]!.distanceTo(m));
      }
    }
    const sampleOnGore = (pts: THREE.Vector3[], sTarget: number): THREE.Vector3 => {
      const maxS = goreCumDists[steps] ?? 0;
      const s = THREE.MathUtils.clamp(sTarget, 0, maxS);
      for (let i = 0; i < steps; i++) {
        const d0 = goreCumDists[i]!;
        const d1 = goreCumDists[i + 1]!;
        if (s <= d1 || i === steps - 1) {
          const span = d1 - d0;
          const a = span > 1e-5 ? THREE.MathUtils.clamp((s - d0) / span, 0, 1) : 0;
          return new THREE.Vector3().lerpVectors(pts[i]!, pts[i + 1]!, a);
        }
      }
      return pts[steps]!.clone();
    };
    const totalGoreDist = goreCumDists[steps] ?? 0;
    for (let d = 1.6; d <= totalGoreDist - 0.8; d += 2.2) {
      const pL0 = sampleOnGore(yellowL, d);
      const pR0 = sampleOnGore(yellowR, d);
      const goreW = pL0.distanceTo(pR0);
      if (goreW < 0.75) {
        continue;
      }
      const shift = Math.min(1.6, goreW * 0.36);
      const sStart = THREE.MathUtils.clamp(d - shift, 0.9, totalGoreDist - 0.35);
      const sEnd = THREE.MathUtils.clamp(d + shift, 0.9, totalGoreDist - 0.35);
      const barStart = new THREE.Vector3().lerpVectors(
        sampleOnGore(yellowL, sStart),
        sampleOnGore(yellowR, sStart),
        0.08,
      );
      const barEnd = new THREE.Vector3().lerpVectors(
        sampleOnGore(yellowL, sEnd),
        sampleOnGore(yellowR, sEnd),
        0.92,
      );
      if (barStart.distanceTo(barEnd) > 0.35) {
        emitLineStrip(yellowPaintTarget, [barStart, barEnd], 0.11, false);
      }
    }

    // Linear, constant-width lane dividers measured outward from the inner median/yellow line:
    // Through lanes run straight 1:1 into the trunk lanes; extra outer turn-bay lanes taper
    // smoothly off the outer curb wedge without squeezing or bending the through lanes.
    const leftTrunkWidth = Math.max(3.0, yellowOffsetAlongTrunkRight - -halfWT);
    const rightTrunkWidth = Math.max(3.0, halfWT - yellowOffsetAlongTrunkRight);
    const leftTrunkLanes = Math.max(1, Math.round(leftTrunkWidth / 3.5));
    const rightTrunkLanes = Math.max(1, Math.round(rightTrunkWidth / 3.5));

    const emitLaneDividers = (
      innerPts: THREE.Vector3[],
      outerPts: THREE.Vector3[],
      branchLanes: number,
      trunkLanesCount: number,
    ) => {
      const wBranch = innerPts[steps]!.distanceTo(outerPts[steps]!);
      const branchLaneW = wBranch / Math.max(1, branchLanes);

      for (let l = 1; l < branchLanes; l++) {
        const divPts: THREE.Vector3[] = [];
        for (let k = 0; k <= steps; k++) {
          const pIn = innerPts[k]!;
          const pOut = outerPts[k]!;
          const wk = pIn.distanceTo(pOut);
          if (wk < 1e-4) {
            continue;
          }
          // When widening for an inner left-turn pocket (branchLanes > trunkLanesCount),
          // anchor through-lane dividers inward from the outer curb so through lanes run
          // linearly 1:1 from trunk -> branch while the left pocket opens along the median.
          const targetFromInner =
            branchLanes > trunkLanesCount
              ? wk - l * branchLaneW
              : wk * (l / branchLanes);

          if (targetFromInner < 0.35 || targetFromInner > wk - 0.3) {
            if (divPts.length >= 2) {
              emitLineStrip(whitePaintTarget, divPts, 0.06, true);
            }
            divPts.length = 0;
            continue;
          }
          divPts.push(new THREE.Vector3().lerpVectors(pIn, pOut, targetFromInner / wk));
        }
        if (divPts.length >= 2) {
          emitLineStrip(whitePaintTarget, divPts, 0.06, true);
        }
      }
    };
    emitLaneDividers(innerL, outerL, brL.lanes, leftTrunkLanes);
    emitLaneDividers(innerR, outerR, brR.lanes, rightTrunkLanes);
  }

  /**
   * Renders a smooth asymmetric one-way lane-drop / lane-addition taper wedge at a
   * degree-2 node where a narrow carriageway widens outward while keeping the inner
   * yellow median edge and all through lanes straight and linear.
   */
  public appendOnewayWidthTransition(
    narrowInnerWorld: THREE.Vector3,
    narrowOuterWorld: THREE.Vector3,
    narrowIntoDirXZ: THREE.Vector3,
    narrowLanes: number,
    wideInnerWorld: THREE.Vector3,
    wideOuterWorld: THREE.Vector3,
    wideIntoDirXZ: THREE.Vector3,
    wideLanes: number,
    apronTarget: DetailBuffers,
    whitePaintTarget: DetailBuffers,
    yellowPaintTarget: DetailBuffers,
    originOffset: THREE.Vector3,
  ): void {
    const pIn0 = narrowInnerWorld.clone().sub(originOffset);
    const pOut0 = narrowOuterWorld.clone().sub(originOffset);
    const pIn1 = wideInnerWorld.clone().sub(originOffset);
    const pOut1 = wideOuterWorld.clone().sub(originOffset);
    const d0 = narrowIntoDirXZ.clone().normalize();
    const d1 = wideIntoDirXZ.clone().normalize();

    const len = Math.max(4.0, pIn0.distanceTo(pIn1));
    const tanScale = len * 0.44;
    const steps = 14;

    const evalHermite = (
      a: THREE.Vector3,
      da: THREE.Vector3,
      b: THREE.Vector3,
      db: THREE.Vector3,
      t: number,
    ): THREE.Vector3 => {
      const t2 = t * t;
      const t3 = t2 * t;
      return new THREE.Vector3(
        (2 * t3 - 3 * t2 + 1) * a.x + (t3 - 2 * t2 + t) * da.x * tanScale + (-2 * t3 + 3 * t2) * b.x + (t3 - t2) * db.x * tanScale,
        a.y * (1 - t) + b.y * t,
        (2 * t3 - 3 * t2 + 1) * a.z + (t3 - 2 * t2 + t) * da.z * tanScale + (-2 * t3 + 3 * t2) * b.z + (t3 - t2) * db.z * tanScale,
      );
    };

    const innerPts: THREE.Vector3[] = [];
    const outerPts: THREE.Vector3[] = [];
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      innerPts.push(evalHermite(pIn0, d0, pIn1, d1, t));
      outerPts.push(evalHermite(pOut0, d0, pOut1, d1, t));
    }

    for (let k = 0; k < steps; k++) {
      const a = innerPts[k]!;
      const b = outerPts[k]!;
      const c = outerPts[k + 1]!;
      const d = innerPts[k + 1]!;
      const crossY = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
      if (crossY >= 0) {
        appendQuadToBuffers(apronTarget, a, b, c, d, WORLD_UP);
      } else {
        appendQuadToBuffers(apronTarget, a, d, c, b, WORLD_UP);
      }
    }

    const paintLift = 0.018;
    const emitStrip = (
      target: DetailBuffers,
      pts: THREE.Vector3[],
      halfW: number,
      dashed: boolean,
    ) => {
      let cumDist = 0;
      for (let k = 0; k < pts.length - 1; k++) {
        const a = pts[k]!;
        const b = pts[k + 1]!;
        const dv = new THREE.Vector3(b.x - a.x, 0, b.z - a.z);
        const segLen = dv.length();
        if (segLen < 1e-3) {
          continue;
        }
        const midS = cumDist + segLen * 0.5;
        cumDist += segLen;
        // Match RoadMeshBuilder's Ontario 3m/9m dashed lane divider cycle
        if (dashed && midS % 9.0 >= 3.0) {
          continue;
        }
        dv.multiplyScalar(1 / segLen);
        const rx = -dv.z * halfW;
        const rz = dv.x * halfW;
        appendQuadToBuffers(
          target,
          new THREE.Vector3(a.x - rx, a.y + paintLift, a.z - rz),
          new THREE.Vector3(a.x + rx, a.y + paintLift, a.z + rz),
          new THREE.Vector3(b.x + rx, b.y + paintLift, b.z + rz),
          new THREE.Vector3(b.x - rx, b.y + paintLift, b.z - rz),
          WORLD_UP,
        );
      }
    };

    // Inner yellow edge & outer white curb flare
    const yellowPts: THREE.Vector3[] = [];
    const whiteOuterPts: THREE.Vector3[] = [];
    for (let k = 0; k <= steps; k++) {
      const pin = innerPts[k]!;
      const pout = outerPts[k]!;
      const span = Math.max(0.5, pin.distanceTo(pout));
      yellowPts.push(new THREE.Vector3().lerpVectors(pin, pout, Math.min(0.2, 0.1 / span)));
      whiteOuterPts.push(new THREE.Vector3().lerpVectors(pout, pin, Math.min(0.2, 0.1 / span)));
    }
    emitStrip(yellowPaintTarget, yellowPts, 0.075, false);
    emitStrip(whitePaintTarget, whiteOuterPts, 0.065, false);

    // Linear interior through lanes stay parallel at constant lane width; outer added lane tapers cleanly
    const minLanes = Math.max(1, Math.min(narrowLanes, wideLanes));
    const maxLanes = Math.max(1, Math.max(narrowLanes, wideLanes));
    const w0 = pIn0.distanceTo(pOut0);
    const w1 = pIn1.distanceTo(pOut1);
    const narrowLaneW = w0 / Math.max(1, narrowLanes);
    const wideLaneW = w1 / Math.max(1, wideLanes);

    for (let l = 1; l < maxLanes; l++) {
      const divPts: THREE.Vector3[] = [];
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const pin = innerPts[k]!;
        const pout = outerPts[k]!;
        const wk = pin.distanceTo(pout);
        if (wk < 1e-4) {
          continue;
        }
        const offset =
          l < minLanes
            ? THREE.MathUtils.lerp(l * narrowLaneW, l * wideLaneW, t)
            : l * wideLaneW;
        if (offset > wk - 0.3) {
          if (divPts.length >= 2) {
            emitStrip(whitePaintTarget, divPts, 0.06, true);
          }
          divPts.length = 0;
          continue;
        }
        divPts.push(new THREE.Vector3().lerpVectors(pin, pout, offset / wk));
      }
      if (divPts.length >= 2) {
        emitStrip(whitePaintTarget, divPts, 0.06, true);
      }
    }
  }

  /**
   * Renders a ladder pedestrian crosswalk across a single-node intersection approach
   * inside `[cutPoint - CROSSWALK_DEPTH - 0.15, cutPoint - 0.15]`.
   */
  public appendSingleApproachCrosswalk(
    paintTarget: DetailBuffers,
    cutPoint: THREE.Vector3,
    outDirXZ: THREE.Vector2,
    halfWidth: number,
    originOffset: THREE.Vector3,
    centerY = cutPoint.y,
    style = 'ladder',
    yellowPaintTarget?: DetailBuffers,
  ): void {
    const outX = outDirXZ.x;
    const outZ = outDirXZ.y;
    const rightX = -outZ;
    const rightZ = outX;

    const spanStart = -halfWidth + 0.15;
    const spanEnd = halfWidth - 0.15;
    const ox = cutPoint.x - originOffset.x;
    const oz = cutPoint.z - originOffset.z;
    const midAlong = -CROSSWALK_DEPTH_METERS * 0.5 - 0.2;
    const pLeft = new THREE.Vector3(
      ox + outX * midAlong + rightX * spanStart,
      0,
      oz + outZ * midAlong + rightZ * spanStart,
    );
    const pRight = new THREE.Vector3(
      ox + outX * midAlong + rightX * spanEnd,
      0,
      oz + outZ * midAlong + rightZ * spanEnd,
    );
    const pCtrl = new THREE.Vector3()
      .addVectors(pLeft, pRight)
      .multiplyScalar(0.5);
    const sampleSlopeY = (lx: number, lz: number): number => {
      const dx = lx - ox;
      const dz = lz - oz;
      const along = dx * outX + dz * outZ;
      const fracIn = THREE.MathUtils.clamp(-along / Math.max(4.0, halfWidth + 4.0), 0, 1);
      return THREE.MathUtils.lerp(cutPoint.y, centerY, fracIn) - originOffset.y;
    };
    this.emitLadderCrosswalkAlongCurve(
      paintTarget,
      pLeft,
      pCtrl,
      pRight,
      CROSSWALK_DEPTH_METERS * 0.5,
      new THREE.Vector3(outX, 0, outZ),
      sampleSlopeY,
      undefined,
      undefined,
      undefined,
      style,
      yellowPaintTarget,
    );
  }

  public appendStopBarQuadAtCut(
    paintTarget: DetailBuffers,
    cutPoint: THREE.Vector3,
    outDirXZ: THREE.Vector2,
    halfWidth: number,
    isBidirectional: boolean,
    incomingLanes: number,
    totalLanes: number,
    originOffset: THREE.Vector3,
    incomingSpanOffset?: [number, number] | null,
  ): void {
    const outX = outDirXZ.x;
    const outZ = outDirXZ.y;
    const rightX = -outZ;
    const rightZ = outX;

    let spanStart = -halfWidth + 0.18;
    let spanEnd = halfWidth - 0.18;
    if (incomingSpanOffset) {
      spanStart = incomingSpanOffset[0] + 0.12;
      spanEnd = incomingSpanOffset[1] - 0.12;
      if (spanEnd <= spanStart + 0.3) {
        return;
      }
    } else if (isBidirectional) {
      const ratio = Math.min(1, Math.max(0.25, incomingLanes / Math.max(1, totalLanes)));
      const splitOffset = -halfWidth + ratio * (halfWidth * 2);
      spanEnd = splitOffset - 0.18;
      if (spanEnd <= spanStart + 0.3) {
        return;
      }
    }

    const startDist = STOP_BAR_CLEARANCE_METERS;
    const endDist = startDist + STOP_BAR_DEPTH_METERS;
    const yLift = 0.02;

    const makePt = (along: number, across: number): THREE.Vector3 =>
      new THREE.Vector3(
        cutPoint.x + outX * along + rightX * across - originOffset.x,
        cutPoint.y + yLift - originOffset.y,
        cutPoint.z + outZ * along + rightZ * across - originOffset.z,
      );

    appendQuadToBuffers(
      paintTarget,
      makePt(startDist, spanStart),
      makePt(startDist, spanEnd),
      makePt(endDist, spanEnd),
      makePt(endDist, spanStart),
      WORLD_UP,
    );
  }

  /**
   * Appends solid white left/right turn-bay channelization and final 15 m approach
   * dividers, opposing TWLTL center arrows, and 8 m / 20 m pavement directional arrows.
   */
  public appendTurnLaneMarkings(
    paintTarget: DetailBuffers,
    arrowBuckets: Map<string, DetailBuffers>,
    trimmedPoints: THREE.Vector3[],
    tangents: THREE.Vector3[],
    rights: THREE.Vector3[],
    normals: THREE.Vector3[],
    distances: number[],
    roadWidth: number,
    totalLanes: number,
    bidirectional: boolean,
    forwardLanes: number,
    reverseLanes: number,
    edge: MapEdge,
    originOffset: THREE.Vector3,
    startCollarMeters = 0,
    endCollarMeters = 0,
    approachMeta?: {
      trafficLeftOffsetM?: number;
      lanesBothWays?: number;
      lanesReversible?: number;
      uIncomingControlled?: boolean;
      vIncomingControlled?: boolean;
      uHasIntersection?: boolean;
      vHasIntersection?: boolean;
      uWidened?: boolean;
      vWidened?: boolean;
      rightPocketLimitM?: number | undefined;
    },
  ): void {
    const totalLen = distances[distances.length - 1] ?? 0;
    if (totalLen < 10.0 || trimmedPoints.length < 2) {
      return;
    }
    const baseStopOffset = STOP_BAR_CLEARANCE_METERS + STOP_BAR_DEPTH_METERS;
    const fwdBayStart = Math.max(0.0, baseStopOffset - endCollarMeters);
    const revBayStart = Math.max(0.0, baseStopOffset - startCollarMeters);
    const lanesBothWays = approachMeta?.lanesBothWays ?? (edge.lanes_both_ways ?? 0);
    const lanesReversible = approachMeta?.lanesReversible ?? (edge.lanes_reversible ?? 0);
    const trafficLeftOffsetM = approachMeta?.trafficLeftOffsetM ?? -roadWidth * 0.5;
    const laneW = 3.5;

    const rawFwdSlots = edge.turn_lanes_forward ?? edge.turn_lanes_fwd ?? null;
    const rawRevSlots = edge.turn_lanes_backward ?? edge.turn_lanes_rev ?? null;

    // Auto-infer LEFT + THROUGH arrows when an approach widened for an intersection bay without explicit turn:lanes tags
    const autoFwdSlots =
      (!rawFwdSlots || rawFwdSlots.length === 0) &&
      approachMeta?.vIncomingControlled &&
      approachMeta?.vWidened &&
      forwardLanes >= 2
        ? ['left', ...Array(Math.max(0, forwardLanes - 1)).fill('through')]
        : rawFwdSlots;
    const autoRevSlots =
      (!rawRevSlots || rawRevSlots.length === 0) &&
      approachMeta?.uIncomingControlled &&
      approachMeta?.uWidened &&
      reverseLanes >= 2
        ? ['left', ...Array(Math.max(0, reverseLanes - 1)).fill('through')]
        : rawRevSlots;

    // 1. Center TWLTL opposing white left-turn bay arrows (midblock @ 24m + intersection approaches @ 8m/20m)
    if (bidirectional && lanesBothWays === 1) {
      this.appendTwltlCenterArrows(
        arrowBuckets,
        trimmedPoints,
        tangents,
        rights,
        normals,
        distances,
        trafficLeftOffsetM + (reverseLanes + 0.5) * laneW,
        originOffset,
        Boolean(approachMeta?.uIncomingControlled || approachMeta?.uHasIntersection),
        Boolean(approachMeta?.vIncomingControlled || approachMeta?.vHasIntersection),
        revBayStart,
        fwdBayStart,
      );
    }

    // 2. Forward travel (u -> v) arriving at node v
    const fwdLaneCount = bidirectional ? Math.max(1, forwardLanes) : Math.max(1, totalLanes);
    const fwdStartSlot = bidirectional
      ? Math.max(1, reverseLanes + lanesBothWays + lanesReversible)
      : 0;
    if ((autoFwdSlots && autoFwdSlots.length > 0) || (fwdLaneCount >= 2 && approachMeta?.vHasIntersection)) {
      this.emitDirectionalApproachMarkings(
        paintTarget,
        arrowBuckets,
        trimmedPoints,
        tangents,
        rights,
        normals,
        distances,
        trafficLeftOffsetM,
        laneW,
        fwdStartSlot,
        fwdLaneCount,
        autoFwdSlots ?? [],
        true,
        originOffset,
        fwdBayStart,
        Boolean(approachMeta?.vHasIntersection),
        approachMeta?.rightPocketLimitM,
      );
    }

    // 3. Reverse travel (v -> u) arriving at node u
    const revLaneCount = Math.max(1, reverseLanes);
    if (
      bidirectional &&
      ((autoRevSlots && autoRevSlots.length > 0) || (revLaneCount >= 2 && approachMeta?.uHasIntersection))
    ) {
      this.emitDirectionalApproachMarkings(
        paintTarget,
        arrowBuckets,
        trimmedPoints,
        tangents,
        rights,
        normals,
        distances,
        trafficLeftOffsetM,
        laneW,
        0,
        revLaneCount,
        autoRevSlots ?? [],
        false,
        originOffset,
        revBayStart,
        Boolean(approachMeta?.uHasIntersection),
      );
    }
  }

  /**
   * Appends dashed white left-turn guide arcs converging cleanly near each leg's center
   * line / median through a single-node signalized intersection.
   */
  public appendSingleNodeLeftTurnGuideArcs(
    paintTarget: DetailBuffers,
    center: Vec3Tuple,
    approaches: Array<{
      cutPoint: THREE.Vector3;
      outDir: THREE.Vector2;
      halfWidth: number;
      lanes: number;
      bidirectional: boolean;
      isIncoming: boolean;
      forwardLanes: number;
      reverseLanes: number;
      turnLanes?: string[] | null | undefined;
      yellowOffsetRight?: number;
    }>,
    originOffset: THREE.Vector3,
  ): void {
    if (approaches.length < 3) {
      return;
    }
    const legAdapters: (IntersectionGroupApproach & { yellowOffsetRight?: number })[] = approaches.map((a, idx) => ({
      edge_id: `sn_${idx}`,
      corner_node: 0,
      leg_id: idx,
      cut_point: [a.cutPoint.x, a.cutPoint.y, a.cutPoint.z],
      out_dir_xz: [a.outDir.x, a.outDir.y],
      leg_dir_xz: [a.outDir.x, a.outDir.y],
      half_width: a.halfWidth,
      lanes: a.lanes,
      forward_lanes: a.forwardLanes,
      reverse_lanes: a.reverseLanes,
      bidirectional: a.bidirectional,
      is_incoming: a.isIncoming,
      turn_lanes: a.turnLanes ?? null,
      ...(a.yellowOffsetRight !== undefined ? { yellowOffsetRight: a.yellowOffsetRight } : {}),
    }));
    const legs = legAdapters.map((a) => [a]);
    const localCenterY = center[1] - originOffset.y + 0.022;
    this.appendGroupedLeftTurnGuideArcs(
      paintTarget,
      legs,
      () => localCenterY,
      originOffset,
    );
  }

  /**
   * Extrudes a uniform-width straight concrete curbed median island polyline with
   * rounded bullnose end caps (avoiding diamond distortion on short/3-point segments).
   */
  public appendMedianIsland(
    island: MedianIsland,
    concreteTop: DetailBuffers,
    concreteSide: DetailBuffers,
    apronTarget: DetailBuffers,
    originOffset: THREE.Vector3,
  ): void {
    const raw = island.centerline;
    if (raw.length < 2) {
      return;
    }
    const pts = raw.map(
      (p) =>
        new THREE.Vector3(
          p[0] - originOffset.x,
          p[1] - originOffset.y,
          p[2] - originOffset.z,
        ),
    );
    const n = pts.length;
    const halfWs: number[] = [];
    const wTops: number[] = [];
    const wBots: number[] = [];
    const gutterHalfWs: number[] = [];
    for (let i = 0; i < n; i++) {
      const concW = island.widths_m?.[i] ?? island.width_m;
      const hw = Math.max(0.22, Math.min(4.2, concW * 0.5));
      const curbBevel = Math.min(0.10, hw * 0.12);
      const gutW =
        island.gutter_widths_m?.[i] ?? (island.width_m <= 4.2 ? island.width_m + 0.56 : 0);
      halfWs.push(hw);
      wTops.push(Math.max(0.16, hw - curbBevel));
      wBots.push(hw);
      gutterHalfWs.push(Math.max(0, gutW * 0.5));
    }
    const curbHeight = 0.17;
    const baseLift = -0.02;
    const apronDrop = -0.005;

    const rights: THREE.Vector3[] = [];
    const dirs: THREE.Vector3[] = [];
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)]!;
      const b = pts[Math.min(n - 1, i + 1)]!;
      const dir = new THREE.Vector3(b.x - a.x, 0, b.z - a.z);
      if (dir.lengthSq() < 1e-8) {
        dir.set(1, 0, 0);
      } else {
        dir.normalize();
      }
      dirs.push(dir);
      rights.push(new THREE.Vector3(-dir.z, 0, dir.x));
    }

    for (let i = 0; i < n - 1; i++) {
      const p0 = pts[i]!;
      const p1 = pts[i + 1]!;
      const r0 = rights[i]!;
      const r1 = rights[i + 1]!;
      const wt0 = wTops[i]!;
      const wt1 = wTops[i + 1]!;
      const wb0 = wBots[i]!;
      const wb1 = wBots[i + 1]!;
      const gh0 = gutterHalfWs[i]!;
      const gh1 = gutterHalfWs[i + 1]!;

      const lTop0 = new THREE.Vector3(p0.x - r0.x * wt0, p0.y + curbHeight, p0.z - r0.z * wt0);
      const rTop0 = new THREE.Vector3(p0.x + r0.x * wt0, p0.y + curbHeight, p0.z + r0.z * wt0);
      const lTop1 = new THREE.Vector3(p1.x - r1.x * wt1, p1.y + curbHeight, p1.z - r1.z * wt1);
      const rTop1 = new THREE.Vector3(p1.x + r1.x * wt1, p1.y + curbHeight, p1.z + r1.z * wt1);

      const lBot0 = new THREE.Vector3(p0.x - r0.x * wb0, p0.y + baseLift, p0.z - r0.z * wb0);
      const rBot0 = new THREE.Vector3(p0.x + r0.x * wb0, p0.y + baseLift, p0.z + r0.z * wb0);
      const lBot1 = new THREE.Vector3(p1.x - r1.x * wb1, p1.y + baseLift, p1.z - r1.z * wb1);
      const rBot1 = new THREE.Vector3(p1.x + r1.x * wb1, p1.y + baseLift, p1.z + r1.z * wb1);

      appendQuadToBuffers(concreteTop, lTop0, rTop0, rTop1, lTop1, WORLD_UP);

      const leftOut = new THREE.Vector3().addVectors(r0, r1);
      if (leftOut.lengthSq() < 1e-8) {
        leftOut.copy(r0);
      }
      leftOut.normalize().negate();
      const rightOut = leftOut.clone().negate();
      appendQuadToBuffers(concreteSide, lBot0, lTop0, lTop1, lBot1, leftOut);
      appendQuadToBuffers(concreteSide, rTop0, rBot0, rBot1, rTop1, rightOut);

      if (gh0 > 0.1 && gh1 > 0.1) {
        const lg0 = new THREE.Vector3(p0.x - r0.x * gh0, p0.y + apronDrop, p0.z - r0.z * gh0);
        const rg0 = new THREE.Vector3(p0.x + r0.x * gh0, p0.y + apronDrop, p0.z + r0.z * gh0);
        const lg1 = new THREE.Vector3(p1.x - r1.x * gh1, p1.y + apronDrop, p1.z - r1.z * gh1);
        const rg1 = new THREE.Vector3(p1.x + r1.x * gh1, p1.y + apronDrop, p1.z + r1.z * gh1);
        appendQuadToBuffers(apronTarget, lg0, rg0, rg1, lg1, WORLD_UP);
      }
    }

    // Flush end apron pads beneath start & end bullnose caps
    const ghStart = gutterHalfWs[0]!;
    if (ghStart > 0.1) {
      const p0 = pts[0]!;
      const r0 = rights[0]!;
      const d0 = dirs[0]!;
      const padLen0 = Math.max(0.55, Math.min(1.15, halfWs[0]! * 0.85) * 1.1);
      const pExt = new THREE.Vector3(p0.x - d0.x * padLen0, p0.y + apronDrop, p0.z - d0.z * padLen0);
      appendQuadToBuffers(
        apronTarget,
        new THREE.Vector3(pExt.x - r0.x * ghStart, pExt.y, pExt.z - r0.z * ghStart),
        new THREE.Vector3(pExt.x + r0.x * ghStart, pExt.y, pExt.z + r0.z * ghStart),
        new THREE.Vector3(p0.x + r0.x * ghStart, p0.y + apronDrop, p0.z + r0.z * ghStart),
        new THREE.Vector3(p0.x - r0.x * ghStart, p0.y + apronDrop, p0.z - r0.z * ghStart),
        WORLD_UP,
      );
    }
    const ghEnd = gutterHalfWs[n - 1]!;
    if (ghEnd > 0.1) {
      const pE = pts[n - 1]!;
      const rE = rights[n - 1]!;
      const dE = dirs[n - 1]!;
      const padLenE = Math.max(0.55, Math.min(1.15, halfWs[n - 1]! * 0.85) * 1.1);
      const pExt = new THREE.Vector3(pE.x + dE.x * padLenE, pE.y + apronDrop, pE.z + dE.z * padLenE);
      appendQuadToBuffers(
        apronTarget,
        new THREE.Vector3(pE.x - rE.x * ghEnd, pE.y + apronDrop, pE.z - rE.z * ghEnd),
        new THREE.Vector3(pE.x + rE.x * ghEnd, pE.y + apronDrop, pE.z + rE.z * ghEnd),
        new THREE.Vector3(pExt.x + rE.x * ghEnd, pExt.y, pExt.z + rE.z * ghEnd),
        new THREE.Vector3(pExt.x - rE.x * ghEnd, pExt.y, pExt.z - rE.z * ghEnd),
        WORLD_UP,
      );
    }

    // Smooth 6-segment semicircular concrete bullnose caps on both median ends
    const capSegs = 6;
    const emitBullnose = (
      anchor: THREE.Vector3,
      right: THREE.Vector3,
      outDir: THREE.Vector3,
      hwEnd: number,
      wTop: number,
      wBot: number,
    ) => {
      const capLen = Math.min(1.15, hwEnd * 0.85);
      const topArc: THREE.Vector3[] = [];
      const botArc: THREE.Vector3[] = [];
      for (let s = 0; s <= capSegs; s++) {
        const theta = -Math.PI * 0.5 + (Math.PI * s) / capSegs;
        const latSin = Math.sin(theta);
        const fwdCos = Math.cos(theta);
        topArc.push(
          new THREE.Vector3(
            anchor.x + right.x * (wTop * latSin) + outDir.x * (capLen * fwdCos),
            anchor.y + curbHeight,
            anchor.z + right.z * (wTop * latSin) + outDir.z * (capLen * fwdCos),
          ),
        );
        botArc.push(
          new THREE.Vector3(
            anchor.x + right.x * (wBot * latSin) + outDir.x * (capLen * 1.05 * fwdCos),
            anchor.y + baseLift,
            anchor.z + right.z * (wBot * latSin) + outDir.z * (capLen * 1.05 * fwdCos),
          ),
        );
      }

      const centerTop = new THREE.Vector3(anchor.x, anchor.y + curbHeight, anchor.z);
      for (let s = 0; s < capSegs; s++) {
        const p0 = topArc[s]!;
        const p1 = topArc[s + 1]!;
        const b0 = botArc[s]!;
        const b1 = botArc[s + 1]!;
        const crossY =
          (p0.z - centerTop.z) * (p1.x - centerTop.x) -
          (p0.x - centerTop.x) * (p1.z - centerTop.z);
        const triBase = concreteTop.positions.length / 3;
        concreteTop.positions.push(
          centerTop.x,
          centerTop.y,
          centerTop.z,
          p0.x,
          p0.y,
          p0.z,
          p1.x,
          p1.y,
          p1.z,
        );
        concreteTop.normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
        concreteTop.uvs.push(0.5, 0.5, 0, 0, 1, 0);
        if (crossY >= 0) {
          concreteTop.indices.push(triBase, triBase + 1, triBase + 2);
        } else {
          concreteTop.indices.push(triBase, triBase + 2, triBase + 1);
        }

        const thetaMid = -Math.PI * 0.5 + (Math.PI * (s + 0.5)) / capSegs;
        const sideNorm = new THREE.Vector3(
          right.x * Math.sin(thetaMid) + outDir.x * Math.cos(thetaMid),
          0,
          right.z * Math.sin(thetaMid) + outDir.z * Math.cos(thetaMid),
        ).normalize();
        appendQuadToBuffers(concreteSide, b0, p0, p1, b1, sideNorm);
      }
    };

    emitBullnose(pts[0]!, rights[0]!, dirs[0]!.clone().negate(), halfWs[0]!, wTops[0]!, wBots[0]!);
    emitBullnose(pts[n - 1]!, rights[n - 1]!, dirs[n - 1]!, halfWs[n - 1]!, wTops[n - 1]!, wBots[n - 1]!);
  }

  /**
   * Builds curved corner sidewalks, curved ladder crosswalks, and optional 3D signal poles
   * for a single-node intersection (using the same corner/crosswalk solver as IntersectionGroup).
   */
  public appendSingleNodeDetails(
    nodePos: Vec3Tuple,
    approaches: Array<{
      cutPoint: THREE.Vector3;
      outDir: THREE.Vector2;
      halfWidth: number;
      lanes: number;
      bidirectional: boolean;
      isIncoming: boolean;
      forwardLanes: number;
      reverseLanes: number;
      turnLanes?: string[] | null | undefined;
      crosswalkMarkings?: string;
    }>,
    apronTarget: DetailBuffers,
    paintTarget: DetailBuffers,
    concreteTop: DetailBuffers,
    concreteSide: DetailBuffers,
    signalCtx: SignalMeshAccumulator,
    originOffset: THREE.Vector3,
    options: {
      hasCrosswalks: boolean;
      hasSignals: boolean;
      hasStopOrControl: boolean;
      yellowPaintTarget?: DetailBuffers;
    },
  ): void {
    // Merge parallel same-corridor carriageways (e.g. divided arterial arms entering single-node crossing)
    const legAdapters: IntersectionGroupApproach[] = [];
    const legDirs: Array<{ dx: number; dz: number; legId: number }> = [];
    for (let idx = 0; idx < approaches.length; idx++) {
      const a = approaches[idx]!;
      let assignedLeg = -1;
      for (const prev of legDirs) {
        const dot = a.outDir.x * prev.dx + a.outDir.y * prev.dz;
        if (dot > 0.78) {
          assignedLeg = prev.legId;
          break;
        }
      }
      if (assignedLeg < 0) {
        assignedLeg = legDirs.length;
        legDirs.push({ dx: a.outDir.x, dz: a.outDir.y, legId: assignedLeg });
      }
      legAdapters.push({
        edge_id: `sn_${idx}`,
        corner_node: 0,
        leg_id: assignedLeg,
        cut_point: [a.cutPoint.x, a.cutPoint.y, a.cutPoint.z],
        out_dir_xz: [a.outDir.x, a.outDir.y],
        leg_dir_xz: [a.outDir.x, a.outDir.y],
        half_width: a.halfWidth,
        lanes: a.lanes,
        forward_lanes: a.forwardLanes,
        reverse_lanes: a.reverseLanes,
        bidirectional: a.bidirectional,
        is_incoming: a.isIncoming,
        turn_lanes: a.turnLanes ?? null,
        ...(a.crosswalkMarkings ? { crosswalk_markings: a.crosswalkMarkings } : {}),
      });
    }

    const legsMap = new Map<number, IntersectionGroupApproach[]>();
    for (const adapter of legAdapters) {
      let arr = legsMap.get(adapter.leg_id);
      if (!arr) {
        arr = [];
        legsMap.set(adapter.leg_id, arr);
      }
      arr.push(adapter);
    }
    const legs = Array.from(legsMap.values());
    const centerVec = new THREE.Vector3(
      nodePos[0] - originOffset.x,
      nodePos[1] - originOffset.y,
      nodePos[2] - originOffset.z,
    );
    const localPerimeter: THREE.Vector3[] = [];
    for (const a of approaches) {
      const rightX = -a.outDir.y;
      const rightZ = a.outDir.x;
      const cx = a.cutPoint.x - originOffset.x;
      const cy = a.cutPoint.y - originOffset.y;
      const cz = a.cutPoint.z - originOffset.z;
      localPerimeter.push(
        new THREE.Vector3(cx + rightX * a.halfWidth, cy, cz + rightZ * a.halfWidth),
        new THREE.Vector3(cx - rightX * a.halfWidth, cy, cz - rightZ * a.halfWidth),
      );
    }
    localPerimeter.sort(
      (a, b) =>
        Math.atan2(-(a.z - centerVec.z), a.x - centerVec.x) -
        Math.atan2(-(b.z - centerVec.z), b.x - centerVec.x),
    );
    const surfaceSampler = (lx: number, lz: number, fallbackY: number): number =>
      localPerimeter.length >= 3
        ? this.sampleFanY(centerVec, localPerimeter, lx, lz, fallbackY)
        : fallbackY;

    this.appendUnifiedLegsSidewalksAndCrosswalks(
      nodePos,
      legAdapters,
      legs,
      apronTarget,
      paintTarget,
      concreteTop,
      concreteSide,
      signalCtx,
      surfaceSampler,
      originOffset,
      {
        buildSidewalks: options.hasSignals || options.hasCrosswalks || options.hasStopOrControl,
        buildCrosswalks: options.hasCrosswalks,
        buildSignals: options.hasSignals,
        buildCollarApron: options.hasSignals || options.hasCrosswalks || options.hasStopOrControl,
        ...(options.yellowPaintTarget ? { yellowPaintTarget: options.yellowPaintTarget } : {}),
      },
    );
  }

  /**
   * Builds concrete sidewalk corners and 3D traffic/pedestrian signal poles for
   * a single-node signalized intersection.
   */
  public appendSingleNodeSignalsAndSidewalks(
    nodePos: Vec3Tuple,
    approaches: Array<{
      cutPoint: THREE.Vector3;
      outDir: THREE.Vector2;
      halfWidth: number;
      lanes: number;
      bidirectional: boolean;
      isIncoming: boolean;
      forwardLanes: number;
      turnLanes?: string[] | null | undefined;
    }>,
    apronTarget: DetailBuffers,
    concreteTop: DetailBuffers,
    concreteSide: DetailBuffers,
    signalCtx: SignalMeshAccumulator,
    originOffset: THREE.Vector3,
  ): void {
    const emptyPaint = createDetailBuffers();
    this.appendSingleNodeDetails(
      nodePos,
      approaches.map((a) => ({ ...a, reverseLanes: Math.max(0, a.lanes - a.forwardLanes) })),
      apronTarget,
      emptyPaint,
      concreteTop,
      concreteSide,
      signalCtx,
      originOffset,
      { hasCrosswalks: false, hasSignals: true, hasStopOrControl: true },
    );
  }

  public getArrowBucketsMaterials(): Map<
    string,
    { texture: THREE.CanvasTexture; material: THREE.MeshStandardMaterial }
  > {
    return this.arrowMaterials;
  }

  public getOrCreateArrowMaterial(arrowKey: string): THREE.MeshStandardMaterial {
    const existing = this.arrowMaterials.get(arrowKey);
    if (existing) {
      return existing.material;
    }

    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 256;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = '#f8fafc';
    ctx.fillStyle = '#f8fafc';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const toks = arrowKey
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s !== 'none');
    const hasLeft = toks.includes('left');
    const hasThrough = toks.includes('through');
    const hasRight = toks.includes('right');
    const hasSlightLeft = toks.includes('slight_left');
    const hasSlightRight = toks.includes('slight_right');
    const hasMergeLeft = toks.includes('merge_to_left');
    const hasMergeRight = toks.includes('merge_to_right');

    // Stem base at bottom (y=232), pointing upward (-Y on canvas = forward)
    const cx = 64;
    const stemBaseY = 232;

    if (
      hasThrough ||
      (!hasLeft &&
        !hasRight &&
        !hasSlightLeft &&
        !hasSlightRight &&
        !hasMergeLeft &&
        !hasMergeRight)
    ) {
      ctx.lineWidth = 14;
      ctx.beginPath();
      ctx.moveTo(cx, stemBaseY);
      ctx.lineTo(cx, 54);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(cx, 22);
      ctx.lineTo(cx - 24, 72);
      ctx.lineTo(cx + 24, 72);
      ctx.closePath();
      ctx.fill();
    }

    if (hasSlightLeft) {
      ctx.lineWidth = 14;
      ctx.beginPath();
      ctx.moveTo(hasThrough ? cx + 8 : cx + 10, stemBaseY);
      ctx.lineTo(hasThrough ? cx + 8 : cx + 10, 148);
      ctx.lineTo(28, 56);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(18, 34);
      ctx.lineTo(20, 82);
      ctx.lineTo(54, 62);
      ctx.closePath();
      ctx.fill();
    }

    if (hasSlightRight) {
      ctx.lineWidth = 14;
      ctx.beginPath();
      ctx.moveTo(hasThrough ? cx - 8 : cx - 10, stemBaseY);
      ctx.lineTo(hasThrough ? cx - 8 : cx - 10, 148);
      ctx.lineTo(100, 56);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(110, 34);
      ctx.lineTo(74, 62);
      ctx.lineTo(108, 82);
      ctx.closePath();
      ctx.fill();
    }

    if (hasMergeLeft) {
      ctx.lineWidth = 14;
      ctx.beginPath();
      ctx.moveTo(88, stemBaseY);
      ctx.quadraticCurveTo(90, 130, 32, 68);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(16, 52);
      ctx.lineTo(26, 98);
      ctx.lineTo(56, 68);
      ctx.closePath();
      ctx.fill();
    }

    if (hasMergeRight) {
      ctx.lineWidth = 14;
      ctx.beginPath();
      ctx.moveTo(40, stemBaseY);
      ctx.quadraticCurveTo(38, 130, 96, 68);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(112, 52);
      ctx.lineTo(72, 68);
      ctx.lineTo(102, 98);
      ctx.closePath();
      ctx.fill();
    }

    if (hasLeft) {
      ctx.lineWidth = 14;
      ctx.beginPath();
      ctx.moveTo(hasThrough ? cx + 10 : cx + 14, stemBaseY);
      ctx.lineTo(hasThrough ? cx + 10 : cx + 14, 140);
      ctx.quadraticCurveTo(
        hasThrough ? cx + 10 : cx + 14,
        92,
        34,
        88,
      );
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(14, 88);
      ctx.lineTo(50, 62);
      ctx.lineTo(50, 114);
      ctx.closePath();
      ctx.fill();
    }

    if (hasRight) {
      ctx.lineWidth = 14;
      ctx.beginPath();
      ctx.moveTo(hasThrough ? cx - 10 : cx - 14, stemBaseY);
      ctx.lineTo(hasThrough ? cx - 10 : cx - 14, 140);
      ctx.quadraticCurveTo(
        hasThrough ? cx - 10 : cx - 14,
        92,
        94,
        88,
      );
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(114, 88);
      ctx.lineTo(78, 62);
      ctx.lineTo(78, 114);
      ctx.closePath();
      ctx.fill();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    texture.needsUpdate = true;

    const material = new THREE.MeshStandardMaterial({
      map: texture,
      transparent: true,
      alphaTest: 0.12,
      depthWrite: false,
      roughness: 0.6,
      metalness: 0.02,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    this.arrowMaterials.set(arrowKey, { texture, material });
    return material;
  }

  public finalizeSignalMeshes(
    parentGroup: THREE.Group,
    acc: SignalMeshAccumulator,
  ): void {
    const add = (buf: DetailBuffers, mat: THREE.Material, castShadow = false) => {
      if (buf.positions.length === 0) {
        return;
      }
      const mesh = new THREE.Mesh(buffersToMeshGeometry(buf), mat);
      mesh.castShadow = castShadow;
      mesh.receiveShadow = !castShadow;
      parentGroup.add(mesh);
    };

    add(acc.poles, this.poleSteelMaterial, true);
    add(acc.housings, this.housingBlackMaterial, true);
    add(acc.backplates, this.backplateYellowMaterial, true);
    add(acc.aGreen, this.axisAGreen);
    add(acc.aAmber, this.axisAAmber);
    add(acc.aRed, this.axisARed);
    add(acc.aLeftGreen, this.axisALeftGreen);
    add(acc.aPedWalk, this.axisAPedWalk);
    add(acc.aPedWait, this.axisAPedWait);
    add(acc.bGreen, this.axisBGreen);
    add(acc.bAmber, this.axisBAmber);
    add(acc.bRed, this.axisBRed);
    add(acc.bLeftGreen, this.axisBLeftGreen);
    add(acc.bPedWalk, this.axisBPedWalk);
    add(acc.bPedWait, this.axisBPedWait);
  }

  public dispose(): void {
    this.whitePaintMaterial.dispose();
    this.yellowPaintMaterial.dispose();
    this.concreteTopMaterial.dispose();
    this.concreteSideMaterial.dispose();
    this.poleSteelMaterial.dispose();
    this.housingBlackMaterial.dispose();
    this.backplateYellowMaterial.dispose();

    this.axisAGreen.dispose();
    this.axisAAmber.dispose();
    this.axisARed.dispose();
    this.axisALeftGreen.dispose();
    this.axisAPedWalk.dispose();
    this.axisAPedWait.dispose();
    this.axisBGreen.dispose();
    this.axisBAmber.dispose();
    this.axisBRed.dispose();
    this.axisBLeftGreen.dispose();
    this.axisBPedWalk.dispose();
    this.axisBPedWait.dispose();

    for (const tex of this.ownedTextures) {
      tex.dispose();
    }
    this.ownedTextures.length = 0;

    for (const set of this.arrowMaterials.values()) {
      set.texture.dispose();
      set.material.dispose();
    }
    this.arrowMaterials.clear();
  }

  private sampleFanY(
    center: THREE.Vector3,
    perimeter: THREE.Vector3[],
    lx: number,
    lz: number,
    fallbackY: number,
  ): number {
    const n = perimeter.length;
    for (let i = 0; i < n; i++) {
      const a = center;
      const b = perimeter[i]!;
      const c = perimeter[(i + 1) % n]!;

      const v0x = c.x - a.x;
      const v0z = c.z - a.z;
      const v1x = b.x - a.x;
      const v1z = b.z - a.z;
      const v2x = lx - a.x;
      const v2z = lz - a.z;

      const dot00 = v0x * v0x + v0z * v0z;
      const dot01 = v0x * v1x + v0z * v1z;
      const dot02 = v0x * v2x + v0z * v2z;
      const dot11 = v1x * v1x + v1z * v1z;
      const dot12 = v1x * v2x + v1z * v2z;
      const denom = dot00 * dot11 - dot01 * dot01;
      if (Math.abs(denom) < 1e-8) {
        continue;
      }
      const inv = 1 / denom;
      const u = (dot11 * dot02 - dot01 * dot12) * inv;
      const v = (dot00 * dot12 - dot01 * dot02) * inv;
      if (u >= -0.08 && v >= -0.08 && u + v <= 1.08) {
        const w = 1 - u - v;
        return w * a.y + u * c.y + v * b.y;
      }
    }
    // Nearest perimeter vertex / center fallback
    let bestD2 = (lx - center.x) ** 2 + (lz - center.z) ** 2;
    let bestY = Number.isFinite(fallbackY) ? center.y : fallbackY;
    for (const p of perimeter) {
      const d2 = (lx - p.x) ** 2 + (lz - p.z) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestY = p.y;
      }
    }
    return bestY;
  }

  private computeLegCrosswalkAndMiddleInfo(
    legApps: IntersectionGroupApproach[],
  ) {
    const lead = legApps[0]!;
    const outX = lead.leg_dir_xz[0];
    const outZ = lead.leg_dir_xz[1];
    const rightX = -outZ;
    const rightZ = outX;

    let avgX = 0;
    let avgY = 0;
    let avgZ = 0;
    for (const a of legApps) {
      avgX += a.cut_point[0];
      avgY += a.cut_point[1];
      avgZ += a.cut_point[2];
    }
    avgX /= legApps.length;
    avgY /= legApps.length;
    avgZ /= legApps.length;

    let minRight = Infinity;
    let maxRight = -Infinity;
    let minInEdge = Infinity;
    let maxInEdge = -Infinity;
    let minOutEdge = Infinity;
    let maxOutEdge = -Infinity;
    let hasOneWayIn = false;
    let hasOneWayOut = false;

    for (const a of legApps) {
      const proj = (a.cut_point[0] - avgX) * rightX + (a.cut_point[2] - avgZ) * rightZ;
      const lo = proj - a.half_width;
      const hi = proj + a.half_width;
      minRight = Math.min(minRight, lo);
      maxRight = Math.max(maxRight, hi);
      if (!a.bidirectional) {
        if (a.is_incoming) {
          hasOneWayIn = true;
          minInEdge = Math.min(minInEdge, lo);
          maxInEdge = Math.max(maxInEdge, hi);
        } else {
          hasOneWayOut = true;
          minOutEdge = Math.min(minOutEdge, lo);
          maxOutEdge = Math.max(maxOutEdge, hi);
        }
      }
    }

    const incomingApps = legApps.filter((a) => a.is_incoming);
    const outgoingApps = legApps.filter((a) => a.bidirectional || !a.is_incoming);
    const mainIncoming = incomingApps[0] ?? lead;

    // Exact lateral projection (along legRight) of the center dividing island / yellow centerline:
    // On divided arterials, midpoint between incoming carriageway's inner edge and outgoing carriageway's inner edge.
    // On bidirectional roads, exact double-yellow split offset.
    let middleAxisProj = (minRight + maxRight) * 0.5;
    if (hasOneWayIn && hasOneWayOut) {
      middleAxisProj =
        maxInEdge <= minOutEdge
          ? (maxInEdge + minOutEdge) * 0.5
          : (minOutEdge >= maxInEdge ? (maxInEdge + minOutEdge) * 0.5 : (maxOutEdge + minInEdge) * 0.5);
    } else if (mainIncoming.bidirectional) {
      const cutProj =
        (mainIncoming.cut_point[0] - avgX) * rightX +
        (mainIncoming.cut_point[2] - avgZ) * rightZ;
      const customYellow = (mainIncoming as IntersectionGroupApproach & { yellowOffsetRight?: number })
        .yellowOffsetRight;
      if (customYellow !== undefined) {
        middleAxisProj = cutProj + customYellow;
      } else {
        const totalLanes = Math.max(1, mainIncoming.lanes);
        const inLanes = Math.max(1, mainIncoming.forward_lanes);
        const ratio = THREE.MathUtils.clamp(inLanes / totalLanes, 0.25, 0.75);
        const halfW = mainIncoming.half_width;
        middleAxisProj = cutProj - halfW + ratio * (halfW * 2);
      }
    }

    const totalLegLanes = legApps.reduce((acc, a) => acc + Math.max(1, a.lanes), 0);
    const hasLeft = Boolean(
      mainIncoming.turn_lanes?.some((t) => t.includes('left')) ||
        totalLegLanes >= 3,
    );

    const styles = legApps
      .map((a) => a.crosswalk_markings)
      .filter((s): s is string => typeof s === 'string' && s.length > 0);
    let crosswalkStyle = 'ladder';
    if (styles.includes('school_ladder')) {
      crosswalkStyle = 'school_ladder';
    } else if (styles.length > 0 && styles.every((s) => s === 'none')) {
      crosswalkStyle = 'none';
    } else if (styles.includes('lines')) {
      crosswalkStyle = 'lines';
    }

    return {
      lead,
      outX,
      outZ,
      rightX,
      rightZ,
      avgX,
      avgY,
      avgZ,
      minRight,
      maxRight,
      middleAxisProj,
      ang: Math.atan2(-outZ, outX),
      mainIncoming,
      hasIncoming: incomingApps.length > 0,
      hasOutgoing: outgoingApps.length > 0,
      hasLeft,
      crosswalkStyle,
    };
  }

  private appendGroupedLeftTurnGuideArcs(
    paintTarget: DetailBuffers,
    legs: IntersectionGroupApproach[][],
    surfaceSampler: (lx: number, lz: number, fallbackY: number) => number,
    originOffset: THREE.Vector3,
    legCrossInnerMidByIndex?: Map<number, { innerAlong: number }>,
  ): void {
    const infos = legs.map((legApps, idx) => ({
      idx,
      ...this.computeLegCrosswalkAndMiddleInfo(legApps),
    }));

    for (const src of infos) {
      if (!src.hasIncoming || !src.hasLeft) {
        continue;
      }

      // Incoming driver travels inward along -src.out; turning left faces (-inTravelZ, inTravelX) => (src.outZ, -src.outX)
      const inTravelX = -src.outX;
      const inTravelZ = -src.outZ;
      const leftTargetX = inTravelZ;
      const leftTargetZ = -inTravelX;

      let bestExit: (typeof infos)[number] | null = null;
      let bestScore = 0.58;
      for (const cand of infos) {
        if (cand.idx === src.idx || !cand.hasOutgoing) {
          continue;
        }
        const dot = cand.outX * leftTargetX + cand.outZ * leftTargetZ;
        if (dot > bestScore) {
          bestScore = dot;
          bestExit = cand;
        }
      }
      if (!bestExit) {
        continue;
      }

      // Convergent middle-island anchors: offset outward toward each turn's respective side
      // (+0.42 toward target leg at origin, -0.42 toward source leg at destination) so the two
      // curves emerge side-by-side right from the middle island without scissors-crossing at the crosswalk.
      const srcBow = THREE.MathUtils.clamp(Math.max(4.0, src.maxRight - src.minRight) * 0.028, 0.18, 0.68);
      const dstBow = THREE.MathUtils.clamp(Math.max(4.0, bestExit.maxRight - bestExit.minRight) * 0.028, 0.18, 0.68);
      const srcInnerAlong =
        legCrossInnerMidByIndex?.get(src.idx)?.innerAlong ??
        -(CROSSWALK_DEPTH_METERS + 0.34 + 0.5 * srcBow);
      const dstInnerAlong =
        legCrossInnerMidByIndex?.get(bestExit.idx)?.innerAlong ??
        -(CROSSWALK_DEPTH_METERS + 0.34 + 0.5 * dstBow);

      const srcLat = src.middleAxisProj + 0.42;
      const dstLat = bestExit.middleAxisProj - 0.42;

      const sx =
        src.avgX + src.outX * srcInnerAlong + src.rightX * srcLat - originOffset.x;
      const sz =
        src.avgZ + src.outZ * srcInnerAlong + src.rightZ * srcLat - originOffset.z;
      const start = new THREE.Vector3(
        sx,
        surfaceSampler(sx, sz, src.avgY - originOffset.y) + 0.024,
        sz,
      );

      const ex =
        bestExit.avgX + bestExit.outX * dstInnerAlong + bestExit.rightX * dstLat - originOffset.x;
      const ez =
        bestExit.avgZ + bestExit.outZ * dstInnerAlong + bestExit.rightZ * dstLat - originOffset.z;
      const end = new THREE.Vector3(
        ex,
        surfaceSampler(ex, ez, bestExit.avgY - originOffset.y) + 0.024,
        ez,
      );

      // Tangent knee: intersection of ray (start + t * inTravel) and (end - s * bestExit.out)
      const denom = inTravelX * bestExit.outZ - inTravelZ * bestExit.outX;
      let ctrl: THREE.Vector3;
      const chord = Math.hypot(end.x - start.x, end.z - start.z);
      if (Math.abs(denom) > 0.2) {
        const dx = end.x - start.x;
        const dz = end.z - start.z;
        const t = (dx * bestExit.outZ - dz * bestExit.outX) / denom;
        if (t > 0.5 && t < Math.min(62, chord * 1.35)) {
          const cxK = start.x + inTravelX * t;
          const czK = start.z + inTravelZ * t;
          ctrl = new THREE.Vector3(
            cxK,
            surfaceSampler(cxK, czK, (start.y + end.y) * 0.5) + 0.024,
            czK,
          );
        } else {
          ctrl = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
        }
      } else {
        ctrl = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
      }

      this.emitDashedBezierArc(paintTarget, start, ctrl, end, 0.15, (lx, lz, fbY) =>
        surfaceSampler(lx, lz, fbY) + 0.024,
      );
    }
  }

  private emitDashedBezierArc(
    paintTarget: DetailBuffers,
    p0: THREE.Vector3,
    p1: THREE.Vector3,
    p2: THREE.Vector3,
    widthMeters: number,
    sampleArcY?: (lx: number, lz: number, fallbackY: number) => number,
  ): void {
    const chord = p0.distanceTo(p2);
    if (chord < 4.0 || chord > 90.0) {
      return;
    }
    const dashCount = Math.max(4, Math.min(14, Math.floor(chord / 2.35)));
    const halfW = widthMeters * 0.5;

    const evalBez = (t: number): THREE.Vector3 => {
      const u = 1 - t;
      const x = u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x;
      const z = u * u * p0.z + 2 * u * t * p1.z + t * t * p2.z;
      const fbY = u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y;
      const y = sampleArcY ? sampleArcY(x, z, fbY) : fbY;
      return new THREE.Vector3(x, y, z);
    };

    for (let i = 0; i < dashCount; i++) {
      const tA = (i + 0.15) / dashCount;
      const tB = (i + 0.65) / dashCount;
      const a = evalBez(tA);
      const b = evalBez(tB);
      const dir = new THREE.Vector3(b.x - a.x, 0, b.z - a.z);
      if (dir.lengthSq() < 1e-6) {
        continue;
      }
      dir.normalize();
      const rx = -dir.z * halfW;
      const rz = dir.x * halfW;
      appendQuadToBuffers(
        paintTarget,
        new THREE.Vector3(a.x - rx, a.y, a.z - rz),
        new THREE.Vector3(a.x + rx, a.y, a.z + rz),
        new THREE.Vector3(b.x + rx, b.y, b.z + rz),
        new THREE.Vector3(b.x - rx, b.y, b.z - rz),
        WORLD_UP,
      );
    }
  }

  private samplePolyFrame(
    points: THREE.Vector3[],
    tangents: THREE.Vector3[],
    rights: THREE.Vector3[],
    normals: THREE.Vector3[],
    distances: number[],
    sTarget: number,
  ): {
    pt: THREE.Vector3;
    tan: THREE.Vector3;
    right: THREE.Vector3;
    norm: THREE.Vector3;
  } {
    const totalLen = distances[distances.length - 1] ?? 0;
    const s = THREE.MathUtils.clamp(sTarget, 0, totalLen);
    for (let i = 0; i < distances.length - 1; i++) {
      const d0 = distances[i]!;
      const d1 = distances[i + 1]!;
      if (s <= d1 || i === distances.length - 2) {
        const seg = d1 - d0;
        const alpha = seg > 1e-6 ? THREE.MathUtils.clamp((s - d0) / seg, 0, 1) : 0;
        return {
          pt: new THREE.Vector3().lerpVectors(points[i]!, points[i + 1]!, alpha),
          tan: new THREE.Vector3().lerpVectors(tangents[i]!, tangents[i + 1]!, alpha).normalize(),
          right: new THREE.Vector3().lerpVectors(rights[i]!, rights[i + 1]!, alpha).normalize(),
          norm: new THREE.Vector3().lerpVectors(normals[i]!, normals[i + 1]!, alpha).normalize(),
        };
      }
    }
    const last = points.length - 1;
    return {
      pt: points[last]!.clone(),
      tan: tangents[last]!.clone(),
      right: rights[last]!.clone(),
      norm: normals[last]!.clone(),
    };
  }

  private emitPavementArrowQuad(
    arrowBuckets: Map<string, DetailBuffers>,
    token: string,
    points: THREE.Vector3[],
    tangents: THREE.Vector3[],
    rights: THREE.Vector3[],
    normals: THREE.Vector3[],
    distances: number[],
    sMid: number,
    latCenter: number,
    forwardDirection: boolean,
    arrowHalfW: number,
    arrowLen: number,
    originOffset: THREE.Vector3,
  ): void {
    this.getOrCreateArrowMaterial(token);
    let bucket = arrowBuckets.get(token);
    if (!bucket) {
      bucket = createDetailBuffers();
      arrowBuckets.set(token, bucket);
    }

    const fMid = this.samplePolyFrame(points, tangents, rights, normals, distances, sMid);
    const travelTan = forwardDirection ? fMid.tan.clone() : fMid.tan.clone().negate();
    const travelRight = new THREE.Vector3().crossVectors(travelTan, fMid.norm).normalize();

    const center = fMid.pt
      .clone()
      .addScaledVector(fMid.right, latCenter)
      .addScaledVector(fMid.norm, 0.015)
      .sub(originOffset);

    const bl = center.clone().addScaledVector(travelTan, -arrowLen * 0.5).addScaledVector(travelRight, -arrowHalfW);
    const br = center.clone().addScaledVector(travelTan, -arrowLen * 0.5).addScaledVector(travelRight, arrowHalfW);
    const tr = center.clone().addScaledVector(travelTan, arrowLen * 0.5).addScaledVector(travelRight, arrowHalfW);
    const tl = center.clone().addScaledVector(travelTan, arrowLen * 0.5).addScaledVector(travelRight, -arrowHalfW);

    const base = bucket.positions.length / 3;
    bucket.positions.push(
      bl.x,
      bl.y,
      bl.z,
      br.x,
      br.y,
      br.z,
      tr.x,
      tr.y,
      tr.z,
      tl.x,
      tl.y,
      tl.z,
    );
    for (let k = 0; k < 4; k++) {
      bucket.normals.push(fMid.norm.x, fMid.norm.y, fMid.norm.z);
    }
    bucket.uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    bucket.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  private appendTwltlCenterArrows(
    arrowBuckets: Map<string, DetailBuffers>,
    points: THREE.Vector3[],
    tangents: THREE.Vector3[],
    rights: THREE.Vector3[],
    normals: THREE.Vector3[],
    distances: number[],
    latCenter: number,
    originOffset: THREE.Vector3,
    uHasIntersection: boolean,
    vHasIntersection: boolean,
    revBayStart: number,
    fwdBayStart: number,
  ): void {
    const totalLen = distances[distances.length - 1] ?? 0;
    const arrowHalfW = 1.02;
    const arrowLen = arrowHalfW * 4.0;

    // Intersection TWLTL LEFT arrows at 8.0m and 20.0m upstream of stop bars
    const placedS: number[] = [];
    if (vHasIntersection) {
      for (const distBack of [fwdBayStart + 8.0, fwdBayStart + 20.0]) {
        const s = totalLen - distBack;
        if (s > arrowLen * 0.5 + 2.0 && s < totalLen - 2.0) {
          this.emitPavementArrowQuad(
            arrowBuckets,
            'left',
            points,
            tangents,
            rights,
            normals,
            distances,
            s,
            latCenter,
            true,
            arrowHalfW,
            arrowLen,
            originOffset,
          );
          placedS.push(s);
        }
      }
    }
    if (uHasIntersection) {
      for (const distBack of [revBayStart + 8.0, revBayStart + 20.0]) {
        const s = distBack;
        if (s > 2.0 && s < totalLen - arrowLen * 0.5 - 2.0) {
          this.emitPavementArrowQuad(
            arrowBuckets,
            'left',
            points,
            tangents,
            rights,
            normals,
            distances,
            s,
            latCenter,
            false,
            arrowHalfW,
            arrowLen,
            originOffset,
          );
          placedS.push(s);
        }
      }
    }

    // Midblock opposing alternating white LEFT arrows every 24m
    const midStart = uHasIntersection ? revBayStart + 28.0 : 12.0;
    const midEnd = vHasIntersection ? totalLen - fwdBayStart - 28.0 : totalLen - 12.0;
    let forwardTurn = true;
    for (let s = midStart; s <= midEnd; s += 24.0) {
      if (placedS.some((p) => Math.abs(p - s) < 7.0)) {
        continue;
      }
      this.emitPavementArrowQuad(
        arrowBuckets,
        'left',
        points,
        tangents,
        rights,
        normals,
        distances,
        s,
        latCenter,
        forwardTurn,
        arrowHalfW,
        arrowLen,
        originOffset,
      );
      const oppS = s + 6.5;
      if (oppS <= midEnd && !placedS.some((p) => Math.abs(p - oppS) < 7.0)) {
        this.emitPavementArrowQuad(
          arrowBuckets,
          'left',
          points,
          tangents,
          rights,
          normals,
          distances,
          oppS,
          latCenter,
          !forwardTurn,
          arrowHalfW,
          arrowLen,
          originOffset,
        );
      }
      forwardTurn = !forwardTurn;
    }
  }

  private emitDirectionalApproachMarkings(
    paintTarget: DetailBuffers,
    arrowBuckets: Map<string, DetailBuffers>,
    points: THREE.Vector3[],
    tangents: THREE.Vector3[],
    rights: THREE.Vector3[],
    normals: THREE.Vector3[],
    distances: number[],
    trafficLeftOffsetM: number,
    laneWidth: number,
    startSlotIdx: number,
    dirLaneCount: number,
    turnSlots: string[],
    arrivingAtEnd: boolean,
    originOffset: THREE.Vector3,
    bayStartOffset = STOP_BAR_CLEARANCE_METERS + STOP_BAR_DEPTH_METERS,
    solidApproachWhite = false,
    rightPocketLimitM?: number,
  ): void {
    const totalLen = distances[distances.length - 1] ?? 0;
    const stopBarOffset = Math.max(0.0, bayStartOffset);

    // 1. Solid white same-direction dividers: 15.0 m before every intersection stop bar,
    //    or longer turn-bay channelization lines up to 28.0 m where left/right bays are tagged.
    const hasLeftBay = turnSlots[0] === 'left' || turnSlots[0] === 'slight_left';
    const hasRightBay =
      dirLaneCount >= 3 &&
      (turnSlots[dirLaneCount - 1] === 'right' || turnSlots[dirLaneCount - 1] === 'slight_right');

    const dividersToSolidify = new Set<number>();
    if (solidApproachWhite && dirLaneCount >= 2) {
      for (let d = 0; d < dirLaneCount - 1; d++) {
        dividersToSolidify.add(d);
      }
    }
    if (dirLaneCount >= 2 && hasLeftBay) {
      dividersToSolidify.add(0);
    }
    if (hasRightBay) {
      dividersToSolidify.add(dirLaneCount - 2);
    }

    for (const localDivIdx of dividersToSolidify) {
      const isRightBayDiv = localDivIdx === dirLaneCount - 2 && hasRightBay;
      const isTurnBayChannel = (localDivIdx === 0 && hasLeftBay) || isRightBayDiv;
      let targetSolidLen = isTurnBayChannel ? 28.0 : 15.0;
      if (isRightBayDiv && rightPocketLimitM !== undefined) {
        targetSolidLen = Math.min(targetSolidLen, Math.max(4.0, rightPocketLimitM - stopBarOffset));
      }
      const lineLen = Math.min(targetSolidLen, Math.max(4.0, totalLen - stopBarOffset - 2.0));
      if (lineLen < 3.0) {
        continue;
      }

      const globalDivIdx = arrivingAtEnd
        ? startSlotIdx + localDivIdx + 1
        : Math.max(1, dirLaneCount - (localDivIdx + 1));
      const latOffset = trafficLeftOffsetM + globalDivIdx * laneWidth;
      const steps = 6;
      const halfLineW = 0.082;

      for (let k = 0; k < steps; k++) {
        const dA = stopBarOffset + (lineLen * k) / steps;
        const dB = stopBarOffset + (lineLen * (k + 1)) / steps;
        const sA = arrivingAtEnd ? totalLen - dB : dA;
        const sB = arrivingAtEnd ? totalLen - dA : dB;
        const fA = this.samplePolyFrame(points, tangents, rights, normals, distances, sA);
        const fB = this.samplePolyFrame(points, tangents, rights, normals, distances, sB);
        const cA = fA.pt.clone().addScaledVector(fA.right, latOffset).addScaledVector(fA.norm, 0.012).sub(originOffset);
        const cB = fB.pt.clone().addScaledVector(fB.right, latOffset).addScaledVector(fB.norm, 0.012).sub(originOffset);
        appendQuadToBuffers(
          paintTarget,
          cA.clone().addScaledVector(fA.right, -halfLineW),
          cA.clone().addScaledVector(fA.right, halfLineW),
          cB.clone().addScaledVector(fB.right, halfLineW),
          cB.clone().addScaledVector(fB.right, -halfLineW),
          fA.norm,
        );
      }
    }

    if (turnSlots.length === 0 || totalLen < 12.5) {
      return;
    }

    // 2. Crisp pavement turn arrows in every tagged lane at 8.0 m and 20.0 m upstream of the stop bar
    const d1 = stopBarOffset + 8.0;
    const d2 = stopBarOffset + 20.0;
    const arrowStations = totalLen >= d2 + 6.5 ? [d1, d2] : [d1];
    const arrowHalfW = Math.min(1.05, laneWidth * 0.32);
    const arrowLen = arrowHalfW * 4.0;

    for (let slot = 0; slot < Math.min(dirLaneCount, turnSlots.length); slot++) {
      const token = turnSlots[slot] ?? 'none';
      if (token === 'none') {
        continue;
      }

      const globalLaneIdx = arrivingAtEnd
        ? startSlotIdx + slot
        : Math.max(0, dirLaneCount - 1 - slot);
      const latCenter = trafficLeftOffsetM + (globalLaneIdx + 0.5) * laneWidth;
      const isRightPocketLane =
        arrivingAtEnd && rightPocketLimitM !== undefined && slot === dirLaneCount - 1 && (token === 'right' || token === 'slight_right');

      for (const distBackRaw of arrowStations) {
        let distBack = distBackRaw;
        if (isRightPocketLane && rightPocketLimitM !== undefined) {
          if (distBack > rightPocketLimitM + 1.0) {
            continue;
          }
          distBack = Math.max(stopBarOffset + 4.5, Math.min(distBack, rightPocketLimitM - arrowHalfW * 1.5));
        }
        if (distBack + arrowLen * 0.5 >= totalLen - 3.5) {
          continue;
        }
        const sMid = arrivingAtEnd ? totalLen - distBack : distBack;
        this.emitPavementArrowQuad(
          arrowBuckets,
          token,
          points,
          tangents,
          rights,
          normals,
          distances,
          sMid,
          latCenter,
          arrivingAtEnd,
          arrowHalfW,
          arrowLen,
          originOffset,
        );
      }
    }
  }

  private emitLadderCrosswalkAlongCurve(
    paintTarget: DetailBuffers,
    pLeft: THREE.Vector3,
    pCtrl: THREE.Vector3,
    pRight: THREE.Vector3,
    halfDepth: number,
    outDirVec: THREE.Vector3,
    sampleSurfaceLocalY: (lx: number, lz: number) => number,
    leftCurbEdgeAtAlong?: (alongLocal: number) => THREE.Vector3 | null,
    rightCurbEdgeAtAlong?: (alongLocal: number) => THREE.Vector3 | null,
    originAnchor?: { x: number; z: number; outX: number; outZ: number },
    style = 'ladder',
    yellowPaintTarget?: DetailBuffers,
  ): void {
    if (style === 'none') {
      return;
    }
    const chord = Math.hypot(pRight.x - pLeft.x, pRight.z - pLeft.z);
    if (chord < 1.4) {
      return;
    }

    const yLift = 0.025;
    const evalBez = (t: number): THREE.Vector3 => {
      const omt = 1 - t;
      return new THREE.Vector3(
        omt * omt * pLeft.x + 2 * omt * t * pCtrl.x + t * t * pRight.x,
        0,
        omt * omt * pLeft.z + 2 * omt * t * pCtrl.z + t * t * pRight.z,
      );
    };

    const sampleCount = Math.max(24, Math.min(64, Math.ceil(chord / 0.65)));
    const centerPts: THREE.Vector3[] = [];
    const cumS: number[] = [0];
    for (let i = 0; i <= sampleCount; i++) {
      const pt = evalBez(i / sampleCount);
      centerPts.push(pt);
      if (i > 0) {
        cumS.push(cumS[i - 1]! + Math.hypot(pt.x - centerPts[i - 1]!.x, pt.z - centerPts[i - 1]!.z));
      }
    }
    const totalLen = cumS[sampleCount] ?? chord;
    if (totalLen < 1.4) {
      return;
    }

    // Build smoothly varying outer (+outDir, road side) & inner (-outDir, intersection side) rails
    const outerRail: THREE.Vector3[] = [];
    const innerRail: THREE.Vector3[] = [];
    const normalsXZ: THREE.Vector3[] = [];

    for (let i = 0; i <= sampleCount; i++) {
      const pPrev = centerPts[Math.max(0, i - 1)]!;
      const pNext = centerPts[Math.min(sampleCount, i + 1)]!;
      const tx = pNext.x - pPrev.x;
      const tz = pNext.z - pPrev.z;
      const tLen = Math.hypot(tx, tz) || 1;
      // Right-handed CW turn from tangent (tx, tz) points (+out) when traveling left -> right along (+right)
      let nx = tz / tLen;
      let nz = -tx / tLen;
      if (nx * outDirVec.x + nz * outDirVec.z < 0) {
        nx = -nx;
        nz = -nz;
      }
      const norm = new THREE.Vector3(nx, 0, nz);
      normalsXZ.push(norm);

      const cPt = centerPts[i]!;
      const oPt = new THREE.Vector3(cPt.x + norm.x * halfDepth, 0, cPt.z + norm.z * halfDepth);
      const iPt = new THREE.Vector3(cPt.x - norm.x * halfDepth, 0, cPt.z - norm.z * halfDepth);

      // Flush-extend rail ends cleanly under adjacent curved concrete sidewalk curb
      if (i === 0 && leftCurbEdgeAtAlong && originAnchor) {
        const oAlong =
          (oPt.x - originAnchor.x) * originAnchor.outX +
          (oPt.z - originAnchor.z) * originAnchor.outZ;
        const iAlong =
          (iPt.x - originAnchor.x) * originAnchor.outX +
          (iPt.z - originAnchor.z) * originAnchor.outZ;
        const snappedO = leftCurbEdgeAtAlong(oAlong);
        const snappedI = leftCurbEdgeAtAlong(iAlong);
        if (snappedO) {
          oPt.copy(snappedO);
        }
        if (snappedI) {
          iPt.copy(snappedI);
        }
      } else if (i === sampleCount && rightCurbEdgeAtAlong && originAnchor) {
        const oAlong =
          (oPt.x - originAnchor.x) * originAnchor.outX +
          (oPt.z - originAnchor.z) * originAnchor.outZ;
        const iAlong =
          (iPt.x - originAnchor.x) * originAnchor.outX +
          (iPt.z - originAnchor.z) * originAnchor.outZ;
        const snappedO = rightCurbEdgeAtAlong(oAlong);
        const snappedI = rightCurbEdgeAtAlong(iAlong);
        if (snappedO) {
          oPt.copy(snappedO);
        }
        if (snappedI) {
          iPt.copy(snappedI);
        }
      }

      oPt.y = sampleSurfaceLocalY(oPt.x, oPt.z) + yLift;
      iPt.y = sampleSurfaceLocalY(iPt.x, iPt.z) + yLift;
      outerRail.push(oPt);
      innerRail.push(iPt);
    }

    // 1. Continuous longitudinal crosswalk rails (white for ladder/lines, high-vis yellow for school crossings)
    const railHalfW = style === 'lines' || style === 'school_ladder' ? 0.11 : 0.085;
    const railTarget =
      style === 'school_ladder' && yellowPaintTarget ? yellowPaintTarget : paintTarget;
    const emitContinuousRail = (railPts: THREE.Vector3[], outwardSign: number) => {
      for (let i = 0; i < railPts.length - 1; i++) {
        const a = railPts[i]!;
        const b = railPts[i + 1]!;
        const nAvg = new THREE.Vector3()
          .addVectors(normalsXZ[i]!, normalsXZ[i + 1]!)
          .normalize()
          .multiplyScalar(outwardSign * railHalfW);
        const aIn = new THREE.Vector3(a.x - nAvg.x, a.y, a.z - nAvg.z);
        const aOut = new THREE.Vector3(a.x + nAvg.x, a.y, a.z + nAvg.z);
        const bOut = new THREE.Vector3(b.x + nAvg.x, b.y, b.z + nAvg.z);
        const bIn = new THREE.Vector3(b.x - nAvg.x, b.y, b.z - nAvg.z);
        appendQuadToBuffers(railTarget, aIn, bIn, bOut, aOut, WORLD_UP);
      }
    };
    emitContinuousRail(outerRail, 1);
    emitContinuousRail(innerRail, -1);

    if (style === 'lines') {
      return;
    }

    // 2. Arc-length uniform zebra rungs perpendicular to the curved path, spanning innerRail -> outerRail
    const sampleOnRailAtS = (rail: THREE.Vector3[], sTarget: number): THREE.Vector3 => {
      const s = THREE.MathUtils.clamp(sTarget, 0, totalLen);
      for (let i = 0; i < sampleCount; i++) {
        const s0 = cumS[i]!;
        const s1 = cumS[i + 1]!;
        if (s <= s1 || i === sampleCount - 1) {
          const span = s1 - s0;
          const a = span > 1e-5 ? THREE.MathUtils.clamp((s - s0) / span, 0, 1) : 0;
          return new THREE.Vector3().lerpVectors(rail[i]!, rail[i + 1]!, a);
        }
      }
      return rail[sampleCount]!.clone();
    };

    const usableStart = 0.35;
    const usableEnd = Math.max(usableStart + 0.5, totalLen - 0.35);
    const usableSpan = usableEnd - usableStart;
    const barCount = Math.max(2, Math.floor(usableSpan / CROSSWALK_STRIPE_PITCH_METERS));
    const pitch = usableSpan / barCount;
    const halfStripe = Math.min(CROSSWALK_STRIPE_WIDTH_METERS * 0.5, pitch * 0.31);

    for (let i = 0; i < barCount; i++) {
      const sMid = usableStart + (i + 0.5) * pitch;
      const s0 = sMid - halfStripe;
      const s1 = sMid + halfStripe;
      const in0 = sampleOnRailAtS(innerRail, s0);
      const in1 = sampleOnRailAtS(innerRail, s1);
      const out0 = sampleOnRailAtS(outerRail, s0);
      const out1 = sampleOnRailAtS(outerRail, s1);
      in0.y = sampleSurfaceLocalY(in0.x, in0.z) + yLift;
      in1.y = sampleSurfaceLocalY(in1.x, in1.z) + yLift;
      out0.y = sampleSurfaceLocalY(out0.x, out0.z) + yLift;
      out1.y = sampleSurfaceLocalY(out1.x, out1.z) + yLift;
      appendQuadToBuffers(paintTarget, in0, in1, out1, out0, WORLD_UP);
    }
  }

  private appendUnifiedLegsSidewalksAndCrosswalks(
    center: Vec3Tuple,
    apps: IntersectionGroupApproach[],
    legs: IntersectionGroupApproach[][],
    apronTarget: DetailBuffers,
    paintTarget: DetailBuffers,
    concreteTop: DetailBuffers,
    concreteSide: DetailBuffers,
    signalCtx: SignalMeshAccumulator,
    surfaceSampler: (lx: number, lz: number, fallbackY: number) => number,
    originOffset: THREE.Vector3,
    options: {
      buildSidewalks: boolean;
      buildCrosswalks: boolean;
      buildSignals: boolean;
      buildCollarApron: boolean;
      yellowPaintTarget?: DetailBuffers;
    },
  ): void {
    const legInfos = legs.map((legApps) => this.computeLegCrosswalkAndMiddleInfo(legApps));
    legInfos.sort((a, b) => a.ang - b.ang);
    if (legInfos.length < 2) {
      return;
    }

    const curbH = 0.16;
    const baseY = -0.06;
    const sidewalkDepth = 6.0;

    // Store inner curb polyline for each built corner so adjacent curved crosswalks extend flush to it
    const cornerCurbByCurrLeg = new Map<number, THREE.Vector3[]>();
    const cornerCurbByNextLeg = new Map<number, THREE.Vector3[]>();

    // 1. Curved solid concrete corner sidewalks & pedestrian signals
    if (options.buildSidewalks) {
      for (let i = 0; i < legInfos.length; i++) {
        const nextIdx = (i + 1) % legInfos.length;
        const lCurr = legInfos[i]!;
        const lNext = legInfos[nextIdx]!;

        const midAngleDiff = Math.atan2(
          lCurr.outX * lNext.outZ - lCurr.outZ * lNext.outX,
          lCurr.outX * lNext.outX + lCurr.outZ * lNext.outZ,
        );
        // Never spawn concrete slabs inside narrow Y-forks or twin carriageway median gaps
        if (Math.abs(midAngleDiff) < 0.65 || Math.abs(midAngleDiff) > 2.65) {
          continue;
        }

        // Exact road-edge rays meeting at virtual sharp corner V_corner
        const edgeAWorldX = lCurr.avgX + lCurr.rightX * lCurr.minRight;
        const edgeAWorldZ = lCurr.avgZ + lCurr.rightZ * lCurr.minRight;
        const edgeBWorldX = lNext.avgX + lNext.rightX * lNext.maxRight;
        const edgeBWorldZ = lNext.avgZ + lNext.rightZ * lNext.maxRight;

        const cA_x = edgeAWorldX - lCurr.outX * 0.25;
        const cA_z = edgeAWorldZ - lCurr.outZ * 0.25;
        const cB_x = edgeBWorldX - lNext.outX * 0.25;
        const cB_z = edgeBWorldZ - lNext.outZ * 0.25;

        const cMidWorldX = (cA_x + cB_x) * 0.5;
        const cMidWorldZ = (cA_z + cB_z) * 0.5;
        const ySurf = (lCurr.avgY + lNext.avgY) * 0.5 - originOffset.y;

        // Outward corner bisector pointing directly away from both roads into the block interior
        let bisectX = -lCurr.rightX + lNext.rightX;
        let bisectZ = -lCurr.rightZ + lNext.rightZ;
        const bisLen = Math.hypot(bisectX, bisectZ);
        if (bisLen > 1e-4) {
          bisectX /= bisLen;
          bisectZ /= bisLen;
        } else {
          bisectX = cMidWorldX - center[0];
          bisectZ = cMidWorldZ - center[2];
          const cLen = Math.hypot(bisectX, bisectZ) || 1;
          bisectX /= cLen;
          bisectZ /= cLen;
        }

        // Compute ideal road-curb intersection vertex V_corner
        let vCornerX = cMidWorldX;
        let vCornerZ = cMidWorldZ;
        const det = lCurr.outX * lNext.outZ - lCurr.outZ * lNext.outX;
        if (Math.abs(det) > 0.28) {
          const dx = edgeBWorldX - edgeAWorldX;
          const dz = edgeBWorldZ - edgeAWorldZ;
          const tInt = (dx * lNext.outZ - dz * lNext.outX) / det;
          const candX = edgeAWorldX + lCurr.outX * tInt;
          const candZ = edgeAWorldZ + lCurr.outZ * tInt;
          if (Math.hypot(candX - cMidWorldX, candZ - cMidWorldZ) <= 22.0) {
            vCornerX = candX;
            vCornerZ = candZ;
          }
        }

        const vLocalX = vCornerX - originOffset.x;
        const vLocalZ = vCornerZ - originOffset.z;
        const cALocal = new THREE.Vector3(cA_x - originOffset.x, ySurf, cA_z - originOffset.z);
        const cBLocal = new THREE.Vector3(cB_x - originOffset.x, ySurf, cB_z - originOffset.z);
        const cMidLocal = new THREE.Vector3(
          cMidWorldX - originOffset.x,
          ySurf,
          cMidWorldZ - originOffset.z,
        );

        const distAlongA = (cALocal.x - vLocalX) * lCurr.outX + (cALocal.z - vLocalZ) * lCurr.outZ;
        const distAlongB = (cBLocal.x - vLocalX) * lNext.outX + (cBLocal.z - vLocalZ) * lNext.outZ;
        const maxRoadW = Math.max(
          lCurr.maxRight - lCurr.minRight,
          lNext.maxRight - lNext.minRight,
        );
        const radiusPad = maxRoadW < 9.5 ? 2.1 : maxRoadW >= 16.0 ? 4.1 : 3.0;
        const tanLenA = THREE.MathUtils.clamp(Math.max(distAlongA, 0.8) + radiusPad, 3.4, 15.0);
        const tanLenB = THREE.MathUtils.clamp(Math.max(distAlongB, 0.8) + radiusPad, 3.4, 15.0);
        const wingLenA = Math.max(tanLenA + 8.5, 14.5);
        const wingLenB = Math.max(tanLenB + 8.5, 14.5);

        const pTanA = new THREE.Vector3(
          vLocalX + lCurr.outX * tanLenA,
          ySurf,
          vLocalZ + lCurr.outZ * tanLenA,
        );
        const pTanB = new THREE.Vector3(
          vLocalX + lNext.outX * tanLenB,
          ySurf,
          vLocalZ + lNext.outZ * tanLenB,
        );
        const ctrl1 = new THREE.Vector3(
          vLocalX + lCurr.outX * (tanLenA * 0.28),
          ySurf,
          vLocalZ + lCurr.outZ * (tanLenA * 0.28),
        );
        const ctrl2 = new THREE.Vector3(
          vLocalX + lNext.outX * (tanLenB * 0.28),
          ySurf,
          vLocalZ + lNext.outZ * (tanLenB * 0.28),
        );
        const wingA = new THREE.Vector3(
          vLocalX + lCurr.outX * wingLenA,
          ySurf,
          vLocalZ + lCurr.outZ * wingLenA,
        );
        const wingB = new THREE.Vector3(
          vLocalX + lNext.outX * wingLenB,
          ySurf,
          vLocalZ + lNext.outZ * wingLenB,
        );

        // Smooth 16-segment Cubic Bezier corner curb strictly outside both road edges & crosswalks
        const arcSegs = 16;
        const bezArc: THREE.Vector3[] = [];
        const edgeALocalX = edgeAWorldX - originOffset.x;
        const edgeALocalZ = edgeAWorldZ - originOffset.z;
        const edgeBLocalX = edgeBWorldX - originOffset.x;
        const edgeBLocalZ = edgeBWorldZ - originOffset.z;

        for (let s = 0; s <= arcSegs; s++) {
          const u = s / arcSegs;
          const omt = 1 - u;
          const omt2 = omt * omt;
          const u2 = u * u;
          let px =
            omt2 * omt * pTanA.x +
            3 * omt2 * u * ctrl1.x +
            3 * omt * u2 * ctrl2.x +
            u2 * u * pTanB.x;
          let pz =
            omt2 * omt * pTanA.z +
            3 * omt2 * u * ctrl1.z +
            3 * omt * u2 * ctrl2.z +
            u2 * u * pTanB.z;

          // Absolute exclusion guard against either crosswalk strip
          const dxA = px - edgeALocalX;
          const dzA = pz - edgeALocalZ;
          const alongA = dxA * lCurr.outX + dzA * lCurr.outZ;
          const outFromA = dxA * -lCurr.rightX + dzA * -lCurr.rightZ;
          if (alongA > -4.1 && alongA < 0.2 && outFromA < 0.08) {
            const push = 0.14 - outFromA;
            px += -lCurr.rightX * push;
            pz += -lCurr.rightZ * push;
          }
          const dxB = px - edgeBLocalX;
          const dzB = pz - edgeBLocalZ;
          const alongB = dxB * lNext.outX + dzB * lNext.outZ;
          const outFromB = dxB * lNext.rightX + dzB * lNext.rightZ;
          if (alongB > -4.1 && alongB < 0.2 && outFromB < 0.08) {
            const push = 0.14 - outFromB;
            px += lNext.rightX * push;
            pz += lNext.rightZ * push;
          }

          bezArc.push(new THREE.Vector3(px, ySurf, pz));
        }

        // Fill flush asphalt throat right up to the curved concrete curb so zero holes ever appear
        const throatBoundary: THREE.Vector3[] = [cALocal, ...bezArc, cBLocal];
        const fanCenterIdx = apronTarget.positions.length / 3;
        apronTarget.positions.push(cMidLocal.x, cMidLocal.y, cMidLocal.z);
        apronTarget.normals.push(0, 1, 0);
        apronTarget.uvs.push(0.5, 0.5);
        for (const p of throatBoundary) {
          apronTarget.positions.push(p.x, p.y, p.z);
          apronTarget.normals.push(0, 1, 0);
          apronTarget.uvs.push(0.5, 0.5);
        }
        for (let k = 0; k < throatBoundary.length - 1; k++) {
          const p0 = throatBoundary[k]!;
          const p1 = throatBoundary[k + 1]!;
          const winding =
            (p0.z - cMidLocal.z) * (p1.x - cMidLocal.x) -
            (p0.x - cMidLocal.x) * (p1.z - cMidLocal.z);
          if (winding > 1e-4) {
            apronTarget.indices.push(fanCenterIdx, fanCenterIdx + 1 + k, fanCenterIdx + 2 + k);
          } else if (winding < -1e-4) {
            apronTarget.indices.push(fanCenterIdx, fanCenterIdx + 2 + k, fanCenterIdx + 1 + k);
          }
        }

        // Build solid filled curved concrete sidewalk pad (wingA -> bezArc -> wingB)
        const innerPath: THREE.Vector3[] = [wingA, ...bezArc, wingB];
        cornerCurbByCurrLeg.set(i, innerPath);
        cornerCurbByNextLeg.set(nextIdx, innerPath);

        // Smooth curved outer back edge (deep filled corner terrace with no angular miter elbows)
        const backWingA = new THREE.Vector3(
          wingA.x - lCurr.rightX * sidewalkDepth,
          ySurf,
          wingA.z - lCurr.rightZ * sidewalkDepth,
        );
        const backTanA = new THREE.Vector3(
          pTanA.x - lCurr.rightX * sidewalkDepth,
          ySurf,
          pTanA.z - lCurr.rightZ * sidewalkDepth,
        );
        const backTanB = new THREE.Vector3(
          pTanB.x + lNext.rightX * sidewalkDepth,
          ySurf,
          pTanB.z + lNext.rightZ * sidewalkDepth,
        );
        const backWingB = new THREE.Vector3(
          wingB.x + lNext.rightX * sidewalkDepth,
          ySurf,
          wingB.z + lNext.rightZ * sidewalkDepth,
        );
        const outerCtrl = new THREE.Vector3(
          vLocalX + bisectX * (sidewalkDepth * 1.45),
          ySurf,
          vLocalZ + bisectZ * (sidewalkDepth * 1.45),
        );
        const outerArc: THREE.Vector3[] = [];
        for (let s = 0; s <= arcSegs; s++) {
          const u = s / arcSegs;
          const omt = 1 - u;
          outerArc.push(
            new THREE.Vector3(
              omt * omt * backTanA.x + 2 * omt * u * outerCtrl.x + u * u * backTanB.x,
              ySurf,
              omt * omt * backTanA.z + 2 * omt * u * outerCtrl.z + u * u * backTanB.z,
            ),
          );
        }
        const outerPath: THREE.Vector3[] = [backWingA, ...outerArc, backWingB];

        const topIn = innerPath.map((ip) => new THREE.Vector3(ip.x, ySurf + curbH, ip.z));
        const botIn = innerPath.map((ip) => new THREE.Vector3(ip.x, ySurf + baseY, ip.z));
        const topOut = outerPath.map((op) => new THREE.Vector3(op.x, ySurf + curbH, op.z));
        const botOut = outerPath.map((op) => new THREE.Vector3(op.x, ySurf - 0.12, op.z));

        for (let k = 0; k < innerPath.length - 1; k++) {
          const i0 = topIn[k]!;
          const o0 = topOut[k]!;
          const o1 = topOut[k + 1]!;
          const i1 = topIn[k + 1]!;
          const topCross = (o0.z - i0.z) * (i1.x - i0.x) - (o0.x - i0.x) * (i1.z - i0.z);
          if (topCross >= 0) {
            appendQuadToBuffers(concreteTop, i0, o0, o1, i1, WORLD_UP);
          } else {
            appendQuadToBuffers(concreteTop, i0, i1, o1, o0, WORLD_UP);
          }

          const segDx = innerPath[k + 1]!.x - innerPath[k]!.x;
          const segDz = innerPath[k + 1]!.z - innerPath[k]!.z;
          const segLen = Math.hypot(segDx, segDz) || 1;
          // Inward road normal along path direction is (+segDz, -segDx)
          const roadInNorm = new THREE.Vector3(segDz / segLen, 0, -segDx / segLen);
          const outerNorm = roadInNorm.clone().negate();
          appendQuadToBuffers(concreteSide, botIn[k]!, topIn[k]!, topIn[k + 1]!, botIn[k + 1]!, roadInNorm);
          appendQuadToBuffers(concreteSide, topOut[k]!, botOut[k]!, botOut[k + 1]!, topOut[k + 1]!, outerNorm);
        }

        // End caps at both wing ends
        appendQuadToBuffers(
          concreteSide,
          botOut[0]!,
          topOut[0]!,
          topIn[0]!,
          botIn[0]!,
          new THREE.Vector3(lCurr.outX, 0, lCurr.outZ),
        );
        const lastIdx = innerPath.length - 1;
        appendQuadToBuffers(
          concreteSide,
          botIn[lastIdx]!,
          topIn[lastIdx]!,
          topOut[lastIdx]!,
          botOut[lastIdx]!,
          new THREE.Vector3(lNext.outX, 0, lNext.outZ),
        );

        // Mount pedestrian signal heads cleanly behind the curved apex facing across both crosswalks
        if (options.buildSignals) {
          const midBezIdx = Math.floor(bezArc.length * 0.5);
          const bezMidPt = bezArc[midBezIdx]!;
          const pPrevM = bezArc[Math.max(0, midBezIdx - 1)]!;
          const pNextM = bezArc[Math.min(bezArc.length - 1, midBezIdx + 1)]!;
          const mdx = pNextM.x - pPrevM.x;
          const mdz = pNextM.z - pPrevM.z;
          const mLen = Math.hypot(mdx, mdz) || 1;
          const bezMidOutX = -mdz / mLen;
          const bezMidOutZ = mdx / mLen;
          const poleBaseX = bezMidPt.x + bezMidOutX * 1.15;
          const poleBaseY = ySurf + curbH;
          const poleBaseZ = bezMidPt.z + bezMidOutZ * 1.15;

          const isAxisA_Ped1 = Math.abs(lCurr.rightZ) >= Math.abs(lCurr.rightX);
          const isAxisA_Ped2 = Math.abs(lNext.rightZ) >= Math.abs(lNext.rightX);

          this.emitPedestrianPoleAndHead(
            signalCtx,
            poleBaseX,
            poleBaseY,
            poleBaseZ,
            lCurr.rightX,
            lCurr.rightZ,
            isAxisA_Ped1,
            -lNext.rightX,
            -lNext.rightZ,
            isAxisA_Ped2,
          );
        }
      }
    }

    // 2. Clean transverse asphalt collar across [cutPoint .. cutPoint + 1.85m] for divided median noses
    if (options.buildCollarApron) {
      for (const leg of legInfos) {
        if (leg.maxRight - leg.minRight < 1.5) {
          continue;
        }
        const ax = leg.avgX - originOffset.x;
        const az = leg.avgZ - originOffset.z;
        const sampleY = (lx: number, lz: number) =>
          surfaceSampler(lx, lz, leg.avgY - originOffset.y) - 0.002;
        const mk = (along: number, across: number): THREE.Vector3 => {
          const lx = ax + leg.outX * along + leg.rightX * across;
          const lz = az + leg.outZ * along + leg.rightZ * across;
          return new THREE.Vector3(lx, sampleY(lx, lz), lz);
        };
        appendQuadToBuffers(
          apronTarget,
          mk(-0.35, leg.minRight),
          mk(-0.35, leg.maxRight),
          mk(1.85, leg.maxRight),
          mk(1.85, leg.minRight),
          WORLD_UP,
        );
      }
    }

    // 3. Gently curved ladder crosswalks extending seamlessly curb-to-curb from curved sidewalks
    if (options.buildCrosswalks) {
      const sampleCurbContact = (
        curbPath: THREE.Vector3[] | undefined,
        leg: (typeof legInfos)[number],
        targetAlong: number,
        expectedAcross: number,
        tuckDirSign: number,
      ): THREE.Vector3 | null => {
        if (!curbPath || curbPath.length < 2) {
          return null;
        }
        const ax = leg.avgX - originOffset.x;
        const az = leg.avgZ - originOffset.z;
        let bestPt: THREE.Vector3 | null = null;
        let bestErr = Infinity;

        for (let k = 0; k < curbPath.length - 1; k++) {
          const p0 = curbPath[k]!;
          const p1 = curbPath[k + 1]!;
          const a0 = (p0.x - ax) * leg.outX + (p0.z - az) * leg.outZ;
          const a1 = (p1.x - ax) * leg.outX + (p1.z - az) * leg.outZ;
          const minA = Math.min(a0, a1);
          const maxA = Math.max(a0, a1);
          if (targetAlong >= minA - 0.15 && targetAlong <= maxA + 0.15) {
            const frac =
              Math.abs(a1 - a0) > 1e-4
                ? THREE.MathUtils.clamp((targetAlong - a0) / (a1 - a0), 0, 1)
                : 0.5;
            const qx = THREE.MathUtils.lerp(p0.x, p1.x, frac);
            const qz = THREE.MathUtils.lerp(p0.z, p1.z, frac);
            const across = (qx - ax) * leg.rightX + (qz - az) * leg.rightZ;
            const err = Math.abs(across - expectedAcross);
            if (err < bestErr && err <= 2.4) {
              bestErr = err;
              bestPt = new THREE.Vector3(qx, 0, qz);
            }
          }
        }
        if (!bestPt) {
          return null;
        }
        const across = (bestPt.x - ax) * leg.rightX + (bestPt.z - az) * leg.rightZ;
        const clampedAcross = THREE.MathUtils.clamp(
          across + tuckDirSign * 0.16,
          expectedAcross - 1.35,
          expectedAcross + 1.35,
        );
        return new THREE.Vector3(
          ax + leg.outX * targetAlong + leg.rightX * clampedAcross,
          0,
          az + leg.outZ * targetAlong + leg.rightZ * clampedAcross,
        );
      };

      for (let i = 0; i < legInfos.length; i++) {
        const leg = legInfos[i]!;
        if (!Number.isFinite(leg.minRight) || leg.maxRight - leg.minRight < 1.5) {
          continue;
        }

        const ax = leg.avgX - originOffset.x;
        const az = leg.avgZ - originOffset.z;
        const midAlong = -CROSSWALK_DEPTH_METERS * 0.5 - 0.25;
        const leftPath = cornerCurbByCurrLeg.get(i);
        const rightPath = cornerCurbByNextLeg.get(i);

        const defaultLeft = new THREE.Vector3(
          ax + leg.outX * midAlong + leg.rightX * (leg.minRight + (leftPath ? -0.14 : 0.12)),
          0,
          az + leg.outZ * midAlong + leg.rightZ * (leg.minRight + (leftPath ? -0.14 : 0.12)),
        );
        const defaultRight = new THREE.Vector3(
          ax + leg.outX * midAlong + leg.rightX * (leg.maxRight + (rightPath ? 0.14 : -0.12)),
          0,
          az + leg.outZ * midAlong + leg.rightZ * (leg.maxRight + (rightPath ? 0.14 : -0.12)),
        );

        const pLeft =
          sampleCurbContact(leftPath, leg, midAlong, leg.minRight, -1) ?? defaultLeft;
        const pRight =
          sampleCurbContact(rightPath, leg, midAlong, leg.maxRight, 1) ?? defaultRight;

        // Subtle organic intersection-perimeter bow toward center so crosswalk flows cleanly between curved curbs
        const chordSpan = Math.hypot(pRight.x - pLeft.x, pRight.z - pLeft.z);
        const bowM = THREE.MathUtils.clamp(chordSpan * 0.028, 0.18, 0.68);
        const pCtrl = new THREE.Vector3(
          (pLeft.x + pRight.x) * 0.5 - leg.outX * bowM,
          0,
          (pLeft.z + pRight.z) * 0.5 - leg.outZ * bowM,
        );

        const fallbackLocalY = leg.avgY - originOffset.y;
        this.emitLadderCrosswalkAlongCurve(
          paintTarget,
          pLeft,
          pCtrl,
          pRight,
          CROSSWALK_DEPTH_METERS * 0.5,
          new THREE.Vector3(leg.outX, 0, leg.outZ),
          (lx, lz) => surfaceSampler(lx, lz, fallbackLocalY),
          (alongLocal) => sampleCurbContact(leftPath, leg, alongLocal, leg.minRight, -1),
          (alongLocal) => sampleCurbContact(rightPath, leg, alongLocal, leg.maxRight, 1),
          { x: ax, z: az, outX: leg.outX, outZ: leg.outZ },
          leg.crosswalkStyle,
          options.yellowPaintTarget,
        );
      }
    }

    // 4. Mast-arm cantilevered traffic signals on the RIGHT curb of every incoming leg
    if (options.buildSignals) {
      for (const app of apps) {
        if (!app.is_incoming) {
          continue;
        }
        const inTravelX = -app.out_dir_xz[0];
        const inTravelZ = -app.out_dir_xz[1];
        const rightX = -inTravelZ;
        const rightZ = inTravelX;

        const spanHalf = app.half_width;
        const poleX = app.cut_point[0] + rightX * (spanHalf + 2.15) - inTravelX * 1.9 - originOffset.x;
        const poleY = app.cut_point[1] + 0.14 - originOffset.y;
        const poleZ = app.cut_point[2] + rightZ * (spanHalf + 2.15) - inTravelZ * 1.9 - originOffset.z;

        const armSpan = app.bidirectional
          ? Math.min(9.2, spanHalf * 0.95 + 2.0)
          : Math.min(12.2, app.half_width * 1.5 + 1.8);
        const isAxisA = Math.abs(inTravelZ) >= Math.abs(inTravelX);
        const hasLeftPriority = Boolean(
          app.turn_lanes?.some((s) => s.includes('left')) ||
            (app.bidirectional ? app.forward_lanes : app.lanes) >= 3,
        );

        this.emitCantileverSignalPole(
          signalCtx,
          poleX,
          poleY,
          poleZ,
          -rightX,
          -rightZ,
          inTravelX,
          inTravelZ,
          armSpan,
          isAxisA,
          hasLeftPriority,
        );
      }
    }
  }

  private emitPedestrianPoleAndHead(
    acc: SignalMeshAccumulator,
    px: number,
    py: number,
    pz: number,
    dir1X: number,
    dir1Z: number,
    isAxisA1: boolean,
    dir2X: number,
    dir2Z: number,
    isAxisA2: boolean,
  ): void {
    // Pedestal pole (2.9m tall, 0.09m half-width square column)
    this.emitBox(acc.poles, px, py, pz, 0.09, 2.9, 0.09, 1, 0);

    // Pedestrian signal housing facing across crosswalk 1 (dir1)
    this.emitPedHead(acc, px, py + 2.45, pz, dir1X, dir1Z, isAxisA1);
    // Pedestrian signal housing facing across crosswalk 2 (dir2)
    this.emitPedHead(acc, px, py + 2.78, pz, dir2X, dir2Z, isAxisA2);
  }

  private emitPedHead(
    acc: SignalMeshAccumulator,
    cx: number,
    cy: number,
    cz: number,
    faceX: number,
    faceZ: number,
    isAxisA: boolean,
  ): void {
    const fn = Math.hypot(faceX, faceZ) || 1;
    const fx = faceX / fn;
    const fz = faceZ / fn;
    const rx = -fz;
    const rz = fx;

    const hx = cx + fx * 0.22;
    const hz = cz + fz * 0.22;
    this.emitBox(acc.housings, hx, cy - 0.18, hz, 0.2, 0.36, 0.12, fx, fz);

    // Front Walk + Wait lenses side-by-side inside housing
    const frontOff = 0.125;
    const lx = hx + fx * frontOff;
    const lz = hz + fz * frontOff;
    const pedWalkBuf = isAxisA ? acc.aPedWalk : acc.bPedWalk;
    const pedWaitBuf = isAxisA ? acc.aPedWait : acc.bPedWait;
    const fNorm = new THREE.Vector3(fx, 0, fz);

    // Walk lens (left side)
    appendQuadToBuffers(
      pedWalkBuf,
      new THREE.Vector3(lx - rx * 0.14, cy - 0.12, lz - rz * 0.14),
      new THREE.Vector3(lx - rx * 0.02, cy - 0.12, lz - rz * 0.02),
      new THREE.Vector3(lx - rx * 0.02, cy + 0.12, lz - rz * 0.02),
      new THREE.Vector3(lx - rx * 0.14, cy + 0.12, lz - rz * 0.14),
      fNorm,
    );
    // Don't Walk lens (right side)
    appendQuadToBuffers(
      pedWaitBuf,
      new THREE.Vector3(lx + rx * 0.02, cy - 0.12, lz + rz * 0.02),
      new THREE.Vector3(lx + rx * 0.14, cy - 0.12, lz + rz * 0.14),
      new THREE.Vector3(lx + rx * 0.14, cy + 0.12, lz + rz * 0.14),
      new THREE.Vector3(lx + rx * 0.02, cy + 0.12, lz + rz * 0.02),
      fNorm,
    );
  }

  private emitCantileverSignalPole(
    acc: SignalMeshAccumulator,
    baseX: number,
    baseY: number,
    baseZ: number,
    armDirX: number,
    armDirZ: number,
    inTravelX: number,
    inTravelZ: number,
    armLen: number,
    isAxisA: boolean,
    hasLeftPriority: boolean,
  ): void {
    // 1. Vertical mast post (5.8m tall, 0.14m half-width)
    this.emitBox(acc.poles, baseX, baseY, baseZ, 0.14, 5.85, 0.14, 1, 0);

    // 2. Horizontal mast arm at y = +5.45m stretching over incoming lanes along (armDirX, armDirZ)
    const armMidX = baseX + armDirX * (armLen * 0.5);
    const armMidZ = baseZ + armDirZ * (armLen * 0.5);
    this.emitBox(acc.poles, armMidX, baseY + 5.4, armMidZ, armLen * 0.5, 0.18, 0.1, armDirX, armDirZ);

    // Signal lenses face oncoming drivers (-inTravel)
    const faceX = -inTravelX;
    const faceZ = -inTravelZ;

    // Primary through signal head hanging mid-arm over through lanes
    const h1X = baseX + armDirX * (armLen * 0.52);
    const h1Z = baseZ + armDirZ * (armLen * 0.52);
    this.emitThreeAspectSignalHead(acc, h1X, baseY + 4.95, h1Z, faceX, faceZ, isAxisA, false);

    // Left-turn priority 4-aspect signal head closer to arm tip over left lane
    if (hasLeftPriority) {
      const h2X = baseX + armDirX * (armLen * 0.88);
      const h2Z = baseZ + armDirZ * (armLen * 0.88);
      this.emitThreeAspectSignalHead(acc, h2X, baseY + 4.95, h2Z, faceX, faceZ, isAxisA, true);
    }
  }

  private emitThreeAspectSignalHead(
    acc: SignalMeshAccumulator,
    cx: number,
    cy: number,
    cz: number,
    faceX: number,
    faceZ: number,
    isAxisA: boolean,
    isLeftPriority: boolean,
  ): void {
    const height = isLeftPriority ? 1.15 : 0.92;
    this.emitBox(acc.housings, cx, cy - height * 0.5, cz, 0.22, height, 0.2, faceX, faceZ);

    const fn = Math.hypot(faceX, faceZ) || 1;
    const fx = faceX / fn;
    const fz = faceZ / fn;
    // Ontario reflective yellow backplate behind signal head
    this.emitBox(
      acc.backplates,
      cx - fx * 0.14,
      cy - (height + 0.16) * 0.5,
      cz - fz * 0.14,
      0.04,
      height + 0.16,
      0.30,
      fx,
      fz,
    );
    const rx = -fz;
    const rz = fx;
    const lx = cx + fx * 0.21;
    const lz = cz + fz * 0.21;
    const fNorm = new THREE.Vector3(fx, 0, fz);

    const emitLens = (buf: DetailBuffers, yMid: number, r: number) => {
      appendQuadToBuffers(
        buf,
        new THREE.Vector3(lx - rx * r, yMid - r, lz - rz * r),
        new THREE.Vector3(lx + rx * r, yMid - r, lz + rz * r),
        new THREE.Vector3(lx + rx * r, yMid + r, lz + rz * r),
        new THREE.Vector3(lx - rx * r, yMid + r, lz - rz * r),
        fNorm,
      );
    };

    const redBuf = isAxisA ? acc.aRed : acc.bRed;
    const ambBuf = isAxisA ? acc.aAmber : acc.bAmber;
    const grnBuf = isAxisA ? acc.aGreen : acc.bGreen;
    const lftBuf = isAxisA ? acc.aLeftGreen : acc.bLeftGreen;

    if (isLeftPriority) {
      emitLens(redBuf, cy + 0.38, 0.12);
      emitLens(ambBuf, cy + 0.12, 0.12);
      emitLens(grnBuf, cy - 0.14, 0.12);
      emitLens(lftBuf, cy - 0.4, 0.13);
    } else {
      emitLens(redBuf, cy + 0.28, 0.12);
      emitLens(ambBuf, cy, 0.12);
      emitLens(grnBuf, cy - 0.28, 0.12);
    }
  }

  private emitBox(
    buf: DetailBuffers,
    cx: number,
    baseY: number,
    cz: number,
    halfX: number,
    heightY: number,
    halfZ: number,
    axisX: number,
    axisZ: number,
  ): void {
    const an = Math.hypot(axisX, axisZ) || 1;
    const ux = axisX / an;
    const uz = axisZ / an;
    const vx = -uz;
    const vz = ux;

    const pt = (ax: number, ay: number, az: number): THREE.Vector3 =>
      new THREE.Vector3(
        cx + ux * ax + vx * az,
        baseY + ay,
        cz + uz * ax + vz * az,
      );

    const p000 = pt(-halfX, 0, -halfZ);
    const p100 = pt(halfX, 0, -halfZ);
    const p101 = pt(halfX, 0, halfZ);
    const p001 = pt(-halfX, 0, halfZ);
    const p010 = pt(-halfX, heightY, -halfZ);
    const p110 = pt(halfX, heightY, -halfZ);
    const p111 = pt(halfX, heightY, halfZ);
    const p011 = pt(-halfX, heightY, halfZ);

    const nPosX = new THREE.Vector3(ux, 0, uz);
    const nNegX = nPosX.clone().negate();
    const nPosZ = new THREE.Vector3(vx, 0, vz);
    const nNegZ = nPosZ.clone().negate();

    appendQuadToBuffers(buf, p011, p111, p110, p010, WORLD_UP); // top
    appendQuadToBuffers(buf, p100, p101, p111, p110, nPosX);
    appendQuadToBuffers(buf, p001, p000, p010, p011, nNegX);
    appendQuadToBuffers(buf, p101, p001, p011, p111, nPosZ);
    appendQuadToBuffers(buf, p000, p100, p110, p010, nNegZ);
  }

  private createLeftPriorityArrowTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#07140d';
    ctx.fillRect(0, 0, 64, 64);

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(32, 32, 26, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#07140d';
    ctx.beginPath();
    ctx.arc(32, 32, 23, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#ffffff';
    ctx.fillStyle = '#ffffff';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(46, 32);
    ctx.lineTo(22, 32);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(14, 32);
    ctx.lineTo(28, 20);
    ctx.lineTo(28, 44);
    ctx.closePath();
    ctx.fill();

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  private createPedestrianIconTexture(mode: 'walk' | 'wait'): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 96;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#080b10';
    ctx.fillRect(0, 0, 64, 96);

    if (mode === 'walk') {
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#ffffff';
      ctx.lineCap = 'round';
      ctx.lineWidth = 6;
      // Head
      ctx.beginPath();
      ctx.arc(34, 22, 7, 0, Math.PI * 2);
      ctx.fill();
      // Torso + stride legs + arms
      ctx.beginPath();
      ctx.moveTo(32, 31);
      ctx.lineTo(30, 56);
      ctx.moveTo(30, 56);
      ctx.lineTo(18, 82);
      ctx.moveTo(30, 56);
      ctx.lineTo(46, 82);
      ctx.moveTo(31, 37);
      ctx.lineTo(18, 49);
      ctx.moveTo(32, 37);
      ctx.lineTo(46, 46);
      ctx.stroke();
    } else {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      // Stylized raised hand
      ctx.roundRect(20, 44, 24, 32, 6);
      ctx.fill();
      for (const x of [22, 28, 34, 40]) {
        ctx.beginPath();
        ctx.roundRect(x - 2.2, 16, 4.4, 30, 2);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.roundRect(12, 42, 6, 18, 3);
      ctx.fill();
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  }
}

export class SignalMeshAccumulator {
  public readonly poles = createDetailBuffers();
  public readonly housings = createDetailBuffers();
  public readonly backplates = createDetailBuffers();
  public readonly aGreen = createDetailBuffers();
  public readonly aAmber = createDetailBuffers();
  public readonly aRed = createDetailBuffers();
  public readonly aLeftGreen = createDetailBuffers();
  public readonly aPedWalk = createDetailBuffers();
  public readonly aPedWait = createDetailBuffers();
  public readonly bGreen = createDetailBuffers();
  public readonly bAmber = createDetailBuffers();
  public readonly bRed = createDetailBuffers();
  public readonly bLeftGreen = createDetailBuffers();
  public readonly bPedWalk = createDetailBuffers();
  public readonly bPedWait = createDetailBuffers();
}
