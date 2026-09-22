/**
 * Uniform spatial hash grid.
 *
 * Used for every "what is near me" query in the simulation. Determinism
 * matters: buckets are plain arrays appended to in entity-id order, so query
 * results are always produced in a stable order.
 */
export class SpatialGrid {
  readonly cell: number;
  readonly cols: number;
  readonly rows: number;
  private readonly buckets: number[][];

  constructor(width: number, height: number, cell: number) {
    this.cell = cell;
    this.cols = Math.max(1, Math.ceil(width / cell));
    this.rows = Math.max(1, Math.ceil(height / cell));
    this.buckets = new Array(this.cols * this.rows);
    for (let i = 0; i < this.buckets.length; i++) this.buckets[i] = [];
  }

  clear(): void {
    for (let i = 0; i < this.buckets.length; i++) {
      if (this.buckets[i].length > 0) this.buckets[i].length = 0;
    }
  }

  insert(index: number, x: number, y: number): void {
    // Guard against non-finite coordinates.
    //
    // A single NaN position used to index `buckets[NaN]`, which is `undefined`,
    // and the resulting `Cannot read properties of undefined` crashed the whole
    // simulation with no hint as to which entity was at fault. Failing loudly
    // with the coordinates attached turns a mystery into a one-line diagnosis,
    // and skipping the insert keeps the rest of the world running.
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`SpatialGrid.insert: non-finite position (${x}, ${y}) for index ${index}`);
    }
    const cx = this.clampCol(Math.floor(x / this.cell));
    const cy = this.clampRow(Math.floor(y / this.cell));
    this.buckets[cy * this.cols + cx].push(index);
  }

  private clampCol(cx: number): number {
    return cx < 0 ? 0 : cx >= this.cols ? this.cols - 1 : cx;
  }

  private clampRow(cy: number): number {
    return cy < 0 ? 0 : cy >= this.rows ? this.rows - 1 : cy;
  }

  /**
   * Collect every index whose cell overlaps the circle.
   * Results are pushed into `out` (which is cleared first) and the number of
   * results is returned, so callers can reuse a single scratch array.
   */
  queryCircle(x: number, y: number, radius: number, out: number[]): number {
    out.length = 0;
    const minX = this.clampCol(Math.floor((x - radius) / this.cell));
    const maxX = this.clampCol(Math.floor((x + radius) / this.cell));
    const minY = this.clampRow(Math.floor((y - radius) / this.cell));
    const maxY = this.clampRow(Math.floor((y + radius) / this.cell));
    for (let cy = minY; cy <= maxY; cy++) {
      const rowOffset = cy * this.cols;
      for (let cx = minX; cx <= maxX; cx++) {
        const bucket = this.buckets[rowOffset + cx];
        for (let i = 0; i < bucket.length; i++) out.push(bucket[i]);
      }
    }
    return out.length;
  }
}
