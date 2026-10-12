/**
 * SUM-mips for correct zoom-out (§8.3, M2 T7).
 *
 * When the price axis is zoomed OUT, many rows collapse into one screen pixel.
 * A plain average-downsampled mip (what `generateMipmap` produces) would render
 * a 500-lot liquidity wall surrounded by empty ticks as ~500/16 — walls DILUTE
 * exactly when you zoom out, the opposite of what an order-flow heatmap must
 * show. Tick-grouping requires the SUMMED resting size, so mips are SUMS, not
 * averages, and `generateMipmap` is NEVER used.
 *
 * This module builds three extra array textures alongside the {@link TileRing}:
 *
 *   - level-1: `colsPerTile/4 × rows/4 × layers`  (each texel = SUM of a 4×4 block of level 0)
 *   - level-2: `colsPerTile/16 × rows/16 × layers`(each texel = SUM of a 4×4 block of level 1)
 *   - row-only: `colsPerTile × rows/4 × layers`   (each texel = SUM of 4 ROWS of ONE
 *     column — no column summing). The R2-M1 decoupling: when the price axis
 *     collapses rows per pixel (rpp ≥ 2.5) but time is deep-zoomed (cpp < 1.5),
 *     the 4×4 SUM mip would paint 4-column blocks; the row-only chain groups
 *     price alone and keeps the time axis crisp.
 *
 * All are `RG32F` and color-renderable (needs `EXT_color_buffer_float`, a hard
 * §8.3 requirement) so the downsample runs on the GPU: an FBO ping-pong where a
 * fragment shader reads the finer level via `texelFetch` and writes the 4×4 sum
 * into the coarser level's FBO-attached layer. The per-texel coordinate mapping
 * matches the ring exactly (same layer, x/4^L within the tile), so the heatmap
 * shader's slot→(layer,x) addressing and residency/wrap logic are unchanged — it
 * just fetches from a coarser texture and folds the block rescale into the
 * normalization divisor.
 *
 * Incremental generation (NOT per frame — that is the whole point of the O(1)
 * draw): `updateFrom(ring, appendedColSeq)` runs the row-only pass for the just-
 * appended column on EVERY append (1×rows/4 viewport), the level-1 pass for the
 * just-completed group of 4 columns on every 4th append (when `x % 4 === 3`) and
 * the level-2 pass on every 16th (when `x % 16 === 15`). Each pass renders one or
 * a few coarser columns, so the amortized cost stays well under two passes per
 * append and is independent of history depth. Because the ring capacity
 * (`256 × layers`) is a multiple of 16, a group of 4/16 consecutive ring slots
 * always holds 4/16 consecutive column sequences even across a ring wrap, so the
 * group alignment stays valid; the row-only grouping is per-column and thus has
 * no alignment constraint at all.
 *
 * Saturation: sums are clamped at 60 000 (f16 max is 65 504; a fully-dense 4×4
 * block of near-max values, compounded across levels, would otherwise overflow).
 * Saturation is visually inert because the normalization percentile sits far
 * below it, and the crosshair readout comes from the CPU cache, not these texels.
 */

import { checkGLError, checkGLHotPath, type GLContext } from './context';
import type { TileRing } from './tileRing';

import { downsampleProgram } from './heatmapProgram';
export { DOWNSAMPLE_FRAG } from './shaders/downsample';

function allocLevel(
  gl: WebGL2RenderingContext,
  cols: number,
  rows: number,
  layers: number,
): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error('flowmap/mips: createTexture returned null');
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RG32F, cols, rows, layers);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  return tex;
}

/**
 * The ABSOLUTE col_seqs a level-1 group's SUM covers (the group ENDS at
 * `groupNewest` — appends are group-aligned, so the four ring slots hold these
 * columns). The validFrom mask in {@link DOWNSAMPLE_FRAG} is applied per member.
 * Exposed so the group arithmetic stays unit-checkable next to the shader.
 */
