import * as THREE from 'three';
import type {
  FloatingOriginListener,
  FloatingOriginManager,
} from '../core/FloatingOriginManager.ts';
import {
  Powertrain,
  Suspension,
  TireModel,
  VehicleRigidBody,
} from '../physics/index.ts';
import type { ChunkStreamer } from '../world/ChunkStreamer.ts';
import { PlayerAvatar } from './PlayerAvatar.ts';
import {
  getPaintColorHex,
  type VehicleDefinition,
} from './VehicleCatalog.ts';

export interface VehicleTelemetry {
  speedKmh: number;
  signedSpeedMps: number;
  engineRpm: number;
  gearLabel: string;
  steeringAngleRad: number;
  headingRad: number;
  onRoad: boolean;
  streetName: string | null;
  speedLimitKmh: number;
  onFoot: boolean;
}

export interface DrivingInputState {
  throttle: boolean;
  brakeReverse: boolean;
  steerLeft: boolean;
  steerRight: boolean;
  handbrake: boolean;
  sprint: boolean;
}

/**
 * 1:1 world-meter scaled drivable vehicle combining dynamic bicycle/tire
 * physics, 4 articulated wheels, transparent cabin showing a seated PlayerAvatar,
 * rotatable interior steering wheel, road elevation grounding, and on-foot exit/enter.
 */
export class DrivableCar implements FloatingOriginListener {
  public readonly root = new THREE.Group();
  public readonly definition: VehicleDefinition;
  public readonly avatar = new PlayerAvatar();

  private readonly chassisPivot = new THREE.Group();
  private readonly suspensionBody = new THREE.Group();
  private readonly steeringWheelGroup = new THREE.Group();

  private readonly frontLeftPivot = new THREE.Group();
  private readonly frontRightPivot = new THREE.Group();
  private readonly wheelSpinMeshes: THREE.Object3D[] = [];
  private readonly brakeLightMat: THREE.MeshStandardMaterial;
  private readonly reverseLightMat: THREE.MeshStandardMaterial;
  private readonly paintMaterials: THREE.MeshStandardMaterial[] = [];

  private readonly rigidBody: VehicleRigidBody;
  private readonly powertrain = new Powertrain();
  private readonly frontTire: TireModel;
  private readonly rearTire: TireModel;
  private readonly frontSusp = new Suspension({
    restLengthMeters: 0.22,
    springStiffnessNPerM: 28000,
    dampingNsPerM: 3200,
  });
  private readonly rearSusp = new Suspension({
    restLengthMeters: 0.22,
    springStiffnessNPerM: 28000,
    dampingNsPerM: 3200,
  });

  private readonly unsubscribeOrigin: () => void;

  // Dynamic vehicle kinematics (rotationY = -headingRad; forward = -Z in local car frame)
  private yawRad = 0;
  private fwdSpeed = 0;
  private latSpeed = 0;
  private yawRate = 0;
  private steerAngleRad = 0;
  private wheelSpinRad = 0;
  private visualPitchRad = 0;
  private visualRollRad = 0;
  private groundPitchRad = 0;
  private reverseEngaged = false;
  private currentGearLabel = 'N';
  private engineRpm = 800;

  // On-foot avatar mode (outside the car via [F])
  private onFoot = false;
  private readonly avatarWorldPos = new THREE.Vector3();
  private avatarYawRad = 0;

  // Latest road sample metadata
  private onRoad = true;
  private streetName: string | null = null;
  private speedLimitKmh = 50;

  private readonly tempMapPos = new THREE.Vector3();
  private readonly tempRight = new THREE.Vector3();

  constructor(
    definition: VehicleDefinition,
    floatingOrigin: FloatingOriginManager,
    colorId?: string,
  ) {
    this.definition = definition;
    this.unsubscribeOrigin = floatingOrigin.subscribe(this);

    this.rigidBody = new VehicleRigidBody(definition.handling.massKg);
    this.frontTire = new TireModel(definition.handling.peakGripCoeff);
    this.rearTire = new TireModel(definition.handling.peakGripCoeff * 1.04);

    this.root.name = `vehicle-${definition.id}`;
    this.root.add(this.chassisPivot);
    this.chassisPivot.add(this.suspensionBody);

    this.brakeLightMat = new THREE.MeshStandardMaterial({
      color: 0x991b1b,
      emissive: 0xef4444,
      emissiveIntensity: 0.35,
      roughness: 0.25,
    });
    this.reverseLightMat = new THREE.MeshStandardMaterial({
      color: 0xe2e8f0,
      emissive: 0xf8fafc,
      emissiveIntensity: 0.0,
      roughness: 0.25,
    });

    const paintHex = getPaintColorHex(colorId ?? definition.defaultColorId);
    this.buildCarGeometry(paintHex);
    this.seatAvatarInsideCar();
  }

