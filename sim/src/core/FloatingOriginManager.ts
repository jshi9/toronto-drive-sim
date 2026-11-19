import * as THREE from 'three';

export interface FloatingOriginListener {
  onOriginShift: (shiftDelta: THREE.Vector3) => void;
}

/**
 * Keeps render coordinates near the local origin to preserve float32 precision
 * across large projected coordinate spaces (e.g., UTM meters in Toronto).
 */
export class FloatingOriginManager {
  private readonly worldOrigin = new THREE.Vector3();
  private readonly shiftThresholdMeters: number;
  private readonly listeners = new Set<FloatingOriginListener>();

  constructor(shiftThresholdMeters = 500) {
    this.shiftThresholdMeters = shiftThresholdMeters;
  }

  /**
   * Registers a listener notified whenever the local origin shifts.
   */
  public subscribe(listener: FloatingOriginListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Returns a copy of the current world-space origin offset.
   */
  public getWorldOrigin(target = new THREE.Vector3()): THREE.Vector3 {
    return target.copy(this.worldOrigin);
  }

  /**
   * Checks whether the camera/player local position exceeds the threshold and
   * recenter-shifts subscribed objects if needed. Returns true when shifted.
   */
  public update(localFocusPosition: THREE.Vector3): boolean {
    const horizontalDistSq =
      localFocusPosition.x * localFocusPosition.x +
      localFocusPosition.z * localFocusPosition.z;

    if (horizontalDistSq <= this.shiftThresholdMeters * this.shiftThresholdMeters) {
      return false;
    }

    const shiftDelta = new THREE.Vector3(
      localFocusPosition.x,
      0,
      localFocusPosition.z,
    );
    this.worldOrigin.add(shiftDelta);

    for (const listener of this.listeners) {
      listener.onOriginShift(shiftDelta);
    }
    return true;
  }
}
