export interface MobilParams {
  politeness: number;
  changingThresholdMps2: number;
  maxSafeDecelMps2: number;
}

/**
 * MOBIL (Minimizing Overall Braking Induced by Lane changes) lane-change model.
 */
export class MobilModel {
  private readonly params: MobilParams;

  constructor(params: MobilParams) {
    this.params = params;
  }

  /**
   * Evaluates safety and incentive criteria for a candidate lane change.
   */
  public shouldChangeLane(
    egoAccelGainMps2: number,
    oldFollowerAccelDeltaMps2: number,
    newFollowerAccelDeltaMps2: number,
    newFollowerNewAccelMps2: number,
  ): boolean {
    if (newFollowerNewAccelMps2 < -this.params.maxSafeDecelMps2) {
      return false;
    }

    const totalIncentive =
      egoAccelGainMps2 +
      this.params.politeness *
        (oldFollowerAccelDeltaMps2 + newFollowerAccelDeltaMps2);

    return totalIncentive > this.params.changingThresholdMps2;
  }
}
