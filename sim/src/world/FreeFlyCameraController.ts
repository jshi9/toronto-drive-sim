import * as THREE from 'three';
import type {
  FloatingOriginListener,
  FloatingOriginManager,
} from '../core/FloatingOriginManager.ts';

export interface FreeFlyOptions {
  baseSpeedMetersPerSec?: number;
  boostMultiplier?: number;
  lookSensitivity?: number;
  floatingOrigin?: FloatingOriginManager;
}

/**
 * Free-fly debug camera controller supporting WASD movement, vertical ascend/descend,
 * pointer-lock + drag mouse look, and floating-origin recentering.
 */
export class FreeFlyCameraController implements FloatingOriginListener {
  public readonly camera: THREE.PerspectiveCamera;
  private readonly domElement: HTMLElement;

  private baseSpeedMetersPerSec: number;
  private readonly boostMultiplier: number;
  private readonly lookSensitivity: number;

  private yaw = 0;
  private pitch = 0;
  private isDragging = false;
  private inputEnabled = true;
  private lastPointerX = 0;
  private lastPointerY = 0;

  private readonly keysDown = new Set<string>();
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly moveDelta = new THREE.Vector3();
  private readonly unsubscribeOrigin: (() => void) | null = null;

  constructor(
    camera: THREE.PerspectiveCamera,
    domElement: HTMLElement,
    options: FreeFlyOptions = {},
  ) {
    this.camera = camera;
    this.domElement = domElement;
    this.baseSpeedMetersPerSec = options.baseSpeedMetersPerSec ?? 45;
    this.boostMultiplier = options.boostMultiplier ?? 4;
    this.lookSensitivity = options.lookSensitivity ?? 0.0022;

    this.camera.rotation.order = 'YXZ';
    this.syncRotationFromCamera();

    if (options.floatingOrigin) {
      this.unsubscribeOrigin = options.floatingOrigin.subscribe(this);
    }

    this.attachEvents();
  }

  /**
   * Synchronizes internal yaw/pitch angles after calling camera.lookAt(...) externally.
   */
  public syncRotationFromCamera(): void {
    const euler = new THREE.Euler().setFromQuaternion(
      this.camera.quaternion,
      'YXZ',
    );
    this.yaw = euler.y;
    this.pitch = THREE.MathUtils.clamp(
      euler.x,
      -Math.PI * 0.49,
      Math.PI * 0.49,
    );
  }

  public getBaseSpeedMetersPerSec(): number {
    return this.baseSpeedMetersPerSec;
  }

  public isPointerLocked(): boolean {
    return document.pointerLockElement === this.domElement;
  }

  public setInputEnabled(enabled: boolean): void {
    this.inputEnabled = enabled;
    if (!enabled) {
      this.keysDown.clear();
      this.isDragging = false;
      if (document.pointerLockElement === this.domElement) {
        document.exitPointerLock?.();
      }
    }
  }

  /**
   * Returns camera horizontal heading in radians (0 = North/-Z, +pi/2 = East/+X).
   */
  public getHeadingRadians(): number {
    this.camera.getWorldDirection(this.forward);
    return Math.atan2(this.forward.x, -this.forward.z);
  }

  public onOriginShift(shiftDelta: THREE.Vector3): void {
    this.camera.position.sub(shiftDelta);
  }

