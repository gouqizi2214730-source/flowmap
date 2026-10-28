'use strict';
/* 轻量画布绘图：按价格/行权价这类数值横轴画柱状图和曲线（lightweight-charts 只支持时间轴）。
   VP.plot(容器, 绘制函数) 负责高分屏缩放、尺寸变化重绘、鼠标悬停提示。 */
(function () {
  const VP = window.VP;

  VP.niceTicks = function (min, max, count = 5) {
    if (!isFinite(min) || !isFinite(max)) return [];
    if (min === max) { min -= 1; max += 1; }
    const span = max - min;
    const step0 = span / Math.max(1, count);
    const mag = 10 ** Math.floor(Math.log10(step0));
    const err = step0 / mag;
    const step = (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1) * mag;
    const out = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    return out;
  };

  VP.scale = function (d0, d1, r0, r1) {
    const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
    const f = v => r0 + (v - d0) * k;
    f.invert = p => (k === 0 ? d0 : d0 + (p - r0) / k);
    f.domain = [d0, d1];
    return f;
  };

  /** 在容器里放一块画布；draw(g, w, h, state) 每次尺寸变化或 redraw() 时调用 */
  VP.plot = function (container, draw, { onHover } = {}) {
    container.style.position = container.style.position || 'relative';
    const cv = document.createElement('canvas');
    cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
    container.append(cv);
    const tip = document.createElement('div');
    tip.className = 'plot-tip'; tip.hidden = true;
    container.append(tip);
    const state = { mouse: null };
    let w = 0, h = 0, raf = 0;
    function redraw() {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const dpr = window.devicePixelRatio || 1;
        w = container.clientWidth; h = container.clientHeight;
        if (!w || !h) return;
        if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
        const g = cv.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, w, h);
        g.font = '11px ' + getComputedStyle(document.body).fontFamily;
        g.textBaseline = 'middle';
        try { draw(g, w, h, state); } catch (e) { console.error(e); }
      });
    }
    new ResizeObserver(redraw).observe(container);
    if (onHover) {
      cv.addEventListener('mousemove', e => {
        const r = cv.getBoundingClientRect();
        state.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
        const html = onHover(state.mouse.x, state.mouse.y, w, h);
        if (html) {
          tip.innerHTML = html; tip.hidden = false;
          const tw = tip.offsetWidth, th = tip.offsetHeight;
          let x = state.mouse.x + 14, y = state.mouse.y + 12;
          if (x + tw > w - 4) x = state.mouse.x - tw - 14;
          if (y + th > h - 4) y = Math.max(4, h - th - 4);
          tip.style.transform = `translate(${x}px,${y}px)`;
        } else tip.hidden = true;
        redraw();
      });
      cv.addEventListener('mouseleave', () => { state.mouse = null; tip.hidden = true; redraw(); });
    }
    return { redraw, canvas: cv, state };
  };

  /** 常用绘制小工具 */
  VP.draw = {
    hline(g, x0, x1, y, color, dash) { g.save(); g.strokeStyle = color; g.lineWidth = 1; if (dash) g.setLineDash(dash); g.beginPath(); g.moveTo(x0, Math.round(y) + 0.5); g.lineTo(x1, Math.round(y) + 0.5); g.stroke(); g.restore(); },
    vline(g, x, y0, y1, color, dash, width = 1) { g.save(); g.strokeStyle = color; g.lineWidth = width; if (dash) g.setLineDash(dash); g.beginPath(); g.moveTo(Math.round(x) + 0.5, y0); g.lineTo(Math.round(x) + 0.5, y1); g.stroke(); g.restore(); },
    label(g, text, x, y, { color = '#d6deea', bg = null, align = 'left', pad = 4 } = {}) {
      g.save();
      const tw = g.measureText(text).width;
      let x0 = align === 'center' ? x - tw / 2 : align === 'right' ? x - tw : x;
      if (bg) { g.fillStyle = bg; g.fillRect(x0 - pad, y - 8, tw + pad * 2, 16); }
      g.fillStyle = color; g.textAlign = 'left'; g.fillText(text, x0, y);
      g.restore();
    },
    yAxis(g, ticks, y, x, w, fmt, color, grid) {
      g.save(); g.fillStyle = color; g.textAlign = 'left';
      for (const t of ticks) {
        const yy = y(t);
        if (grid) VP.draw.hline(g, 0, x, yy, grid);
        g.fillText(fmt(t), x + 6, yy);
      }
      g.restore();
    },
    xAxis(g, ticks, x, y, fmt, color, grid, top = 0) {
      g.save(); g.fillStyle = color; g.textAlign = 'center';
      for (const t of ticks) {
        const xx = x(t);
        if (grid) VP.draw.vline(g, xx, top, y, grid);
        g.fillText(fmt(t), xx, y + 11);
      }
      g.restore();
    },
  };
})();