  public onOriginShift(shiftDelta: THREE.Vector3): void {
    this.rigidBody.state.position.sub(shiftDelta);
    this.chassisPivot.position.sub(shiftDelta);
    if (this.onFoot) {
      this.avatarWorldPos.sub(shiftDelta);
      this.avatar.root.position.sub(shiftDelta);
    }
  }

  public setPaintColor(colorId: string): void {
    const hex = getPaintColorHex(colorId);
    for (const mat of this.paintMaterials) {
      mat.color.setHex(hex);
    }
  }

  public placeAt(
    localPosition: THREE.Vector3,
    headingRad: number,
    streetName: string | null = null,
    speedLimitKmh = 50,
  ): void {
    this.rigidBody.state.position.copy(localPosition);
    this.rigidBody.state.velocity.set(0, 0, 0);
    this.chassisPivot.position.copy(localPosition);

    this.yawRad = -headingRad;
    this.fwdSpeed = 0;
    this.latSpeed = 0;
    this.yawRate = 0;
    this.steerAngleRad = 0;
    this.visualPitchRad = 0;
    this.visualRollRad = 0;
    this.groundPitchRad = 0;
    this.reverseEngaged = false;
    this.currentGearLabel = 'P';
    this.streetName = streetName;
    this.speedLimitKmh = speedLimitKmh;
    this.onRoad = true;

    this.chassisPivot.rotation.set(0, this.yawRad, 0, 'YXZ');
    this.suspensionBody.rotation.set(0, 0, 0);
    this.updateWheelTransforms();
  }

  public isOnFoot(): boolean {
    return this.onFoot;
  }

  public setOnFoot(exitCar: boolean, chunkStreamer?: ChunkStreamer): void {
    if (this.onFoot === exitCar) {
      return;
    }
    this.onFoot = exitCar;
    if (exitCar) {
      // Stop car cleanly if exiting at low speed
      if (Math.abs(this.fwdSpeed) < 3) {
        this.fwdSpeed = 0;
        this.latSpeed = 0;
      }
      // Step out just outside left driver door (-X in local car space)
      const doorOffset = new THREE.Vector3(-1.32, 0, -0.15).applyAxisAngle(
        new THREE.Vector3(0, 1, 0),
        this.yawRad,
      );
      this.avatarWorldPos.copy(this.chassisPivot.position).add(doorOffset);
      if (chunkStreamer) {
        const mapPos = chunkStreamer.getMapCoordinates(
          this.avatarWorldPos,
          this.tempMapPos,
        );
        const surf = chunkStreamer.sampleRoadSurface(
          mapPos.x,
          mapPos.y,
          mapPos.z,
        );
        this.avatarWorldPos.y = surf.elevationY;
      }
      this.avatarYawRad = this.yawRad;

      this.chassisPivot.remove(this.avatar.root);
      this.root.add(this.avatar.root);
      this.avatar.setMode('walking');
      this.avatar.setHeadVisible(true);
      this.avatar.root.position.copy(this.avatarWorldPos);
      this.avatar.root.rotation.set(0, this.avatarYawRad, 0, 'YXZ');
    } else {
      this.seatAvatarInsideCar();
    }
  }

  public getCarLocalPosition(target = new THREE.Vector3()): THREE.Vector3 {
    return target.copy(this.chassisPivot.position);
  }

  public getFocusLocalPosition(target = new THREE.Vector3()): THREE.Vector3 {
    return target.copy(
      this.onFoot ? this.avatar.root.position : this.chassisPivot.position,
    );
  }

  public getYawRad(): number {
    return this.onFoot ? this.avatarYawRad : this.yawRad;
  }

  public getCarYawRad(): number {
    return this.yawRad;
  }

  public getGroundPitchRad(): number {
    return this.groundPitchRad;
  }

