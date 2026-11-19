export type HtaRuleCode =
  | 'SPEEDING'
  | 'RED_LIGHT'
  | 'STOP_SIGN'
  | 'LANE_DISCIPLINE';

export interface HtaContextSnapshot {
  speedKmh: number;
  postedLimitKmh: number;
  crossedStopLineOnRed: boolean;
}

/**
 * Monitors player driving telemetry against Ontario Highway Traffic Act rules.
 */
export class HtaMonitor {
  private readonly speedToleranceKmh: number;

  constructor(speedToleranceKmh = 5) {
    this.speedToleranceKmh = speedToleranceKmh;
  }

  /**
   * Evaluates the current telemetry frame and returns active rule codes.
   */
  public evaluate(snapshot: HtaContextSnapshot): HtaRuleCode[] {
    const violations: HtaRuleCode[] = [];
    if (snapshot.speedKmh > snapshot.postedLimitKmh + this.speedToleranceKmh) {
      violations.push('SPEEDING');
    }
    if (snapshot.crossedStopLineOnRed) {
      violations.push('RED_LIGHT');
    }
    return violations;
  }
}
