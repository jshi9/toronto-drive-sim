export interface SuspensionConfig {
  restLengthMeters: number;
  springStiffnessNPerM: number;
  dampingNsPerM: number;
}

/**
 * Per-wheel spring-damper suspension force calculator.
 */
export class Suspension {
  public readonly config: SuspensionConfig;
  private previousCompressionMeters = 0;

  constructor(config: SuspensionConfig) {
    this.config = config;
  }

  /**
   * Computes vertical normal force in Newtons for the current compression.
   */
  public computeForce(compressionMeters: number, dtSeconds: number): number {
    const clampedCompression = Math.max(0, compressionMeters);
    const compressionVelocity =
      dtSeconds > 0
        ? (clampedCompression - this.previousCompressionMeters) / dtSeconds
        : 0;
    this.previousCompressionMeters = clampedCompression;

    const springForce = this.config.springStiffnessNPerM * clampedCompression;
    const damperForce = this.config.dampingNsPerM * compressionVelocity;
    return Math.max(0, springForce + damperForce);
  }
}