  /**
   * Advances camera position based on active keyboard state and deltaSeconds.
   */
  public update(deltaSeconds: number): void {
    if (!this.inputEnabled || deltaSeconds <= 0) {
      return;
    }

    let forwardInput = 0;
    let rightInput = 0;
    let verticalInput = 0;

    if (this.keysDown.has('KeyW') || this.keysDown.has('ArrowUp')) {
      forwardInput += 1;
    }
    if (this.keysDown.has('KeyS') || this.keysDown.has('ArrowDown')) {
      forwardInput -= 1;
    }
    if (this.keysDown.has('KeyD') || this.keysDown.has('ArrowRight')) {
      rightInput += 1;
    }
    if (this.keysDown.has('KeyA') || this.keysDown.has('ArrowLeft')) {
      rightInput -= 1;
    }
    if (this.keysDown.has('KeyE') || this.keysDown.has('Space')) {
      verticalInput += 1;
    }
    if (
      this.keysDown.has('KeyQ') ||
      this.keysDown.has('KeyC') ||
      this.keysDown.has('ControlLeft')
    ) {
      verticalInput -= 1;
    }

    if (forwardInput === 0 && rightInput === 0 && verticalInput === 0) {
      return;
    }

    const boost =
      this.keysDown.has('ShiftLeft') || this.keysDown.has('ShiftRight')
        ? this.boostMultiplier
        : 1;
    const speed = this.baseSpeedMetersPerSec * boost;

    this.camera.getWorldDirection(this.forward);
    this.right.crossVectors(this.forward, this.camera.up).normalize();

    this.moveDelta.set(0, 0, 0);
    if (forwardInput !== 0) {
      this.moveDelta.addScaledVector(this.forward, forwardInput);
    }
    if (rightInput !== 0) {
      this.moveDelta.addScaledVector(this.right, rightInput);
    }
    if (verticalInput !== 0) {
      this.moveDelta.y += verticalInput;
    }

    if (this.moveDelta.lengthSq() > 1e-8) {
      this.moveDelta.normalize().multiplyScalar(speed * deltaSeconds);
      this.camera.position.add(this.moveDelta);
    }
  }

  public dispose(): void {
    this.detachEvents();
    this.unsubscribeOrigin?.();
  }

  private applyLookDelta(deltaX: number, deltaY: number): void {
    this.yaw -= deltaX * this.lookSensitivity;
    this.pitch = THREE.MathUtils.clamp(
      this.pitch - deltaY * this.lookSensitivity,
      -Math.PI * 0.49,
      Math.PI * 0.49,
    );
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement
    ) {
      return;
    }
    this.keysDown.add(event.code);
  };

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    this.keysDown.delete(event.code);
  };

  private readonly handleBlur = (): void => {
    this.keysDown.clear();
    this.isDragging = false;
  };

  private readonly handleMouseDown = (event: MouseEvent): void => {
    if (!this.inputEnabled) {
      return;
    }
    if (event.button === 0) {
      this.isDragging = true;
      this.lastPointerX = event.clientX;
      this.lastPointerY = event.clientY;
      if (document.pointerLockElement !== this.domElement) {
        try {
          const maybePromise = this.domElement.requestPointerLock() as unknown;
          if (
            maybePromise &&
            typeof (maybePromise as Promise<void>).catch === 'function'
          ) {
            (maybePromise as Promise<void>).catch(() => {
              // Pointer lock rejected (e.g. headless/iframe); drag fallback remains active.
            });
          }
        } catch {
          // Ignore pointer lock errors and rely on drag look fallback.
        }
      }
    }
  };

  private readonly handleMouseUp = (): void => {
    this.isDragging = false;
  };

  private readonly handleMouseMove = (event: MouseEvent): void => {
    if (document.pointerLockElement === this.domElement) {
      this.applyLookDelta(event.movementX, event.movementY);
      return;
    }
    if (this.isDragging) {
      const dx = event.clientX - this.lastPointerX;
      const dy = event.clientY - this.lastPointerY;
      this.lastPointerX = event.clientX;
      this.lastPointerY = event.clientY;
      this.applyLookDelta(dx, dy);
    }
  };

  private readonly handleWheel = (event: WheelEvent): void => {
    if (!this.inputEnabled) {
      return;
    }
    const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
    this.baseSpeedMetersPerSec = THREE.MathUtils.clamp(
      this.baseSpeedMetersPerSec * factor,
      8,
      400,
    );
  };

  private attachEvents(): void {
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleBlur);
    window.addEventListener('mouseup', this.handleMouseUp);
    window.addEventListener('mousemove', this.handleMouseMove);
    this.domElement.addEventListener('mousedown', this.handleMouseDown);
    this.domElement.addEventListener('wheel', this.handleWheel, {
      passive: true,
    });
  }

  private detachEvents(): void {
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleBlur);
    window.removeEventListener('mouseup', this.handleMouseUp);
    window.removeEventListener('mousemove', this.handleMouseMove);
    this.domElement.removeEventListener('mousedown', this.handleMouseDown);
    this.domElement.removeEventListener('wheel', this.handleWheel);
  }
}