export function mipGroupCols(groupNewest: number): [number, number, number, number] {
  return [groupNewest - 3, groupNewest - 2, groupNewest - 1, groupNewest];
}

export class MipChain {
  readonly gl: WebGL2RenderingContext;
  readonly colsPerTile: number;
  readonly rows: number;
  readonly layers: number;
  /** Highest level present (1 = only level-1, 2 = level-1 + level-2). */
  readonly maxLevel: number;

  /** level-1 texture (colsPerTile/4 × rows/4 × layers). */
  readonly tex1: WebGLTexture;
  /** level-2 texture (colsPerTile/16 × rows/16 × layers), or null when maxLevel<2. */
  readonly tex2: WebGLTexture | null;
  /** Row-only texture (colsPerTile × rows/4 × layers): 4-row sums of ONE column. */
  readonly texRow1: WebGLTexture;

  private readonly prog: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly quad: WebGLBuffer;
  private readonly fbo: WebGLFramebuffer;
  private readonly uSrc: WebGLUniformLocation | null;
  private readonly uSrcLayer: WebGLUniformLocation | null;
  private readonly uValidFrom: WebGLUniformLocation | null;
  private readonly uGroupNewest: WebGLUniformLocation | null;
  private readonly uXEnd: WebGLUniformLocation | null;
  private readonly uRowOnly: WebGLUniformLocation | null;
  /**
   * False once a downsample pass finds its FBO incomplete (a driver/alloc
   * failure must not silently paint garbage). The chain then renders nothing
   * further and the heatmap falls back to the level-0 path (`Heatmap.draw` and
   * the renderer's level selection both consult this).
   */
  private usableFlag = true;
  // Immutable texture storage: completeness is stable for each texture/layer.
  // Rechecking every partial column serializes the GPU and UI threads.
  private readonly checkedTargets = new Map<WebGLTexture, Set<number>>();

  /** Whether the FBO passes are (still) known-complete — see {@link usableFlag}. */
  get usable(): boolean {
    return this.usableFlag;
  }

  /**
   * Whether the row-only chain is safe to sample — same shared FBO verdict as
   * {@link usable} (the row pass shares the framebuffer and target format).
   */
  get rowUsable(): boolean {
    return this.usableFlag;
  }

  constructor(ctx: GLContext, colsPerTile: number, rows: number, layers: number) {
    const gl = ctx.gl;
    if (!ctx.caps.colorBufferFloat) {
      throw new Error(
        'flowmap/mips: EXT_color_buffer_float required (§8.3: RG16F must be color-renderable for SUM mip FBO passes)',
      );
    }
    if (colsPerTile % 16 !== 0) {
      throw new Error(`flowmap/mips: colsPerTile ${colsPerTile} must be a multiple of 16`);
    }
    if (rows % 4 !== 0) {
      throw new Error(`flowmap/mips: rows ${rows} must be a multiple of 4 for level-1 mips`);
    }
    this.gl = gl;
    this.colsPerTile = colsPerTile;
    this.rows = rows;
    this.layers = layers;
    this.maxLevel = rows % 16 === 0 ? 2 : 1;

    this.tex1 = allocLevel(gl, colsPerTile / 4, rows / 4, layers);
    this.tex2 = this.maxLevel >= 2 ? allocLevel(gl, colsPerTile / 16, rows / 16, layers) : null;
    this.texRow1 = allocLevel(gl, colsPerTile, rows / 4, layers);

    // Downsample program + a clip-space quad (viewport clips to one column).
    const prog = downsampleProgram(gl);
    this.prog = prog;
    this.uSrc = gl.getUniformLocation(prog, 'u_src');
    this.uSrcLayer = gl.getUniformLocation(prog, 'u_srcLayer');
    this.uValidFrom = gl.getUniformLocation(prog, 'u_validFrom');
    this.uGroupNewest = gl.getUniformLocation(prog, 'u_groupNewest');
    this.uXEnd = gl.getUniformLocation(prog, 'u_xEnd');
    this.uRowOnly = gl.getUniformLocation(prog, 'u_rowOnly');

    const quad = gl.createBuffer();
    const vao = gl.createVertexArray();
    const fbo = gl.createFramebuffer();
    if (!quad || !vao || !fbo) throw new Error('flowmap/mips: buffer/VAO/FBO alloc failed');
    this.quad = quad;
    this.vao = vao;
    this.fbo = fbo;

    // prettier-ignore
    const verts = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    checkGLError(gl, 'MipChain.ctor');
  }