  public getTelemetry(): VehicleTelemetry {
    const absSpeed = Math.abs(this.fwdSpeed);
    return {
      speedKmh: absSpeed * 3.6,
      signedSpeedMps: this.fwdSpeed,
      engineRpm: this.engineRpm,
      gearLabel: this.currentGearLabel,
      steeringAngleRad: this.steerAngleRad,
      headingRad: -this.yawRad,
      onRoad: this.onRoad,
      streetName: this.streetName,
      speedLimitKmh: this.speedLimitKmh,
      onFoot: this.onFoot,
    };
  }

  public setFirstPersonHeadHidden(hidden: boolean): void {
    this.avatar.setHeadVisible(!hidden);
    if (!this.onFoot) {
      this.avatar.root.visible = !hidden;
    } else {
      this.avatar.root.visible = true;
    }
  }

  /**
   * Advances physics (or on-foot walking avatar) at fixed 60 Hz timestep and
   * keeps both grounded onto Toronto's streamed 3D road elevation.
   */
  public step(
    dtSeconds: number,
    input: DrivingInputState,
    chunkStreamer: ChunkStreamer,
    cameraYawHintRad?: number,
  ): void {
    if (dtSeconds <= 0) {
      return;
    }

    if (this.onFoot) {
      this.stepWalkingAvatar(dtSeconds, input, chunkStreamer, cameraYawHintRad);
      // Still gently settle car if rolling when exited
      if (Math.abs(this.fwdSpeed) > 0.05) {
        this.stepVehiclePhysics(
          dtSeconds,
          {
            throttle: false,
            brakeReverse: false,
            steerLeft: false,
            steerRight: false,
            handbrake: true,
            sprint: false,
          },
          chunkStreamer,
        );
      }
      return;
    }

    this.stepVehiclePhysics(dtSeconds, input, chunkStreamer);
  }

  private stepWalkingAvatar(
    dtSeconds: number,
    input: DrivingInputState,
    chunkStreamer: ChunkStreamer,
    cameraYawHintRad?: number,
  ): void {
    const walkForward = (input.throttle ? 1 : 0) - (input.brakeReverse ? 1 : 0);
    const turnInput = (input.steerLeft ? 1 : 0) - (input.steerRight ? 1 : 0);

    if (cameraYawHintRad !== undefined && walkForward !== 0) {
      // Smoothly orient avatar with camera heading when walking
      const diff = Math.atan2(
        Math.sin(cameraYawHintRad - this.avatarYawRad),
        Math.cos(cameraYawHintRad - this.avatarYawRad),
      );
      this.avatarYawRad += diff * Math.min(1, dtSeconds * 8);
    } else {
      this.avatarYawRad += turnInput * 2.6 * dtSeconds;
    }

    const walkSpeed = input.sprint ? 5.8 : 3.2;
    const moveSpeed = walkForward * walkSpeed;
    const fx = -Math.sin(this.avatarYawRad);
    const fz = -Math.cos(this.avatarYawRad);

    this.avatarWorldPos.x += fx * moveSpeed * dtSeconds;
    this.avatarWorldPos.z += fz * moveSpeed * dtSeconds;

    const mapPos = chunkStreamer.getMapCoordinates(
      this.avatarWorldPos,
      this.tempMapPos,
    );
    const sample = chunkStreamer.sampleRoadSurface(
      mapPos.x,
      mapPos.y + 0.3,
      mapPos.z,
    );
    const targetY = sample.onRoad
      ? sample.elevationY
      : sample.elevationY + 0.12; // Sidewalk curb step height when off asphalt
    this.avatarWorldPos.y += (targetY - this.avatarWorldPos.y) * Math.min(1, dtSeconds * 16);

    this.avatar.root.position.copy(this.avatarWorldPos);
    this.avatar.root.rotation.set(0, this.avatarYawRad, 0, 'YXZ');
    this.avatar.updateWalkAnimation(dtSeconds, Math.abs(moveSpeed));
  }

