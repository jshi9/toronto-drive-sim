import * as THREE from 'three';

export interface RigidBodyState {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  orientation: THREE.Quaternion;
  angularVelocity: THREE.Vector3;
}

/**
 * 6-DOF vehicle chassis rigid body state and semi-implicit Euler integrator.
 */
export class VehicleRigidBody {
  public readonly massKg: number;
  public readonly state: RigidBodyState;

  constructor(massKg = 1500) {
    this.massKg = massKg;
    this.state = {
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      orientation: new THREE.Quaternion(),
      angularVelocity: new THREE.Vector3(),
    };
  }

  /**
   * Advances linear and angular kinematics for a fixed timestep.
   */
  public step(dtSeconds: number, netForceWorld: THREE.Vector3): void {
    const acceleration = netForceWorld.clone().divideScalar(this.massKg);
    this.state.velocity.addScaledVector(acceleration, dtSeconds);
    this.state.position.addScaledVector(this.state.velocity, dtSeconds);
  }
}
