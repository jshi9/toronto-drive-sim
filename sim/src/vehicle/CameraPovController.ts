import * as THREE from 'three';
import type {
  FloatingOriginListener,
  FloatingOriginManager,
} from '../core/FloatingOriginManager.ts';
import type { FreeFlyCameraController } from '../world/FreeFlyCameraController.ts';
import type { DrivableCar } from './DrivableCar.ts';

export type CameraPovMode =
  | 'third_person'
  | 'first_person'
  | 'hood'
  | 'bumper'
  | 'top_down'
  | 'free_fly';

export interface PovPresetInfo {
  id: CameraPovMode;
  label: string;
  defaultFov: number;
}

export const CAMERA_POV_LIST: readonly PovPresetInfo[] = [
  { id: 'third_person', label: '3rd Person', defaultFov: 65 },
  { id: 'first_person', label: '1st Person', defaultFov: 75 },
  { id: 'hood', label: 'Hood', defaultFov: 72 },
  { id: 'bumper', label: 'Bumper', defaultFov: 78 },
  { id: 'top_down', label: 'Top-Down', defaultFov: 55 },
  { id: 'free_fly', label: 'Free Fly', defaultFov: 60 },
];

export const FOV_PRESETS = [55, 65, 78, 90] as const;

/**
 * Manages switching cleanly between Third Person, First Person (Driver Seat / Walking),
 * Hood, Bumper, Top-Down, and Free Fly camera modes with adjustable FOV presets
 * and mouse drag orbit look.
 */
export class CameraPovController implements FloatingOriginListener {
  private readonly camera: THREE.PerspectiveCamera;
  private readonly domElement: HTMLElement;
  private readonly freeFly: FreeFlyCameraController;
  private readonly unsubscribeOrigin: () => void;

  private activeCar: DrivableCar | null = null;
  private mode: CameraPovMode = 'free_fly';
  private customFovDeg: number | null = null;
  private inputEnabled = true;

  private orbitYawOffset = 0;
  private orbitPitchOffset = 0.14;
  private isDragging = false;
  private lastPointerX = 0;
  private lastPointerY = 0;

  private readonly smoothedCamPos = new THREE.Vector3();
  private readonly smoothedLookAt = new THREE.Vector3();
  private cameraInitialized = false;

  private readonly targetPos = new THREE.Vector3();
  private readonly lookTarget = new THREE.Vector3();
  private readonly focusPos = new THREE.Vector3();
  private readonly scratchEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly scratchVecA = new THREE.Vector3();
  private readonly scratchVecB = new THREE.Vector3();
  private readonly onModeChange:
    | ((mode: CameraPovMode, fov: number) => void)
    | undefined;

  constructor(
    camera: THREE.PerspectiveCamera,
    domElement: HTMLElement,
    freeFly: FreeFlyCameraController,
    floatingOrigin: FloatingOriginManager,
    onModeChange?: (mode: CameraPovMode, fov: number) => void,
  ) {
    this.camera = camera;
    this.domElement = domElement;
    this.freeFly = freeFly;
    this.onModeChange = onModeChange;
    this.unsubscribeOrigin = floatingOrigin.subscribe(this);

    this.smoothedCamPos.copy(camera.position);
    this.attachPointerEvents();
  }

  public onOriginShift(shiftDelta: THREE.Vector3): void {
    this.smoothedCamPos.sub(shiftDelta);
    this.smoothedLookAt.sub(shiftDelta);
    if (this.mode !== 'free_fly') {
      this.camera.position.sub(shiftDelta);
    }
  }

  public setActiveCar(car: DrivableCar | null): void {
    if (this.activeCar && this.activeCar !== car) {
      this.activeCar.setFirstPersonHeadHidden(false);
    }
    this.activeCar = car;
    this.cameraInitialized = false;
    if (!car && this.mode !== 'free_fly') {
      this.setMode('free_fly');
    }
  }

  public getMode(): CameraPovMode {
    return this.mode;
  }

  public getEffectiveFov(): number {
    if (this.customFovDeg !== null) {
      return this.customFovDeg;
    }
    return (
      CAMERA_POV_LIST.find((item) => item.id === this.mode)?.defaultFov ?? 60
    );
  }

  public setFovDegrees(fovDeg: number | null): void {
    this.customFovDeg =
      fovDeg === null ? null : THREE.MathUtils.clamp(Math.round(fovDeg), 45, 105);
    this.onModeChange?.(this.mode, this.getEffectiveFov());
  }

  public setInputEnabled(enabled: boolean): void {
    this.inputEnabled = enabled;
    if (!enabled) {
      this.isDragging = false;
    }
    this.freeFly.setInputEnabled(enabled && this.mode === 'free_fly');
  }