  private stepVehiclePhysics(
    dtSeconds: number,
    input: DrivingInputState,
    chunkStreamer: ChunkStreamer,
  ): void {
    const { handling, dimensions } = this.definition;
    const speedAbs = Math.abs(this.fwdSpeed);

    // 1. Speed-sensitive steering (full tight lock for city turns, stable highway steer)
    const steerInput = (input.steerLeft ? 1 : 0) - (input.steerRight ? 1 : 0);
    const speedFactor = THREE.MathUtils.clamp(speedAbs / 34, 0, 1);
    const effectiveMaxSteer = THREE.MathUtils.lerp(
      handling.maxSteerRad,
      0.16,
      speedFactor * speedFactor,
    );
    const targetSteer = steerInput * effectiveMaxSteer;
    const steerRate = steerInput !== 0 ? 5.2 : 8.5;
    this.steerAngleRad +=
      (targetSteer - this.steerAngleRad) *
      (1 - Math.exp(-steerRate * dtSeconds));

    // 2. Intuitive Throttle / Brake / Auto-Reverse Logic
    let driveThrottle = 0;
    let brakeStrength = 0;

    if (input.handbrake) {
      brakeStrength = 1.0;
    }

    if (this.reverseEngaged) {
      if (input.throttle) {
        if (this.fwdSpeed < -0.6) {
          brakeStrength = Math.max(brakeStrength, 1.0);
        } else {
          this.reverseEngaged = false;
          driveThrottle = 1.0;
        }
      } else if (input.brakeReverse) {
        driveThrottle = -0.58;
      }
    } else {
      if (input.throttle) {
        driveThrottle = 1.0;
      } else if (input.brakeReverse) {
        if (this.fwdSpeed > 0.65) {
          brakeStrength = Math.max(brakeStrength, 1.0);
        } else if (speedAbs <= 0.65) {
          this.reverseEngaged = true;
          driveThrottle = -0.58;
        }
      }
    }

    // 3. Longitudinal force via Powertrain + drag + slope gravity
    const wheelAngVel = this.fwdSpeed / dimensions.wheelRadiusMeters;
    const torqueNm = this.powertrain.update(Math.abs(driveThrottle), wheelAngVel);
    const maxFwdMps = handling.maxSpeedKmh / 3.6;
    const maxRevMps = handling.maxReverseSpeedKmh / 3.6;

    let longForceN = 0;
    if (driveThrottle > 0 && this.fwdSpeed < maxFwdMps) {
      longForceN = torqueNm * handling.engineForceGain * driveThrottle;
    } else if (driveThrottle < 0 && this.fwdSpeed > -maxRevMps) {
      longForceN = torqueNm * handling.engineForceGain * 0.85 * driveThrottle;
    }

    // Aerodynamic drag + rolling resistance + subtle engine coasting drag
    const aeroDragN =
      0.5 * 1.225 * handling.dragArea * this.fwdSpeed * Math.abs(this.fwdSpeed);
    const rollingN =
      Math.abs(this.fwdSpeed) > 0.02
        ? Math.sign(this.fwdSpeed) *
          (180 + (driveThrottle === 0 ? 220 : 0))
        : 0;
    const slopeGravityN =
      -handling.massKg * 9.81 * Math.sin(this.groundPitchRad);

    longForceN += slopeGravityN - aeroDragN - rollingN;

    if (brakeStrength > 0) {
      if (speedAbs > 0.08) {
        longForceN -=
          Math.sign(this.fwdSpeed) *
          handling.massKg *
          handling.brakeDecelMps2 *
          brakeStrength;
      } else {
        this.fwdSpeed = 0;
        longForceN = 0;
      }
    }

    const prevFwd = this.fwdSpeed;
    const prevLat = this.latSpeed;
    const accelFwd = longForceN / handling.massKg;
    this.fwdSpeed = THREE.MathUtils.clamp(
      this.fwdSpeed + accelFwd * dtSeconds,
      -maxRevMps,
      maxFwdMps,
    );

    if (brakeStrength > 0 && Math.sign(prevFwd) !== Math.sign(this.fwdSpeed)) {
      this.fwdSpeed = 0;
    }

    // 4. Bicycle Lateral Tire Forces + Low-Speed Ackermann Stabilization
    const L = dimensions.wheelbaseMeters;
    const lf = L * 0.48;
    const lr = L * 0.52;
    const iz = handling.massKg * 1.65;
    const frontLoadN = handling.massKg * 9.81 * 0.52;
    const rearLoadN = handling.massKg * 9.81 * 0.48;

    if (this.fwdSpeed < 2.2) {
      // Smooth Ackermann steering for low speeds and all reverse maneuvers (zero reverse instability)
      const targetYawRate =
        (this.fwdSpeed / L) * Math.tan(this.steerAngleRad);
      this.yawRate += (targetYawRate - this.yawRate) * Math.min(1, dtSeconds * 16);
      this.latSpeed *= Math.exp(-14 * dtSeconds);
    } else {
      const vxRef = Math.max(speedAbs, 2.2);
      // Vehicle local coordinates: forward = -Z, right = +X, CCW left yawRate > 0
      const alphaF =
        Math.atan2(this.latSpeed - lf * this.yawRate, vxRef) +
        this.steerAngleRad;
      const alphaR = Math.atan2(this.latSpeed + lr * this.yawRate, vxRef);

      const frontTireRes = this.frontTire.computeForces(frontLoadN, 0, alphaF);
      const rearTireRes = this.rearTire.computeForces(
        rearLoadN * (input.handbrake ? 0.35 : 1.0),
        0,
        alphaR,
      );

      const latForceF = frontTireRes.lateralN;
      const latForceR = rearTireRes.lateralN;
      const totalLatForce = latForceF + latForceR;
      const yawTorque = -lf * latForceF + lr * latForceR;

      this.latSpeed +=
        (totalLatForce / handling.massKg + this.yawRate * this.fwdSpeed) *
        dtSeconds;
      this.latSpeed *= Math.exp(-1.2 * dtSeconds);
      this.yawRate += (yawTorque / iz) * dtSeconds;
      this.yawRate *= Math.exp(-1.5 * dtSeconds);
    }

    this.yawRad += this.yawRate * dtSeconds;

    // 5. Integrate World Displacement (forward = -Z in local car axes -> (-sin(yaw), -cos(yaw)))
    const fx = -Math.sin(this.yawRad);
    const fz = -Math.cos(this.yawRad);
    const rx = Math.cos(this.yawRad);
    const rz = -Math.sin(this.yawRad);

    const worldVx = fx * this.fwdSpeed + rx * this.latSpeed;
    const worldVz = fz * this.fwdSpeed + rz * this.latSpeed;

    this.tempRight.set(worldVx * handling.massKg, 0, worldVz * handling.massKg);
    this.rigidBody.state.velocity.set(worldVx, 0, worldVz);
    this.rigidBody.state.position.x += worldVx * dtSeconds;
    this.rigidBody.state.position.z += worldVz * dtSeconds;

    // 6. Road Elevation Grounding & Axle Slope Pitch
    const centerMap = chunkStreamer.getMapCoordinates(
      this.rigidBody.state.position,
      this.tempMapPos,
    );
    const centerSurf = chunkStreamer.sampleRoadSurface(
      centerMap.x,
      centerMap.y,
      centerMap.z,
    );
    this.onRoad = centerSurf.onRoad;
    if (centerSurf.streetName) {
      this.streetName = centerSurf.streetName;
    }
    this.speedLimitKmh = centerSurf.maxspeedKmh;

    const frontSurf = chunkStreamer.sampleRoadSurface(
      centerMap.x + fx * (L * 0.5),
      centerMap.y,
      centerMap.z + fz * (L * 0.5),
    );
    const rearSurf = chunkStreamer.sampleRoadSurface(
      centerMap.x - fx * (L * 0.5),
      centerMap.y,
      centerMap.z - fz * (L * 0.5),
    );
    const targetGroundPitch = Math.atan2(
      frontSurf.elevationY - rearSurf.elevationY,
      L,
    );
    this.groundPitchRad +=
      (targetGroundPitch - this.groundPitchRad) * Math.min(1, dtSeconds * 10);

    const targetY = centerSurf.elevationY;
    this.rigidBody.state.position.y +=
      (targetY - this.rigidBody.state.position.y) * Math.min(1, dtSeconds * 20);

    // 7. Suspension Pitch & Roll Feel
    const accelDelta = (this.fwdSpeed - prevFwd) / dtSeconds;
    const latAccel = (this.latSpeed - prevLat) / dtSeconds + this.fwdSpeed * this.yawRate;
    const suspF = this.frontSusp.computeForce(
      0.08 - accelDelta * 0.0025,
      dtSeconds,
    );
    const suspR = this.rearSusp.computeForce(
      0.08 + accelDelta * 0.0025,
      dtSeconds,
    );
    const pitchFromSusp = ((suspR - suspF) / 30000) * 0.045;
    const targetRoll = THREE.MathUtils.clamp(-latAccel * 0.006, -0.065, 0.065);

    this.visualPitchRad +=
      (pitchFromSusp - this.visualPitchRad) * Math.min(1, dtSeconds * 10);
    this.visualRollRad +=
      (targetRoll - this.visualRollRad) * Math.min(1, dtSeconds * 10);

    // 8. Gear & RPM Readout + Lighting
    this.updateGearAndRpm(Math.abs(driveThrottle));
    const isBraking = brakeStrength > 0 || (input.brakeReverse && this.fwdSpeed > 0.65);
    this.brakeLightMat.emissiveIntensity = isBraking ? 2.4 : 0.45;
    this.reverseLightMat.emissiveIntensity =
      this.reverseEngaged && this.fwdSpeed < -0.1 ? 1.8 : 0.0;

    // 9. Apply Visual Transforms & Wheel/Driver Animations
    this.chassisPivot.position.copy(this.rigidBody.state.position);
    this.chassisPivot.rotation.set(this.groundPitchRad, this.yawRad, 0, 'YXZ');
    this.suspensionBody.rotation.set(
      this.visualPitchRad,
      0,
      this.visualRollRad,
      'YXZ',
    );

    this.wheelSpinRad -=
      (this.fwdSpeed * dtSeconds) / dimensions.wheelRadiusMeters;
    this.updateWheelTransforms();
    this.avatar.updateSeatedPose(this.steerAngleRad);
  }

