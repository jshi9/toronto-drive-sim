export interface TrafficAgentHandle {
  id: string;
  laneId: string;
  speedMps: number;
}

/**
 * Spawns and despawns ambient traffic agents within the active simulation bubble.
 */
export class TrafficSpawner {
  private readonly maxAgents: number;
  private readonly agents = new Map<string, TrafficAgentHandle>();

  constructor(maxAgents = 60) {
    this.maxAgents = maxAgents;
  }

  public getAgentCount(): number {
    return this.agents.size;
  }

  public getMaxAgents(): number {
    return this.maxAgents;
  }

  public registerAgent(agent: TrafficAgentHandle): boolean {
    if (this.agents.size >= this.maxAgents) {
      return false;
    }
    this.agents.set(agent.id, agent);
    return true;
  }

  public removeAgent(id: string): void {
    this.agents.delete(id);
  }
}