  public setMode(mode: CameraPovMode): void {
    const resolvedMode = !this.activeCar ? 'free_fly' : mode;
    const prevMode = this.mode;
    this.mode = resolvedMode;

    const isFreeFly = resolvedMode === 'free_fly';
    this.freeFly.setInputEnabled(this.inputEnabled && isFreeFly);

    if (prevMode !== resolvedMode) {
      if (resolvedMode === 'first_person') {
        this.orbitYawOffset = 0;
        this.orbitPitchOffset = -0.04;
      } else if (resolvedMode === 'third_person') {
        this.orbitYawOffset = 0;
        this.orbitPitchOffset = 0.16;
      } else {
        this.orbitYawOffset = 0;
        this.orbitPitchOffset = 0;
      }
      this.cameraInitialized = false;
    }

    if (isFreeFly) {
      this.freeFly.syncRotationFromCamera();
    }

    if (this.activeCar) {
      this.activeCar.setFirstPersonHeadHidden(resolvedMode === 'first_person');
    }

    this.onModeChange?.(this.mode, this.getEffectiveFov());
  }

  public cycleMode(): CameraPovMode {
    if (!this.activeCar) {
      return 'free_fly';
    }
    const order = CAMERA_POV_LIST.map((p) => p.id);
    const idx = order.indexOf(this.mode);
    const next = order[(idx + 1) % order.length] ?? 'third_person';
    this.setMode(next);
    return next;
  }

  public getActiveHeadingRadians(): number {
    if (this.activeCar && this.mode !== 'free_fly') {
      return -this.activeCar.getYawRad();
    }
    return this.freeFly.getHeadingRadians();
  }

  public getWalkCameraYawHintRadians(): number {
    return (this.activeCar?.getYawRad() ?? 0) + this.orbitYawOffset;
  }

  public update(dtSeconds: number): void {
    const targetFov = this.getEffectiveFov();
    const speedKmh = this.activeCar ? this.activeCar.getTelemetry().speedKmh : 0;
    const dynamicSpeedBoost =
      this.mode === 'third_person' || this.mode === 'hood' || this.mode === 'bumper'
        ? Math.min(7, speedKmh * 0.05)
        : 0;
    const desiredFov = targetFov + dynamicSpeedBoost;
    if (Math.abs(this.camera.fov - desiredFov) > 0.05) {
      this.camera.fov +=
        (desiredFov - this.camera.fov) * Math.min(1, dtSeconds * 8);
      this.camera.updateProjectionMatrix();
    }

    if (this.mode === 'free_fly' || !this.activeCar) {
      this.freeFly.update(dtSeconds);
      return;
    }

    const car = this.activeCar;
    const onFoot = car.isOnFoot();
    car.setFirstPersonHeadHidden(this.mode === 'first_person');
    car.getFocusLocalPosition(this.focusPos);
    const baseYaw = car.getYawRad();

    // Gently re-center behind vehicle while moving if not manually orbiting
    if (!this.isDragging && this.mode === 'third_person' && !onFoot && speedKmh > 6) {
      this.orbitYawOffset *= Math.exp(-2.6 * dtSeconds);
    }

    const combinedYaw = baseYaw + this.orbitYawOffset;
    const fx = -Math.sin(combinedYaw);
    const fz = -Math.cos(combinedYaw);

    if (onFoot) {
      if (this.mode === 'first_person') {
        this.targetPos.set(
          this.focusPos.x,
          this.focusPos.y + 1.56,
          this.focusPos.z,
        );
        this.lookTarget.set(
          this.targetPos.x + fx * 12,
          this.targetPos.y + Math.sin(-this.orbitPitchOffset) * 12,
          this.targetPos.z + fz * 12,
        );
        this.camera.position.copy(this.targetPos);
        this.camera.lookAt(this.lookTarget);
        return;
      }

      if (this.mode === 'top_down') {
        this.targetPos.set(
          this.focusPos.x - fx * 4.5,
          this.focusPos.y + 16,
          this.focusPos.z - fz * 4.5,
        );
        this.lookTarget.set(this.focusPos.x, this.focusPos.y + 1.0, this.focusPos.z);
      } else {
        // Third-person walking behind avatar
        const dist = 3.6;
        const elev = 1.65 + Math.sin(this.orbitPitchOffset) * 1.4;
        this.targetPos.set(
          this.focusPos.x - fx * dist,
          this.focusPos.y + Math.max(0.7, elev),
          this.focusPos.z - fz * dist,
        );
        this.lookTarget.set(
          this.focusPos.x,
          this.focusPos.y + 1.25,
          this.focusPos.z,
        );
      }
      this.applySmoothedFollow(dtSeconds, 12);
      return;
    }

    // Driving POV modes inside/around the car
    this.scratchEuler.set(car.getGroundPitchRad(), baseYaw, 0, 'YXZ');
    if (this.mode === 'first_person') {
      // Driver seat left-side eye position (x = -0.39 m, y = 1.15 m, z = 0.06 m)
      const eyeOffset = this.scratchVecA.set(-0.39, 1.15, 0.06).applyEuler(this.scratchEuler);
      this.camera.position.copy(this.focusPos).add(eyeOffset);

      const lookLocal = this.scratchVecB
        .set(
          -Math.sin(this.orbitYawOffset) * 14,
          -Math.sin(this.orbitPitchOffset + 0.06) * 14,
          -Math.cos(this.orbitYawOffset) * 14,
        )
        .applyEuler(this.scratchEuler);
      this.lookTarget.copy(this.camera.position).add(lookLocal);
      this.camera.lookAt(this.lookTarget);
      return;
    }

    if (this.mode === 'hood') {
      const mount = this.scratchVecA.set(0, 1.13, -0.78).applyEuler(this.scratchEuler);
      const ahead = this.scratchVecB.set(0, 0.96, -18).applyEuler(this.scratchEuler);
      this.camera.position.copy(this.focusPos).add(mount);
      this.lookTarget.copy(this.focusPos).add(ahead);
      this.camera.lookAt(this.lookTarget);
      return;
    }

    if (this.mode === 'bumper') {
      const mount = this.scratchVecA.set(0, 0.54, -2.22).applyEuler(this.scratchEuler);
      const ahead = this.scratchVecB.set(0, 0.56, -20).applyEuler(this.scratchEuler);
      this.camera.position.copy(this.focusPos).add(mount);
      this.lookTarget.copy(this.focusPos).add(ahead);
      this.camera.lookAt(this.lookTarget);
      return;
    }

    if (this.mode === 'top_down') {
      this.targetPos.set(
        this.focusPos.x - fx * 5.2,
        this.focusPos.y + 20.5,
        this.focusPos.z - fz * 5.2,
      );
      this.lookTarget.set(
        this.focusPos.x + fx * 3.2,
        this.focusPos.y + 0.6,
        this.focusPos.z + fz * 3.2,
      );
      this.applySmoothedFollow(dtSeconds, 10);
      return;
    }

    // Default: Smooth Third-Person Chase
    const speedExtraDist = Math.min(1.6, speedKmh * 0.015);
    const chaseDist = 5.9 + speedExtraDist;
    const pitchLift = THREE.MathUtils.clamp(this.orbitPitchOffset, -0.1, 0.85);
    const height = 2.0 + Math.sin(pitchLift) * 2.6;
    this.targetPos.set(
      this.focusPos.x - fx * chaseDist,
      this.focusPos.y + height,
      this.focusPos.z - fz * chaseDist,
    );
    this.lookTarget.set(
      this.focusPos.x + fx * 2.2,
      this.focusPos.y + 1.1,
      this.focusPos.z + fz * 2.2,
    );
    this.applySmoothedFollow(dtSeconds, 11);
  }

