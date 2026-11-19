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

    const freeFlowTerm = Math.pow(speedMps / desiredSpeedMps, exponent);
    const desiredDynamicGap =
      minGapMeters +
      Math.max(
        0,
        speedMps * timeHeadwaySeconds +
          (speedMps * approachingRateMps) /
            (2 * Math.sqrt(maxAccelerationMps2 * comfortableDecelMps2)),
      );
    const safeGap = Math.max(0.1, netGapMeters);
    const interactionTerm = Math.pow(desiredDynamicGap / safeGap, 2);

    return maxAccelerationMps2 * (1 - freeFlowTerm - interactionTerm);
  }
}
