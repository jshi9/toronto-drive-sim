/**
 * Renders digital/analog vehicle speed in km/h.
 */
export class Speedometer {
  private speedKmh = 0;

  public update(speedMps: number): void {
    this.speedKmh = Math.max(0, speedMps * 3.6);
  }

  public getSpeedKmh(): number {
    return this.speedKmh;
  }
}
