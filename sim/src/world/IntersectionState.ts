export type SignalAspect = 'green' | 'amber' | 'red';

export interface SignalPhase {
  approachId: string;
  aspect: SignalAspect;
  remainingSeconds: number;
}

/**
 * Tracks signalized and unsignalized intersection phase state.
 */
export class IntersectionState {
  public readonly intersectionId: string;
  private readonly phases = new Map<string, SignalPhase>();

  constructor(intersectionId: string) {
    this.intersectionId = intersectionId;
  }

  public setPhase(phase: SignalPhase): void {
    this.phases.set(phase.approachId, phase);
  }

  public getPhase(approachId: string): SignalPhase | undefined {
    return this.phases.get(approachId);
  }
}
