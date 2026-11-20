export interface IdmParams {
  desiredSpeedMps: number;
  timeHeadwaySeconds: number;
  minGapMeters: number;
  maxAccelerationMps2: number;
  comfortableDecelMps2: number;
  exponent: number;
}

/**
 * Intelligent Driver Model (IDM) longitudinal car-following acceleration.
 */
export class IdmModel {
  private readonly params: IdmParams;

  constructor(params: IdmParams) {
    this.params = params;
  }

  /**
   * Computes longitudinal acceleration (m/s^2) given speed, gap, and relative speed.
   */
  public computeAcceleration(
    speedMps: number,
    netGapMeters: number,
    approachingRateMps: number,
  ): number {
    const {
      desiredSpeedMps,
      timeHeadwaySeconds,
      minGapMeters,
      maxAccelerationMps2,
      comfortableDecelMps2,
      exponent,
    } = this.params;

    const safeDesiredSpeed = Math.max(0.1, desiredSpeedMps);
    const safeMaxAccel = Math.max(0.01, maxAccelerationMps2);
    const safeComfortableDecel = Math.max(0.01, comfortableDecelMps2);
    const safeSpeed = Math.max(0, speedMps);

    const freeFlowTerm = Math.pow(safeSpeed / safeDesiredSpeed, exponent);
    const desiredDynamicGap =
      minGapMeters +
      Math.max(
        0,
        safeSpeed * timeHeadwaySeconds +
          (safeSpeed * approachingRateMps) /
            (2 * Math.sqrt(safeMaxAccel * safeComfortableDecel)),
      );
    const safeGap = Math.max(0.1, netGapMeters);
    const interactionTerm = Math.pow(desiredDynamicGap / safeGap, 2);

    return safeMaxAccel * (1 - freeFlowTerm - interactionTerm);
  }
}