  private applySmoothedFollow(dtSeconds: number, stiffness: number): void {
    if (!this.cameraInitialized) {
      this.smoothedCamPos.copy(this.targetPos);
      this.smoothedLookAt.copy(this.lookTarget);
      this.cameraInitialized = true;
    } else {
      const blend = 1 - Math.exp(-stiffness * dtSeconds);
      this.smoothedCamPos.lerp(this.targetPos, blend);
      this.smoothedLookAt.lerp(this.lookTarget, blend);
    }
    this.camera.position.copy(this.smoothedCamPos);
    this.camera.lookAt(this.smoothedLookAt);
  }

  private readonly handleMouseDown = (event: MouseEvent): void => {
    if (!this.inputEnabled || this.mode === 'free_fly') {
      return;
    }
    if (event.target !== this.domElement) {
      return;
    }
    this.isDragging = true;
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
  };

  private readonly handleMouseMove = (event: MouseEvent): void => {
    if (!this.inputEnabled || !this.isDragging || this.mode === 'free_fly') {
      return;
    }
    const dx = event.clientX - this.lastPointerX;
    const dy = event.clientY - this.lastPointerY;
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;

    this.orbitYawOffset -= dx * 0.005;
    this.orbitPitchOffset = THREE.MathUtils.clamp(
      this.orbitPitchOffset + dy * 0.004,
      -0.35,
      0.85,
    );
  };

  private readonly handleMouseUp = (): void => {
    this.isDragging = false;
  };

  private attachPointerEvents(): void {
    this.domElement.addEventListener('mousedown', this.handleMouseDown);
    window.addEventListener('mousemove', this.handleMouseMove);
    window.addEventListener('mouseup', this.handleMouseUp);
  }

  public dispose(): void {
    this.unsubscribeOrigin();
    this.domElement.removeEventListener('mousedown', this.handleMouseDown);
    window.removeEventListener('mousemove', this.handleMouseMove);
    window.removeEventListener('mouseup', this.handleMouseUp);
  }
}