  /**
   * Regenerate the mip columns affected by appending `appendedColSeq`: the
   * row-only pass for the new column on EVERY append, the level-1 pass when the
   * 4-column group is complete (`x % 4 === 3`) and the level-2 pass when the
   * 16-column group is complete (`x % 16 === 15`). No-op on other appends for
   * the SUM levels — that is what keeps generation incremental and O(1).
   */
  updateFrom(ring: TileRing, appendedColSeq: number): void {
    // A chain whose FBO went incomplete renders nothing further; the heatmap has
    // already been told (via `usable`) to stay on the level-0 path.
    if (!this.usableFlag) return;

    const cap = ring.capacityCols;
    const slot = ((appendedColSeq % cap) + cap) % cap;
    const x0 = slot % this.colsPerTile;
    const layer = (slot / this.colsPerTile) | 0;

    // Row-only mip: EVERY append writes its own destination column (groups are
    // one column wide — no group-alignment wait). Source and destination share
    // the tile-local x; the single source column is masked against the ring's
    // validFrom gate...
    this.pass(
      ring.texture,
      this.texRow1,
      x0,
      1,
      this.rows / 4,
      layer,
      ring.validFromSeq(),
      appendedColSeq,
      x0,
      true,
    );

    if (this.usableFlag && x0 % 4 === 3) {
      // level-0 → level-1: write coarser column x0/4 from level-0 columns [x0-3 .. x0].
      // Mask each source column against the ring's validFrom gate so a pre-gap
      // column never bakes into the SUM (see DOWNSAMPLE_FRAG).
      this.pass(
        ring.texture,
        this.tex1,
        (x0 / 4) | 0,
        1,
        this.rows / 4,
        layer,
        ring.validFromSeq(),
        appendedColSeq,
        (x0 / 4) | 0,
      );
    }
    if (this.usableFlag && this.tex2 !== null && x0 % 16 === 15) {
      // level-1 → level-2: write coarser column x0/16 from the 4 level-1
      // columns just built. Those sources were each validFrom-masked at their
      // OWN build time — after a gap growth, the three columns completed
      // BEFORE the growth carry pre-gap data, so baking them here would smear
      // the gap into a level-2 texel (the exact bug the level-1 mask fixed,
      // one level up). Skip until the whole 16-column group is unambiguously
      // post-gap; the stale texel self-heals when the ring wraps this group.
      if (appendedColSeq - 15 >= ring.validFromSeq()) {
        this.pass(this.tex1, this.tex2, (x0 / 16) | 0, 1, this.rows / 16, layer, null, appendedColSeq, (x0 / 16) | 0);
      }
    }

    // Restore the default framebuffer so the display draw targets the screen.
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    checkGLError(this.gl, 'MipChain.updateFrom', true);
  }

