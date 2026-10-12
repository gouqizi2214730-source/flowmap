import { rowToPrice, type PriceScale } from './priceScale';
import type { DepthResolutionRange } from '../net/depthResolution';

/** Sorted disjoint segments preserve the greatest source width in overlaps. */
function resolutionSegments(ranges: readonly DepthResolutionRange[]): DepthResolutionRange[] {
  const events = ranges.flatMap(([lo, hi, width]) => [[lo, width, 1], [hi, width, -1]]);
  events.sort((a, b) => a[0] - b[0]);
  const counts = new Map<number, number>(), heap: number[] = [], result: DepthResolutionRange[] = [];
  const push = (width: number) => {
    let i = heap.length; heap.push(width);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent] >= width) break;
      heap[i] = heap[parent]; i = parent;
    }
    heap[i] = width;
  };
  const maximum = () => {
    while (heap.length && !counts.get(heap[0])) {
      const tail = heap.pop()!;
      if (!heap.length) break;
      let i = 0;
      while (2 * i + 1 < heap.length) {
        let child = 2 * i + 1;
        if (child + 1 < heap.length && heap[child + 1] > heap[child]) child++;
        if (heap[child] <= tail) break;
        heap[i] = heap[child]; i = child;
      }
      heap[i] = tail;
    }
    return heap[0] ?? 0;
  };
  let previous = events[0]?.[0] ?? 0, index = 0;
  while (index < events.length) {
    const price = events[index][0], width = maximum();
    if (price > previous && width > 0) {
      const last = result.at(-1);
      if (last && last[1] === previous && last[2] === width) result[result.length - 1] = [last[0], price, width];
      else result.push([previous, price, width]);
    }
    while (index < events.length && events[index][0] === price) {
      const [, w, change] = events[index++], count = counts.get(w) ?? 0;
      counts.set(w, count + change);
      if (change > 0 && count === 0) push(w);
    }
    previous = price;
  }
  return result;
}

/** Native geometry travels with each column, rather than reinterpreting history
 * when the fine-price core follows the market. Two RGBA texels per column. */
