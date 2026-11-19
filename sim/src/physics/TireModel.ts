export interface TireForces {
  longitudinalN: number;
  lateralN: number;
}

/**
 * Simplified Pacejka-style tire force model.
 */
export class TireModel {
  private readonly peakGripCoeff: number;

  constructor(peakGripCoeff = 1.0) {
    this.peakGripCoeff = peakGripCoeff;
  }

  /**
   * Computes longitudinal and lateral tire forces from slip ratio and slip angle.
   */
  public computeForces(
    normalLoadN: number,
    slipRatio: number,
    slipAngleRad: number,
  ): TireForces {
    const maxForce = Math.max(0, normalLoadN) * this.peakGripCoeff;
    const longitudinalN = maxForce * Math.tanh(slipRatio * 8);
    const lateralN = -maxForce * Math.tanh(slipAngleRad * 6);
    return { longitudinalN, lateralN };
  }
}
