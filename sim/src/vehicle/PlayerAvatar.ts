import * as THREE from 'three';

export type AvatarPoseMode = 'seated' | 'walking';

/**
 * Human-scale (1.72 m tall) stylized driver avatar representing the player.
 * Supports both seated in-car driving posture (visible through cabin glass)
 * and on-foot walking stride animation when stepping outside the vehicle.
 */
export class PlayerAvatar {
  public readonly root = new THREE.Group();

  private readonly pelvisPivot = new THREE.Group();
  private readonly torsoPivot = new THREE.Group();
  private readonly headGroup = new THREE.Group();
  private readonly leftArmPivot = new THREE.Group();
  private readonly rightArmPivot = new THREE.Group();
  private readonly leftLegPivot = new THREE.Group();
  private readonly rightLegPivot = new THREE.Group();

  private mode: AvatarPoseMode = 'seated';
  private walkPhase = 0;

  constructor() {
    this.root.name = 'player-driver-avatar';

    const suitMat = new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      roughness: 0.65,
      metalness: 0.18,
    });
    const accentMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.55,
      metalness: 0.25,
    });
    const cyanGlowMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x0284c7,
      emissiveIntensity: 0.85,
      roughness: 0.2,
      metalness: 0.1,
    });
    const skinHelmetMat = new THREE.MeshStandardMaterial({
      color: 0xe2e8f0,
      roughness: 0.35,
      metalness: 0.22,
    });
    const bootMat = new THREE.MeshStandardMaterial({
      color: 0x020617,
      roughness: 0.8,
      metalness: 0.1,
    });

    this.root.add(this.pelvisPivot);

    // Legs (approx 0.82 m long from hip at y=0.84 down to ground)
    const thighGeo = new THREE.BoxGeometry(0.14, 0.42, 0.15);
    const shinGeo = new THREE.BoxGeometry(0.12, 0.42, 0.13);
    const footGeo = new THREE.BoxGeometry(0.12, 0.08, 0.22);

    const buildLeg = (pivot: THREE.Group, xOffset: number): void => {
      pivot.position.set(xOffset, 0.84, 0);
      const thigh = new THREE.Mesh(thighGeo, accentMat);
      thigh.position.set(0, -0.21, 0);
      thigh.castShadow = true;
      pivot.add(thigh);

      const shin = new THREE.Mesh(shinGeo, suitMat);
      shin.position.set(0, -0.58, 0);
      shin.castShadow = true;
      pivot.add(shin);

      const foot = new THREE.Mesh(footGeo, bootMat);
      foot.position.set(0, -0.80, -0.04);
      foot.castShadow = true;
      pivot.add(foot);

      this.pelvisPivot.add(pivot);
    };

    buildLeg(this.leftLegPivot, -0.10);
    buildLeg(this.rightLegPivot, 0.10);

    // Torso (hips at y=0.84 up to shoulders at y=1.38)
    this.torsoPivot.position.set(0, 0.84, 0);
    this.pelvisPivot.add(this.torsoPivot);

    const chest = new THREE.Mesh(
      new THREE.BoxGeometry(0.38, 0.52, 0.22),
      suitMat,
    );
    chest.position.set(0, 0.27, 0);
    chest.castShadow = true;
    this.torsoPivot.add(chest);

    // Glowing Antigravity delta/chevron emblem on chest & back
    const chestBadge = new THREE.Mesh(
      new THREE.BoxGeometry(0.10, 0.10, 0.235),
      cyanGlowMat,
    );
    chestBadge.position.set(0, 0.34, 0);
    chestBadge.rotation.z = Math.PI * 0.25;
    this.torsoPivot.add(chestBadge);

    const collar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.085, 0.10, 0.08, 12),
      accentMat,
    );
    collar.position.set(0, 0.54, 0);
    this.torsoPivot.add(collar);

    // Head + Antigravity cyan visor facing forward (-Z)
    this.headGroup.position.set(0, 0.68, 0);
    this.torsoPivot.add(this.headGroup);

    const headSphere = new THREE.Mesh(
      new THREE.SphereGeometry(0.13, 18, 14),
      skinHelmetMat,
    );
    headSphere.scale.set(0.92, 1.05, 1.0);
    headSphere.castShadow = true;
    this.headGroup.add(headSphere);

    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(0.20, 0.068, 0.13),
      cyanGlowMat,
    );
    visor.position.set(0, 0.015, -0.078);
    this.headGroup.add(visor);

    // Arms attached at shoulders (y=0.47 inside torsoPivot)
    const armGeo = new THREE.BoxGeometry(0.10, 0.48, 0.10);
    const gloveGeo = new THREE.BoxGeometry(0.09, 0.09, 0.11);

    const buildArm = (pivot: THREE.Group, xOffset: number): void => {
      pivot.position.set(xOffset, 0.47, 0);
      const sleeve = new THREE.Mesh(armGeo, suitMat);
      sleeve.position.set(0, -0.22, 0);
      sleeve.castShadow = true;
      pivot.add(sleeve);

      const cuff = new THREE.Mesh(
        new THREE.BoxGeometry(0.106, 0.045, 0.106),
        cyanGlowMat,
      );
      cuff.position.set(0, -0.39, 0);
      pivot.add(cuff);

      const glove = new THREE.Mesh(gloveGeo, bootMat);
      glove.position.set(0, -0.47, 0);
      pivot.add(glove);

      this.torsoPivot.add(pivot);
    };

    buildArm(this.leftArmPivot, -0.24);
    buildArm(this.rightArmPivot, 0.24);

    this.setMode('seated');
  }

  public getMode(): AvatarPoseMode {
    return this.mode;
  }

  public setHeadVisible(visible: boolean): void {
    this.headGroup.visible = visible;
  }

  public setMode(mode: AvatarPoseMode): void {
    this.mode = mode;
    if (mode === 'seated') {
      // Lower pelvis slightly so head sits comfortably below roof interior at y ~ 1.18 m
      this.pelvisPivot.position.set(0, -0.36, 0);
      this.torsoPivot.rotation.set(-0.08, 0, 0);
      this.leftLegPivot.rotation.set(Math.PI * 0.46, 0, 0);
      this.rightLegPivot.rotation.set(Math.PI * 0.46, 0, 0);
      this.leftArmPivot.rotation.set(Math.PI * 0.42, 0, -0.14);
      this.rightArmPivot.rotation.set(Math.PI * 0.42, 0, 0.14);
      this.headGroup.rotation.set(0, 0, 0);
    } else {
      this.pelvisPivot.position.set(0, 0, 0);
      this.torsoPivot.rotation.set(0, 0, 0);
      this.leftLegPivot.rotation.set(0, 0, 0);
      this.rightLegPivot.rotation.set(0, 0, 0);
      this.leftArmPivot.rotation.set(0, 0, 0.06);
      this.rightArmPivot.rotation.set(0, 0, -0.06);
      this.headGroup.rotation.set(0, 0, 0);
    }
  }

  /**
   * Animates driver steering posture in-car or walking stride when outside.
   */
  public updateSeatedPose(steerAngleRad: number, headYawOffsetRad = 0): void {
    if (this.mode !== 'seated') {
      return;
    }
    const clampedSteer = THREE.MathUtils.clamp(steerAngleRad, -0.65, 0.65);
    this.leftArmPivot.rotation.x = Math.PI * 0.42 + clampedSteer * 0.16;
    this.rightArmPivot.rotation.x = Math.PI * 0.42 - clampedSteer * 0.16;
    this.headGroup.rotation.y = THREE.MathUtils.clamp(
      clampedSteer * 0.35 + headYawOffsetRad,
      -0.8,
      0.8,
    );
  }

  public updateWalkAnimation(dtSeconds: number, horizontalSpeedMps: number): void {
    if (this.mode !== 'walking') {
      return;
    }
    if (horizontalSpeedMps > 0.25) {
      this.walkPhase += dtSeconds * Math.min(12, horizontalSpeedMps * 2.4);
      const swing = Math.sin(this.walkPhase) * Math.min(0.65, horizontalSpeedMps * 0.14);
      this.leftLegPivot.rotation.x = swing;
      this.rightLegPivot.rotation.x = -swing;
      this.leftArmPivot.rotation.x = -swing * 0.8;
      this.rightArmPivot.rotation.x = swing * 0.8;
      this.pelvisPivot.position.y = Math.abs(Math.cos(this.walkPhase)) * 0.035;
    } else {
      const relax = 1 - Math.exp(-10 * dtSeconds);
      this.leftLegPivot.rotation.x *= 1 - relax;
      this.rightLegPivot.rotation.x *= 1 - relax;
      this.leftArmPivot.rotation.x *= 1 - relax;
      this.rightArmPivot.rotation.x *= 1 - relax;
      this.pelvisPivot.position.y *= 1 - relax;
    }
  }
}