  private updateGearAndRpm(throttleAbs: number): void {
    const kmh = Math.abs(this.fwdSpeed) * 3.6;
    if (this.reverseEngaged) {
      this.currentGearLabel = 'R';
      this.engineRpm = Math.min(5800, 950 + kmh * 140 + throttleAbs * 700);
      return;
    }
    if (kmh < 0.3 && throttleAbs === 0) {
      this.currentGearLabel = 'D';
      this.engineRpm = 800;
      return;
    }
    const gearCutoffs = [22, 46, 74, 108, 160];
    let gear = 1;
    for (let i = 0; i < gearCutoffs.length; i++) {
      if (kmh > (gearCutoffs[i] ?? 160)) {
        gear = i + 2;
      }
    }
    gear = Math.min(5, gear);
    this.currentGearLabel = `D${gear}`;
    const prevTop = gear > 1 ? (gearCutoffs[gear - 2] ?? 0) : 0;
    const gearTop = gearCutoffs[gear - 1] ?? 160;
    const ratio = (kmh - prevTop) / Math.max(12, gearTop - prevTop);
    this.engineRpm = Math.round(
      THREE.MathUtils.clamp(1400 + ratio * 4100 + throttleAbs * 950, 800, 6500),
    );
  }

  private updateWheelTransforms(): void {
    this.frontLeftPivot.rotation.y = this.steerAngleRad;
    this.frontRightPivot.rotation.y = this.steerAngleRad;
    this.steeringWheelGroup.rotation.z = this.steerAngleRad * 6.0;
    for (const wheel of this.wheelSpinMeshes) {
      wheel.rotation.x = this.wheelSpinRad;
    }
  }

