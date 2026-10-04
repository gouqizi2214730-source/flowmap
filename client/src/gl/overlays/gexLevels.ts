/**
 * Gamma Exposure (GEX) levels overlay (FLOW <GO>).
 *
 * Visualizes key option-implied market microstructure boundaries on the price grid:
 * - Call Wall (Green): Highest call gamma strike (volatility dampener / ceiling).
 * - Put Wall (Red): Highest put gamma strike (volatility floor / crash trigger).
 * - Gamma Flip (Cyan): Inflection level where dealer gamma flips from stabilizing to accelerating.
 */

import type { OverlayFrame } from './frame';
import type { GexLevelUpdate } from '../../proto/types';

export class GexOverlay {
  private current: GexLevelUpdate | null = null;
  private enabled: boolean = true;

  set(state: GexLevelUpdate | null): void {
    this.current = state;
  }

  get(): GexLevelUpdate | null {
    return this.current;
  }

  setEnabled(val: boolean): void {
    this.enabled = val;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  reset(): void {
    this.current = null;
  }

  draw(frame: OverlayFrame): void {
    if (!this.enabled || this.current === null) return;
    const { gm, solid, text } = frame;
    if (gm.price === null) return;

    const gex = this.current;
    const cssW = gm.dims.cssW;
    const cssH = gm.dims.cssH;
    const decimals = gm.price.step > 0 ? Math.min(8, Math.max(0, Math.ceil(-Math.log10(gm.price.step)))) : 2;

    const drawLevel = (
      price: number,
      colorGl: readonly [number, number, number, number],
      colorCss: string,
      label: string,
    ): void => {
      if (!Number.isFinite(price) || price <= 0) return;
      const rowf = gm.priceToRow(price) + 0.5;
      const y = gm.clipY(rowf);
      if (y < -1.02 || y > 1.02) return;

      solid.begin();
      solid.addThickLine(-1, y, 1, y, 1.8, colorGl, cssW, cssH);
      solid.flush();

      // Right-edge badge on text layer
      const cy = gm.cssY(rowf);
      text.badge(cssW - 4, cy, `${label} ${price.toFixed(decimals)}`, {
        align: 'right',
        color: colorCss,
        size: 10,
      });
    };

    // 1. Call Wall (Volatility Dampening Ceiling -> Fluorescent Green)
    if (gex.call_wall > 0) {
      drawLevel(gex.call_wall, [0.0, 1.0, 0.45, 0.85] as const, '#00ff73', 'CALL WALL');
    }

    // 2. Put Wall (Volatility Crash Floor -> Fluorescent Red)
    if (gex.put_wall > 0) {
      drawLevel(gex.put_wall, [1.0, 0.25, 0.25, 0.85] as const, '#ff4040', 'PUT WALL');
    }

    // 3. Gamma Flip (Volatility Trigger -> Cyan)
    if (gex.gamma_flip > 0) {
      drawLevel(gex.gamma_flip, [0.2, 0.85, 1.0, 0.75] as const, '#33d6ff', 'GAMMA FLIP');
    }
  }
}