  /**
   * Regenerate the mip columns for a whole RANGE of appended columns in ONE FBO
   * pass per level per tile-layer segment — the history-page splice path. The
   * per-append {@link updateFrom} fires 64 level-1 + 16 level-2 tiny 1-px
   * viewports for a 256-column page; this collapses them to ~1 pass per level
   * per layer (the downsample shader already derives each destination texel
   * from `gl_FragCoord`, so a wider viewport IS the batch).
   *
   * Range handling:
   *  - The covered groups are group-aligned inward: `[a0 = from − from%4]` and
   *    `[b0 = hi − hi%4 + 3]` where `hi = min(toSeq, residentNewest)` — a pass
   *    never reads slots past the resident newest (unwritten garbage is not
   *    masked; below-validFrom slots are). Over-baking a group whose members are
   *    contiguous resident columns re-sums identical texels (harmless).
   *  - One level-1 pass per tile-layer segment of the range, validFrom-masked.
   *  - The row-only chain has no group alignment: one batched pass per tile-layer
   *    segment of the WHOLE spliced range [fromSeq..hi], validFrom-masked.
   *  - Level-2 bakes only the FULLY rebuilt, fully post-gap 16-groups (the same
   *    R2 H-1 rule updateFrom applies, lifted to range granularity): starts at
   *    the first 16-aligned start ≥ max(a0, validFrom-aligned-up), so no level-2
   *    texel mixes pre-gap level-1 columns with post-gap rebuilds.
   *  - Ragged edges that fall outside the aligned range keep today's behavior:
   *    they were baked when their group last completed, and they self-heal on
   *    wrap (same contract as the level-2 skip).
   */
  updateRange(ring: TileRing, fromSeq: number, toSeq: number): void {
    if (!this.usableFlag || toSeq < fromSeq) return;

    const range = ring.residentRange();
    const hi = Math.min(toSeq, range !== null ? range.newest : toSeq);
    if (hi < fromSeq) return;

    const cap = ring.capacityCols;
    const a0 = fromSeq - (fromSeq % 4);
    // Largest 4-group end ≤ hi — a pass never reads slots past the resident
    // newest (below-validFrom slots are masked; above-newest slots are unwritten
    // garbage and NOT masked).
    const b0 = hi - ((hi + 1) % 4);
    const validFrom = ring.validFromSeq();

    // Row-only mip: per-column groups, so the WHOLE resident part of the splice
    // [fromSeq..hi] is rebuilt in one pass per tile-layer segment. Runs even
    // when the 4-group range [a0..b0] is empty (ragged page edges).
    if (range !== null) {
      let r = fromSeq;
      while (r <= hi) {
        const segEnd = Math.min(
          hi,
          r - (r % this.colsPerTile) + this.colsPerTile - 1,
        );
        const layer = ((((r % cap) + cap) % cap) / this.colsPerTile) | 0;
        const x0 = (r % this.colsPerTile) | 0;
        const x1 = (segEnd % this.colsPerTile) | 0;
        this.pass(
          ring.texture,
          this.texRow1,
          x0,
          x1 - x0 + 1,
          this.rows / 4,
          layer,
          validFrom,
          segEnd,
          x1,
          true,
        );
        r = segEnd + 1;
      }
    }

    if (b0 < a0) {
      // No complete 4-group in range: the SUM levels keep their previous bakes,
      // but the row-only chain above still ran (and the FBO is restored).
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
      checkGLError(this.gl, 'MipChain.updateRange', true);
      return;
    }

    // level-0 → level-1: one batched pass per tile-layer segment of [a0..b0].
    // Absolute seq mod colsPerTile IS the tile-local x (capacity is a multiple
    // of colsPerTile), so segments cut at multiples of colsPerTile never mix
    // layers — including across a ring wrap.
    let s = a0;
    while (s <= b0) {
      const segEnd = Math.min(
        b0,
        s - (s % this.colsPerTile) + this.colsPerTile - 1,
      );
      const layer = (((s % cap) + cap) % cap) / this.colsPerTile | 0;
      const dstX0 = ((s % this.colsPerTile) / 4) | 0;
      const dstX1 = ((segEnd % this.colsPerTile) / 4) | 0;
      this.pass(
        ring.texture,
        this.tex1,
        dstX0,
        dstX1 - dstX0 + 1,
        this.rows / 4,
        layer,
        validFrom,
        segEnd,
        dstX1,
      );
      s = segEnd + 1;
    }

    // level-1 → level-2: only 16-groups FULLY inside [a0..b0] (all four of their
    // level-1 columns were rebuilt by the passes above) and fully post-gap. A
    // 16-group never straddles a tile layer (256 % 16 == 0), so this is again
    // one pass per tile-layer segment.
    if (this.tex2 !== null && this.maxLevel >= 2 && b0 >= 15) {
      const align16Up = (v: number): number => v + ((16 - (v % 16)) % 16);
      const c0 = Math.max(align16Up(a0), align16Up(validFrom));
      const c1 = b0 - 15 - ((b0 - 15) % 16); // last 16-aligned group start ≤ b0−15
      let g = c0;
      while (g <= c1) {
        const segEnd = Math.min(
          c1 + 15,
          g - (g % this.colsPerTile) + this.colsPerTile - 1,
        ); // ≡ 15 (mod 16): whole groups only
        const layer = (((g % cap) + cap) % cap) / this.colsPerTile | 0;
        const dstX0 = ((g % this.colsPerTile) / 16) | 0;
        const dstX1 = ((segEnd % this.colsPerTile) / 16) | 0;
        this.pass(
          this.tex1,
          this.tex2,
          dstX0,
          dstX1 - dstX0 + 1,
          this.rows / 16,
          layer,
          null,
          segEnd,
          dstX1,
        );
        g = segEnd + 1;
      }
    }

    // Restore the default framebuffer so the display draw targets the screen.
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    checkGLError(this.gl, 'MipChain.updateRange', true);
  }

