export const DOWNSAMPLE_VERT = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

// 4×4 SUM downsample. Output coords come from gl_FragCoord (the viewport is
// offset to the destination column(s), so int(gl_FragCoord.x) IS the first
// destination column of the pass). Each output texel sums the 4×4 block of the
// finer level rooted at (4·ox, 4·oy).
//
// validFrom gating: after any col_seq gap (reconnect resume, go-live after deep
// scroll-back) the ring slots between the old resident window and the new first
// column still hold PREVIOUS columns. Level 0 masks those stale texels with
// u_validFrom (see shaders/heatmap.ts); the mips must apply the SAME gate while
// summing, or a pre-gap column bakes into the mip forever and a zoomed-out view
// shows a permanently over-bright block. The group a destination column ox
// covers ends at ABSOLUTE `u_groupNewest - (u_xEnd - ox)·4`: a single-group pass
// sets u_xEnd to its own destination column so this reduces to u_groupNewest
// exactly (the historical behavior), while a batched RANGE pass covers many
// groups in one draw with u_xEnd at the range's last destination column.
export const DOWNSAMPLE_FRAG = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;

uniform highp sampler2DArray u_src;
uniform int u_srcLayer;
// First VALID absolute col_seq (TileRing.validFromSeq) and the newest absolute
// col_seq of the last 4-column group this pass sums (see u_xEnd).
uniform int u_validFrom;
uniform int u_groupNewest;
// Tile-local destination column of the pass's LAST group (itself for a 1-wide
// pass) — reconstructs each fragment's group end from u_groupNewest.
uniform int u_xEnd;
// Row-only mode (campaign visual 2026-09-11, R2-M1): each destination texel
// sums the 4 ROWS of the SINGLE source column at the same x — no column summing,
// so a collapsing price axis no longer drags the 4-column block average into a
// deeply time-zoomed view. Groups are one column wide here.
uniform int u_rowOnly;

out vec4 outColor;

void main() {
  int ox = int(gl_FragCoord.x);
  int oy = int(gl_FragCoord.y);
  int by = oy * 4;
  vec2 s = vec2(0.0);
  if (u_rowOnly == 1) {
    // The single source column's absolute col_seq (groups are 1 wide).
    int col = u_groupNewest - (u_xEnd - ox);
    if (col >= u_validFrom) {
      for (int j = 0; j < 4; j++) {
        s += texelFetch(u_src, ivec3(ox, by + j, u_srcLayer), 0).rg;
      }
    }
  } else {
    int bx = ox * 4;
    int gn = u_groupNewest - (u_xEnd - ox) * 4;
    for (int j = 0; j < 4; j++) {
      for (int i = 0; i < 4; i++) {
        // Mask the source column against the valid window BEFORE summing (the
        // level-0 rule, applied at the source): stale pre-gap texels contribute 0.
        if (gn - 3 + i >= u_validFrom) {
          s += texelFetch(u_src, ivec3(bx + i, by + j, u_srcLayer), 0).rg;
        }
      }
    }
  }
  // RG32F preserves base-unit quantities and their sums for cheap symbols.
  outColor = vec4(s, 0.0, 0.0);
}
`;
