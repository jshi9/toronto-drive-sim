/**
 * Renders engine RPM and current gear indicator.
 */
export class Tachometer {
  private rpm = 800;
  private gear = 1;

  public update(rpm: number, gear: number): void {
    this.rpm = Math.max(0, rpm);
    this.gear = gear;
  }

  public getRpm(): number {
    return this.rpm;
  }

  public getGear(): number {
    return this.gear;
  }
}