  private pass(
    srcTex: WebGLTexture,
    dstTex: WebGLTexture,
    dstCol: number,
    /** Destination columns this pass covers (1 for the per-append path). */
    dstCols: number,
    dstRows: number,
    layer: number,
    /** validFrom gate for the level-0 source (absolute col_seqs), or null to disable. */
    maskFrom: number | null,
    groupNewest: number,
    /** Tile-local destination column of the pass's LAST group (see DOWNSAMPLE_FRAG). */
    xEnd: number,
    /** Row-only pass: 4-row sums of ONE column per destination texel. */
    rowOnly = false,
  ): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, dstTex, 0, layer);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);

    // Honest fallback: an incomplete FBO (allocation failure, driver limits)
    // would leave the pass drawing into nothing / garbage. Disable the chain —
    // the heatmap falls back to the exact level-0 path — instead of baking
    // broken mips that a zoomed-out view would sample forever.
    // Storage allocation/errors and EXT_color_buffer_float are checked at
    // creation. These immutable, in-range RG16F attachments are complete by
    // construction. Only diagnostics query the driver after uploads/draws:
    // even the FIRST query can block on lazy texture clearing/shader work.
    let checked = this.checkedTargets.get(dstTex);
    if (checkGLHotPath && !checked?.has(layer)) {
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        this.usableFlag = false;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return;
      }
      if (!checked) this.checkedTargets.set(dstTex, checked = new Set());
      checked.add(layer);
    }

    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    // Rasterize exactly the destination columns; gl_FragCoord.x -> dstCol...
    gl.viewport(dstCol, 0, dstCols, dstRows);

    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, srcTex);
    gl.uniform1i(this.uSrc, 0);
    gl.uniform1i(this.uSrcLayer, layer);
    gl.uniform1i(this.uValidFrom, maskFrom !== null ? maskFrom : -0x7fffffff);
    gl.uniform1i(this.uGroupNewest, groupNewest);
    gl.uniform1i(this.uXEnd, xEnd);
    gl.uniform1i(this.uRowOnly, rowOnly ? 1 : 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteFramebuffer(this.fbo);
    gl.deleteBuffer(this.quad);
    gl.deleteVertexArray(this.vao);
    gl.deleteTexture(this.tex1);
    gl.deleteTexture(this.texRow1);
    if (this.tex2 !== null) gl.deleteTexture(this.tex2);
  }
}
