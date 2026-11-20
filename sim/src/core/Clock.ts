/**
 * High-resolution simulation clock for measuring frame deltas.
 */
export class Clock {
  private lastTimestampMs: number | null = null;
  private elapsedSeconds = 0;

  /**
   * Advances the clock and returns the clamped delta time in seconds.
   */
  public tick(timestampMs: number, maxDeltaSeconds = 0.05): number {
    if (this.lastTimestampMs === null) {
      this.lastTimestampMs = timestampMs;
      return 0;
    }

    const rawDelta = Math.max(0, (timestampMs - this.lastTimestampMs) / 1000);
    this.lastTimestampMs = timestampMs;
    const clampedDelta = Math.min(rawDelta, maxDeltaSeconds);
    this.elapsedSeconds += clampedDelta;
    return clampedDelta;
  }

  /**
   * Returns total accumulated simulation time in seconds.
   */
  public getElapsedSeconds(): number {
    return this.elapsedSeconds;
  }

  /**
   * Resets clock timing state.
   */
  public reset(): void {
    this.lastTimestampMs = null;
    this.elapsedSeconds = 0;
  }
}
