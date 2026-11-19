import type { HtaRuleCode } from './HtaMonitor.ts';

export interface ViolationRecord {
  code: HtaRuleCode;
  timestampSeconds: number;
  demeritPoints: number;
  description: string;
}

/**
 * Records Ontario HTA infractions and cumulative demerit points during a session.
 */
export class ViolationTracker {
  private readonly records: ViolationRecord[] = [];

  public record(violation: ViolationRecord): void {
    this.records.push(violation);
  }

  public getRecords(): readonly ViolationRecord[] {
    return this.records;
  }

  public getTotalDemeritPoints(): number {
    return this.records.reduce((total, entry) => total + entry.demeritPoints, 0);
  }

  public clear(): void {
    this.records.length = 0;
  }
}
