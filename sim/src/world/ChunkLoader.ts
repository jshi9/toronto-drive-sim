export interface ChunkCoord {
  cx: number;
  cz: number;
}

/**
 * Streams spatial road/terrain chunks around the player's current position.
 */
export class ChunkLoader {
  public readonly chunkSizeMeters: number;
  private readonly loadedChunks = new Set<string>();

  constructor(chunkSizeMeters = 256) {
    this.chunkSizeMeters = chunkSizeMeters;
  }

  public getChunkKey(coord: ChunkCoord): string {
    return `${coord.cx}:${coord.cz}`;
  }

  public isLoaded(coord: ChunkCoord): boolean {
    return this.loadedChunks.has(this.getChunkKey(coord));
  }

  public markLoaded(coord: ChunkCoord): void {
    this.loadedChunks.add(this.getChunkKey(coord));
  }

  public unload(coord: ChunkCoord): void {
    this.loadedChunks.delete(this.getChunkKey(coord));
  }
}