  private seatAvatarInsideCar(): void {
    this.onFoot = false;
    this.root.remove(this.avatar.root);
    this.suspensionBody.add(this.avatar.root);
    this.avatar.setMode('seated');
    this.avatar.setHeadVisible(true);
    // North American left-hand drive seat (x = -0.39 m) tucked cleanly under cabin roof
    this.avatar.root.position.set(-0.39, 0.14, 0.08);
    this.avatar.root.rotation.set(0, 0, 0);
  }

  private buildCarGeometry(paintHex: number): void {
    const {
      lengthMeters,
      widthMeters,
      wheelbaseMeters,
      trackWidthMeters,
      wheelRadiusMeters,
      wheelWidthMeters,
    } = this.definition.dimensions;

    const paintMat = new THREE.MeshStandardMaterial({
      color: paintHex,
      roughness: 0.28,
      metalness: 0.45,
    });
    this.paintMaterials.push(paintMat);

    const trimMat = new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      roughness: 0.72,
      metalness: 0.18,
    });
    const interiorMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.85,
      metalness: 0.08,
    });
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x94a3b8,
      roughness: 0.12,
      metalness: 0.15,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const headlightMat = new THREE.MeshStandardMaterial({
      color: 0xf8fafc,
      emissive: 0xfef9c3,
      emissiveIntensity: 1.5,
      roughness: 0.15,
    });
    const tireMat = new THREE.MeshStandardMaterial({
      color: 0x111827,
      roughness: 0.88,
      metalness: 0.05,
    });
    const alloyMat = new THREE.MeshStandardMaterial({
      color: 0xcbd5e1,
      roughness: 0.3,
      metalness: 0.75,
    });

    // Underbody tray & bumpers
    const floorPan = new THREE.Mesh(
      new THREE.BoxGeometry(widthMeters - 0.12, 0.14, lengthMeters - 0.08),
      trimMat,
    );
    floorPan.position.set(0, 0.24, 0);
    floorPan.castShadow = true;
    this.suspensionBody.add(floorPan);

    // Lower painted body belt (hood to trunk)
    const lowerBody = new THREE.Mesh(
      new THREE.BoxGeometry(widthMeters, 0.46, lengthMeters),
      paintMat,
    );
    lowerBody.position.set(0, 0.54, 0);
    lowerBody.castShadow = true;
    lowerBody.receiveShadow = true;
    this.suspensionBody.add(lowerBody);

    // Subtle sculpted hood bulge (visible in 1st-person & hood cams)
    const hood = new THREE.Mesh(
      new THREE.BoxGeometry(widthMeters - 0.16, 0.08, 1.38),
      paintMat,
    );
    hood.position.set(0, 0.80, -1.42);
    hood.rotation.x = 0.04;
    hood.castShadow = true;
    this.suspensionBody.add(hood);

    // Trunk decklid
    const trunk = new THREE.Mesh(
      new THREE.BoxGeometry(widthMeters - 0.16, 0.09, 0.82),
      paintMat,
    );
    trunk.position.set(0, 0.81, 1.70);
    trunk.castShadow = true;
    this.suspensionBody.add(trunk);

    // Roof cap & slim corner pillars (leaves interior open & glass translucent)
    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(widthMeters - 0.34, 0.06, 1.72),
      paintMat,
    );
    roof.position.set(0, 1.39, 0.20);
    roof.castShadow = true;
    this.suspensionBody.add(roof);

    const pillarPositions: Array<[number, number, number, number]> = [
      [-0.72, 1.09, -0.58, 0.46], // Front-left A-pillar
      [0.72, 1.09, -0.58, 0.46], // Front-right A-pillar
      [-0.72, 1.09, 1.06, -0.42], // Rear-left C-pillar
      [0.72, 1.09, 1.06, -0.42], // Rear-right C-pillar
    ];
    for (const [px, py, pz, tilt] of pillarPositions) {
      const pillar = new THREE.Mesh(
        new THREE.BoxGeometry(0.065, 0.68, 0.075),
        trimMat,
      );
      pillar.position.set(px, py, pz);
      pillar.rotation.x = tilt;
      this.suspensionBody.add(pillar);
    }

    // Translucent windshield, rear glass, and side windows
    const windshield = new THREE.Mesh(
      new THREE.PlaneGeometry(widthMeters - 0.32, 0.72),
      glassMat,
    );
    windshield.position.set(0, 1.09, -0.76);
    windshield.rotation.x = -Math.PI * 0.30;
    this.suspensionBody.add(windshield);

    const rearGlass = new THREE.Mesh(
      new THREE.PlaneGeometry(widthMeters - 0.34, 0.68),
      glassMat,
    );
    rearGlass.position.set(0, 1.09, 1.19);
    rearGlass.rotation.x = Math.PI * 0.31;
    this.suspensionBody.add(rearGlass);

    for (const sideSign of [-1, 1]) {
      const sideGlass = new THREE.Mesh(
        new THREE.PlaneGeometry(1.56, 0.52),
        glassMat,
      );
      sideGlass.position.set(sideSign * (widthMeters * 0.5 - 0.14), 1.09, 0.22);
      sideGlass.rotation.y = Math.PI * 0.5;
      this.suspensionBody.add(sideGlass);
    }

    // Minimalist interior dashboard + center console + rotating steering wheel (visible in 1st person!)
    const dash = new THREE.Mesh(
      new THREE.BoxGeometry(widthMeters - 0.28, 0.16, 0.38),
      interiorMat,
    );
    dash.position.set(0, 0.80, -0.62);
    this.suspensionBody.add(dash);

    const gaugeHood = new THREE.Mesh(
      new THREE.BoxGeometry(0.32, 0.07, 0.16),
      trimMat,
    );
    gaugeHood.position.set(-0.39, 0.90, -0.62);
    this.suspensionBody.add(gaugeHood);

    // Rotating steering wheel aligned cleanly on left-hand driver side
    this.steeringWheelGroup.position.set(-0.39, 0.95, -0.34);
    this.steeringWheelGroup.rotation.x = -0.34;
    const wheelRim = new THREE.Mesh(
      new THREE.TorusGeometry(0.155, 0.020, 10, 24),
      trimMat,
    );
    this.steeringWheelGroup.add(wheelRim);
    const spoke = new THREE.Mesh(
      new THREE.BoxGeometry(0.30, 0.032, 0.025),
      alloyMat,
    );
    this.steeringWheelGroup.add(spoke);
    const centerMarker = new THREE.Mesh(
      new THREE.BoxGeometry(0.025, 0.04, 0.03),
      new THREE.MeshBasicMaterial({ color: 0x38bdf8 }),
    );
    centerMarker.position.set(0, 0.165, 0);
    this.steeringWheelGroup.add(centerMarker);
    this.suspensionBody.add(this.steeringWheelGroup);

    // Front grille + headlights (front = -Z)
    const grille = new THREE.Mesh(
      new THREE.BoxGeometry(0.92, 0.19, 0.05),
      trimMat,
    );
    grille.position.set(0, 0.47, -lengthMeters * 0.5 - 0.005);
    this.suspensionBody.add(grille);

    const lightGeo = new THREE.BoxGeometry(0.32, 0.12, 0.05);
    for (const sideSign of [-1, 1]) {
      const hl = new THREE.Mesh(lightGeo, headlightMat);
      hl.position.set(sideSign * 0.64, 0.59, -lengthMeters * 0.5 - 0.005);
      this.suspensionBody.add(hl);

      const tl = new THREE.Mesh(lightGeo, this.brakeLightMat);
      tl.position.set(sideSign * 0.64, 0.62, lengthMeters * 0.5 + 0.005);
      this.suspensionBody.add(tl);

      const rl = new THREE.Mesh(
        new THREE.BoxGeometry(0.14, 0.08, 0.05),
        this.reverseLightMat,
      );
      rl.position.set(sideSign * 0.42, 0.60, lengthMeters * 0.5 + 0.006);
      this.suspensionBody.add(rl);
    }

    // 4 Articulated Wheels (front pair steer via frontLeftPivot/frontRightPivot)
    const halfWb = wheelbaseMeters * 0.5;
    const halfTrack = trackWidthMeters * 0.5;
    const tireGeo = new THREE.CylinderGeometry(
      wheelRadiusMeters,
      wheelRadiusMeters,
      wheelWidthMeters,
      20,
    );
    tireGeo.rotateZ(Math.PI * 0.5);

    const rimGeo = new THREE.CylinderGeometry(
      wheelRadiusMeters * 0.62,
      wheelRadiusMeters * 0.62,
      wheelWidthMeters + 0.014,
      12,
    );
    rimGeo.rotateZ(Math.PI * 0.5);

    const spokeBarGeo = new THREE.BoxGeometry(
      wheelWidthMeters + 0.02,
      0.045,
      wheelRadiusMeters * 1.15,
    );

    const createWheelSpinUnit = (): THREE.Group => {
      const spinGroup = new THREE.Group();
      const tire = new THREE.Mesh(tireGeo, tireMat);
      tire.castShadow = true;
      spinGroup.add(tire);
      const rim = new THREE.Mesh(rimGeo, alloyMat);
      spinGroup.add(rim);
      const spokeBar = new THREE.Mesh(spokeBarGeo, trimMat);
      spinGroup.add(spokeBar);
      this.wheelSpinMeshes.push(spinGroup);
      return spinGroup;
    };

    // Front Left & Right (-Z is front)
    this.frontLeftPivot.position.set(-halfTrack, wheelRadiusMeters, -halfWb);
    this.frontLeftPivot.add(createWheelSpinUnit());
    this.chassisPivot.add(this.frontLeftPivot);

    this.frontRightPivot.position.set(halfTrack, wheelRadiusMeters, -halfWb);
    this.frontRightPivot.add(createWheelSpinUnit());
    this.chassisPivot.add(this.frontRightPivot);

    // Rear Left & Right (+Z is rear)
    const rearLeft = createWheelSpinUnit();
    rearLeft.position.set(-halfTrack, wheelRadiusMeters, halfWb);
    this.chassisPivot.add(rearLeft);

    const rearRight = createWheelSpinUnit();
    rearRight.position.set(halfTrack, wheelRadiusMeters, halfWb);
    this.chassisPivot.add(rearRight);
  }

  public dispose(): void {
    this.unsubscribeOrigin();
    this.root.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        if (Array.isArray(obj.material)) {
          obj.material.forEach((m) => m.dispose());
        } else {
          obj.material.dispose();
        }
      }
    });
  }
}