export class ColumnGeometry {
  private textureN: WebGLTexture | null = null;
  private scratch = new Float32Array(8);
  private mirror: Float32Array;
  private dirty = false;
  private resolutionN: WebGLTexture | null = null;
  private resolutionMirror: Float32Array | null = null;
  private resolutionDirty = false;
  private readonly resolutionRanges = new Map<number, readonly DepthResolutionRange[]>();
  private resolutionHeight = 0;
  constructor(private gl: WebGL2RenderingContext, private cols: number, private layers: number) { this.mirror = new Float32Array(cols * layers * 8); }
  get texture(): WebGLTexture | null { return this.textureN; }
  get resolutionTexture(): WebGLTexture | null { return this.resolutionN; }
  /** Exact disjoint intervals are packed into an atlas after one header per
   * resident column. Header offset/count avoids padding every column to the
   * largest interval list and preserves holes without an eight-range cap. */
  setResolution(col: number, scale: PriceScale, ranges: readonly DepthResolutionRange[] = []): void {
    if (!ranges.length && !this.resolutionRanges.size) return;
    const slot = ((col % (this.cols * this.layers)) + this.cols * this.layers) % (this.cols * this.layers);
    const origin = scale.kind === 'hybrid' ? scale.coreP0 : scale.p0;
    if (ranges.some(r => !r.every(Number.isFinite) || !(r[1] > r[0]) || !(r[2] > 0))) {
      throw new RangeError('flowmap: invalid source resolution interval');
    }
    if (ranges.length) this.resolutionRanges.set(slot, resolutionSegments(ranges).map(r => [r[0] - origin, r[1] - origin, r[2]]));
    else this.resolutionRanges.delete(slot);
    this.resolutionDirty = true;
  }
  flushResolution(): void {
    if (!this.resolutionDirty) return;
    const gl = this.gl;
    const slots = this.cols * this.layers;
    let pixels = slots;
    for (const ranges of this.resolutionRanges.values()) pixels += ranges.length;
    const neededHeight = Math.ceil(pixels / this.cols);
    const limit = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 4096;
    if (neededHeight > limit || this.cols * neededHeight * 16 > 16 * 1024 * 1024) {
      throw new RangeError('flowmap: exact source resolution exceeds the resident GPU budget');
    }
    if (!this.resolutionMirror || this.resolutionMirror.length < this.cols * neededHeight * 4) {
      this.resolutionMirror = new Float32Array(this.cols * neededHeight * 4);
    } else this.resolutionMirror.fill(0);
    let cursor = slots;
    for (const [slot, ranges] of this.resolutionRanges) {
      this.resolutionMirror.set([cursor, ranges.length, 0, 0], slot * 4);
      for (const range of ranges) {
        this.resolutionMirror.set([range[0], range[1], range[2], 1], cursor++ * 4);
      }
    }
    const height = this.resolutionMirror.length / (this.cols * 4);
    if (!this.resolutionN || this.resolutionHeight < height) {
      if (this.resolutionN) gl.deleteTexture(this.resolutionN);
      this.resolutionN = gl.createTexture();
      if (!this.resolutionN) throw new Error('flowmap: resolution metadata allocation failed');
      gl.bindTexture(gl.TEXTURE_2D, this.resolutionN);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, this.cols, height);
      this.resolutionHeight = height;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    } else gl.bindTexture(gl.TEXTURE_2D, this.resolutionN);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.cols, height, gl.RGBA, gl.FLOAT, this.resolutionMirror);
    this.resolutionDirty = false;
  }
  set(col: number, scale: PriceScale, _epoch: number): void {
    const d = this.scratch;
    if (scale.kind === 'hybrid') {
      const end = scale.coreP0 + scale.coreRows * scale.coreStep;
      d.set([scale.dnRows, scale.coreRows, scale.coreStep, scale.coreP0,
        Math.log(scale.coreP0 / scale.loPrice) / Math.max(1, scale.dnRows),
        Math.log(scale.hiPrice / end) / Math.max(1, scale.rows - scale.dnRows - scale.coreRows), 0,
        scale.coreP0 - Math.fround(scale.coreP0)]);
    } else d.set([-1, scale.rows, scale.step, scale.p0, 0, 0, 0, scale.p0 - Math.fround(scale.p0)]);
    const slot = ((col % (this.cols * this.layers)) + this.cols * this.layers) % (this.cols * this.layers);
    // Flush once before the draw: a history page updates one small metadata
    // texture, with no depth reraster and no per-column GL state changes.
    const offset = (Math.floor(slot / this.cols) * this.cols * 2 + slot % this.cols) * 4;
    this.mirror.set(d.subarray(0, 4), offset);
    this.mirror.set(d.subarray(4), offset + this.cols * 4);
    this.updateHomogeneity(slot, 4, 1);
    this.updateHomogeneity(slot, 16, 2);
    this.dirty = true;
  }
  private offset(slot: number): number { return (Math.floor(slot / this.cols) * this.cols * 2 + slot % this.cols) * 4; }
  /** Endpoint equality is insufficient when a core moves and returns within
   * a mip group. Check all source maps once on ingestion, not per pixel. */
  private updateHomogeneity(slot: number, block: number, bit: number): void {
    const start = Math.floor(slot / block) * block, origin = this.offset(start), wings = this.cols * 4;
    let same = this.mirror[origin + 2] > 0;
    for (let i = 1; i < block && same; i++) {
      const at = this.offset(start + i);
      for (let j = 0; j < 4 && same; j++) same = this.mirror[origin + j] === this.mirror[at + j];
      for (const j of [0, 1, 3]) if (this.mirror[origin + wings + j] !== this.mirror[at + wings + j]) same = false;
    }
    for (let i = 0; i < block; i++) {
      const at = this.offset(start + i) + wings + 2;
      this.mirror[at] = (this.mirror[at] & ~bit) | (same ? bit : 0);
    }
  }
  flush(): void {
    if (!this.dirty) return;
    const gl = this.gl;
    if (!this.textureN) {
      this.textureN = gl.createTexture();
      if (!this.textureN) throw new Error('flowmap: column geometry allocation failed');
      gl.bindTexture(gl.TEXTURE_2D, this.textureN);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, this.cols, this.layers * 2);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    } else gl.bindTexture(gl.TEXTURE_2D, this.textureN);
    // 192 KiB at the 6144-column budget; one upload per changed frame also
    // covers a whole history page without hundreds of GL calls.
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.cols, this.layers * 2, gl.RGBA, gl.FLOAT, this.mirror);
    this.dirty = false;
  }
  dispose(): void {
    if (this.textureN) this.gl.deleteTexture(this.textureN);
    if (this.resolutionN) this.gl.deleteTexture(this.resolutionN);
    this.textureN = null; this.resolutionN = null; this.resolutionMirror = null;
    this.resolutionRanges.clear(); this.resolutionHeight = 0;
    this.dirty = false; this.resolutionDirty = false;
  }
}

/** Equivalent resting size per fine core cell. Wide log buckets contain mass,
 * not a wall at every price inside that bucket. Exact raw arrays remain intact. */
export function densityForScale(scale: PriceScale, source: Float32Array, target: Float32Array): Float32Array {
  const reference = scale.kind === 'hybrid' ? scale.coreStep : scale.step;
  for (let r = 0; r < source.length; r++) {
    const width = rowToPrice(scale, r + 0.5) - rowToPrice(scale, r - 0.5);
    target[r] = source[r] * reference / Math.max(width, Number.MIN_VALUE);
  }
  return target;
}
