import { Clock } from './Clock.ts';

export interface FixedTimestepCallbacks {
  onFixedUpdate: (fixedDeltaSeconds: number) => void;
  onRender: (interpolationAlpha: number) => void;
}

/**
 * Deterministic fixed-timestep simulation loop with frame interpolation.
 */
export class FixedTimestepLoop {
  private readonly fixedDeltaSeconds: number;
  private readonly maxSubsteps: number;
  private readonly callbacks: FixedTimestepCallbacks;
  private readonly clock = new Clock();
  private accumulatorSeconds = 0;
  private rafId: number | null = null;
  private running = false;

  constructor(
    callbacks: FixedTimestepCallbacks,
    fixedHz = 60,
    maxSubsteps = 5,
  ) {
    this.callbacks = callbacks;
    this.fixedDeltaSeconds = 1 / fixedHz;
    this.maxSubsteps = maxSubsteps;
  }

  /**
   * Starts the animation frame loop.
   */
  public start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.clock.reset();
    this.accumulatorSeconds = 0;
    this.rafId = requestAnimationFrame(this.frame);
  }

  /**
   * Stops the animation frame loop.
   */
  public stop(): void {
    this.running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private readonly frame = (timestampMs: number): void => {
    if (!this.running) {
      return;
    }

    const deltaSeconds = this.clock.tick(timestampMs);
    this.accumulatorSeconds += deltaSeconds;

    let substeps = 0;
    while (
      this.accumulatorSeconds >= this.fixedDeltaSeconds &&
      substeps < this.maxSubsteps
    ) {
      this.callbacks.onFixedUpdate(this.fixedDeltaSeconds);
      this.accumulatorSeconds -= this.fixedDeltaSeconds;
      substeps += 1;
    }

    if (substeps === this.maxSubsteps) {
      this.accumulatorSeconds = 0;
    }

    const alpha = this.accumulatorSeconds / this.fixedDeltaSeconds;
    this.callbacks.onRender(alpha);

    this.rafId = requestAnimationFrame(this.frame);
  };
}
