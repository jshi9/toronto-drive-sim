export interface PowertrainState {
  engineRpm: number;
  currentGear: number;
  throttle: number;
}

/**
 * Engine torque curve, automatic/manual transmission, and driveline state.
 */
export class Powertrain {
  private state: PowertrainState = {
    engineRpm: 800,
    currentGear: 1,
    throttle: 0,
  };

  public getState(): Readonly<PowertrainState> {
    return this.state;
  }

  /**
   * Updates engine RPM and returns drive wheel torque in N*m.
   */
  public update(throttle: number, wheelSpeedRadPerSec: number): number {
    this.state.throttle = Math.min(1, Math.max(0, throttle));
    const idleRpm = 800;
    const redlineRpm = 6500;
    const estimatedRpm = Math.abs(wheelSpeedRadPerSec) * 95 + idleRpm;
    this.state.engineRpm = Math.min(redlineRpm, Math.max(idleRpm, estimatedRpm));
    return this.state.throttle * 260;
  }
}
