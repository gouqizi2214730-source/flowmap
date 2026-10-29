'use strict';
/* 模块的独立窗口：window.html#模块。整个窗口放一个模块（和主窗口里一样放在 iframe 里），
   外部链接交给系统浏览器，聚合成交里点的交易对通过 BroadcastChannel 报给主窗口，
   主窗口切好的币再广播回来（衍生品数据、结构分析跟着切）。 */
(() => {
  const id = location.hash.slice(1);
  const m = (window.VPFM_MODULES || []).find(x => x.id === id);
  const bc = typeof BroadcastChannel === 'function' ? new BroadcastChannel('vpfm') : null;
  const $ = s => document.querySelector(s);

  let toastTimer = 0;
  function toast(msg, bad = false, ms = 3200) {
    const t = $('#toast');
    t.textContent = msg; t.classList.toggle('bad', bad); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`); return j; });
  const openExternal = url => post('/api/wb/open', { url }).catch(e => toast('打不开链接：' + e.message, true));

  if (!m) {
    document.body.insertAdjacentHTML('beforeend', '<div class="missing">没有这个模块</div>');
    return;
  }
  document.title = `VPFM · ${m.name}`;

  /* 快捷键都交给主窗口：Ctrl+数字切主窗口的模块，Ctrl+, 打开设置 */
  function onKey(e) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    let target = null;
    if (e.key === ',') target = 'settings';
    const n = /^Digit([1-9])$/.exec(e.code);
    if (n) {
      let hidden = [];
      try { hidden = JSON.parse(localStorage.getItem('vpfm.shell.v1') || '{}').hidden || []; } catch { /* 忽略 */ }
      const vis = window.VPFM_MODULES.filter(x => !hidden.includes(x.id));
      target = vis[Number(n[1]) - 1]?.id || null;
    }
    if (!target) return;
    e.preventDefault(); e.stopPropagation();
    if (bc) bc.postMessage({ op: 'show', id: target });
    post('/api/wb/window', { op: 'main' }).catch(() => {});
  }
  window.addEventListener('keydown', onKey, true);

  const el = document.createElement('iframe');
  el.className = 'mod';
  el.title = m.name;
  el.allow = 'clipboard-read; clipboard-write; fullscreen; autoplay';
  el.src = m.src;
  el.addEventListener('load', () => {
    VPFM_wire(el, { onKey, openExternal });
    try { el.contentWindow.focus(); } catch { /* 忽略 */ }
  });
  document.body.prepend(el);

  // 聚合成交报上来的交易对：交给主窗口统一处理（它会再广播切好的币）
  window.addEventListener('message', e => {
    if (e.origin !== location.origin || typeof e.data !== 'string' || e.data[0] !== '{') return;
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg && msg.op === 'market' && bc) bc.postMessage({ op: 'market', data: msg.data });
  });
  if (bc) {
    bc.onmessage = e => {
      const msg = e.data || {};
      const w = el.contentWindow;
      if (!w) return;
      try {
        if (msg.op === 'coin' && msg.coin && VPFM_LINKED.includes(id)) w.dispatchEvent(new CustomEvent('vpfm-coin', { detail: msg.coin }));
        else if (msg.op === 'prefs') {
          const p = JSON.parse(localStorage.getItem('vpfm.prefs') || '{}');
          if (p.updown === 'red-up') document.documentElement.dataset.updown = 'red-up'; else delete document.documentElement.dataset.updown;
          w.dispatchEvent(new CustomEvent('vpfm-prefs', { detail: p }));
        }
      } catch { /* 模块还没加载完 */ }
    };
  }
  // 模块里的提示（VP.toast）显示在这个窗口里
  window.vpfm = { toast, openExternal, show: target => { if (bc) bc.postMessage({ op: 'show', id: target }); } };
})();
