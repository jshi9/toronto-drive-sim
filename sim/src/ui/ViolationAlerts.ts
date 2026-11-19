import type { ViolationRecord } from '../rules/ViolationTracker.ts';

/**
 * Displays transient HUD alerts when Ontario HTA violations occur.
 */
export class ViolationAlerts {
  private activeAlert: ViolationRecord | null = null;

  public push(record: ViolationRecord): void {
    this.activeAlert = record;
  }

  public getActiveAlert(): ViolationRecord | null {
    return this.activeAlert;
  }

  public dismiss(): void {
    this.activeAlert = null;
  }
}
