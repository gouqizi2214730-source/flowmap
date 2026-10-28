'use strict';
(function () {
  const { fmt } = VP;
  const $ = s => document.querySelector(s);
  const st = VP.store('tools', {
    size: { bal: '10000', risk: '1', unit: 'pct', side: 'long', entry: '', stop: '', tp: '', fee: '0.05' },
    liq: { side: 'long', entry: '', lev: '10', mmr: '0.5' },
    fund: { notional: '10000', rate: '0.01', every: '8', hours: '24' },
  });
  const num = v => { const x = Number(String(v).replace(/,/g, '').trim()); return isFinite(x) ? x : NaN; };
  const row = (k, v, cls = '') => `<div class="r ${cls}"><span>${k}</span><b>${v}</b></div>`;

  /* ---------- 复盘本 ---------- */
  async function post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
    return j;
  }
  let fbDownload = 'https://github.com/gouqizi2214730-source/trade-journal/releases';
  async function checkFb() {
    try {
      const j = await fetch('/api/wb/apps', { cache: 'no-store' }).then(r => r.json());
      const fb = j.fupanbook || {};
      fbDownload = fb.download || fbDownload;
      $('#fbState').textContent = fb.path ? `已安装：${fb.path}` : '这台电脑上没有找到复盘本（默认安装在 %LOCALAPPDATA%\\Programs\\FupanBook）。';
      $('#fbOpen').hidden = !fb.path; $('#fbGet').hidden = !!fb.path;
    } catch (e) { $('#fbState').textContent = '查找失败：' + e.message; $('#fbGet').hidden = false; }
  }
  $('#fbOpen').onclick = async () => {
    try { const j = await post('/api/wb/launch', { app: 'fupanbook' }); VP.toast(j.ok ? '已打开复盘本' : '没有找到复盘本，请先安装'); if (!j.ok) checkFb(); }
    catch (e) { VP.toast('打开失败：' + e.message, true); }
  };
  $('#fbGet').onclick = () => post('/api/wb/open', { url: fbDownload }).then(() => VP.toast('已在浏览器打开下载页')).catch(e => VP.toast('打不开链接：' + e.message, true));
  checkFb();

  /* ---------- 表单绑定 ---------- */
  function bind(id, key, calc) {
    const root = $('#' + id);
    const data = st.get()[key];
    root.querySelectorAll('input[data-k]').forEach(inp => {
      inp.value = data[inp.dataset.k] ?? '';
      inp.addEventListener('input', () => { data[inp.dataset.k] = inp.value; st.set({ [key]: data }); calc(data); });
    });
    root.querySelectorAll('.side button').forEach(b => b.addEventListener('click', () => { data.side = b.dataset.side; st.set({ [key]: data }); mark(); calc(data); }));
    root.querySelectorAll('.unit-switch button').forEach(b => b.addEventListener('click', () => { data.unit = b.dataset.u; st.set({ [key]: data }); mark(); calc(data); }));
    function mark() {
      root.querySelectorAll('.side button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.side === data.side)));
      root.querySelectorAll('.unit-switch button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.u === data.unit)));
    }
    mark(); calc(data);
  }

  bind('sizeTool', 'size', d => {
    const bal = num(d.bal), risk = num(d.risk), entry = num(d.entry), stop = num(d.stop), tp = num(d.tp), fee = num(d.fee) / 100 || 0;
    const out = $('#sizeOut');
    if (!(entry > 0) || !(stop > 0)) { out.innerHTML = '<div class="r"><span>填好开仓价和止损价就会算出结果</span></div>'; return; }
    const long = d.side === 'long';
    if (long ? stop >= entry : stop <= entry) { out.innerHTML = `<div class="warn">${long ? '做多的止损价要低于开仓价' : '做空的止损价要高于开仓价'}</div>`; return; }
    const riskAmt = d.unit === 'usd' ? risk : bal * risk / 100;
    const dist = Math.abs(entry - stop);
    const qty = riskAmt / (dist + (entry + stop) * fee);
    const notional = qty * entry;
    const lev = bal > 0 ? notional / bal : NaN;
    let html = row('开仓数量', `${fmt.num(qty, qty >= 100 ? 2 : qty >= 1 ? 4 : 6)} 个`, 'big')
      + row('名义价值', `${fmt.num(notional, 2)} USDT`)
      + row('止损距离', `${fmt.price(dist)}（${(dist / entry * 100).toFixed(2)}%）`)
      + row('打到止损亏', `${fmt.num(riskAmt, 2)} USDT（含手续费）`)
      + row('至少需要杠杆', isFinite(lev) ? `${lev.toFixed(2)} 倍` : '—');
    if (tp > 0) {
      const good = long ? tp > entry : tp < entry;
      if (!good) html += `<div class="warn">${long ? '做多的止盈价要高于开仓价' : '做空的止盈价要低于开仓价'}</div>`;
      else {
        const gain = qty * Math.abs(tp - entry) - qty * (entry + tp) * fee;
        const rr = Math.abs(tp - entry) / dist;
        html += row('止盈赚', `${fmt.num(gain, 2)} USDT`) + row('盈亏比', `${rr.toFixed(2)} R`) + row('保本胜率', `${(100 / (1 + rr)).toFixed(1)}%`);
      }
    }
    if (lev > 20) html += '<div class="warn">需要的杠杆超过 20 倍，强平价可能离止损很近，先用下面的强平价估算核对一下。</div>';
    out.innerHTML = html;
  });

  bind('liqTool', 'liq', d => {
    const entry = num(d.entry), lev = num(d.lev), mmr = num(d.mmr) / 100;
    const out = $('#liqOut');
    if (!(entry > 0) || !(lev >= 1)) { out.innerHTML = '<div class="r"><span>填好开仓价和杠杆就会算出结果</span></div>'; return; }
    const long = d.side === 'long';
    const liq = long ? entry * (1 - 1 / lev) / (1 - mmr) : entry * (1 + 1 / lev) / (1 + mmr);
    const pct = (liq / entry - 1) * 100;
    out.innerHTML = row('约在', fmt.price(liq), 'big') + row('距开仓价', `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`)
      + row('初始保证金占比', `${(100 / lev).toFixed(2)}%`)
      + '<div class="r"><span>交易所按分档维持保证金率和标记价格计算，实际强平价以交易所显示为准。</span></div>';
  });

  bind('fundTool', 'fund', d => {
    const notional = num(d.notional), rate = num(d.rate) / 100, every = num(d.every), hours = num(d.hours);
    const out = $('#fundOut');
    if (!(notional > 0) || !isFinite(rate) || !(every > 0) || !(hours >= 0)) { out.innerHTML = '<div class="r"><span>填好四项就会算出结果</span></div>'; return; }
    const times = Math.floor(hours / every);
    const cost = notional * rate * times;
    out.innerHTML = row('结算次数', `${times} 次`) + row(cost >= 0 ? '多单付出 / 空单收到' : '多单收到 / 空单付出', `${fmt.num(Math.abs(cost), 2)} USDT`, 'big')
      + row('折合年化', `${(rate * (24 / every) * 365 * 100).toFixed(2)}%`)
      + row('每天', `${fmt.num(Math.abs(notional * rate * 24 / every), 2)} USDT`);
  });

  /* ---------- 时段时钟 ---------- */
  function clock() {
    const now = Date.now() / 1000;
    const { hour } = SMC.nyParts(now);
    const pad = x => String(x).padStart(2, '0');
    // 纽约某个整点对应的本地时间：从当前时刻按时差推算
    const localAtNy = h => { const diff = ((h - hour) % 24 + 24) % 24; const d = new Date((now + diff * 3600) * 1000); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
    const nyNow = (() => { const hh = Math.floor(hour), mm = Math.round((hour - hh) * 60); return `${pad(hh)}:${pad(mm % 60)}`; })();
    const rows = SMC.SESSIONS.map(s => {
      const live = s.from < s.to ? hour >= s.from && hour < s.to : hour >= s.from || hour < s.to;
      const until = ((s.from - hour) % 24 + 24) % 24;
      const left = ((s.to - hour) % 24 + 24) % 24;
      const seg = (a, b) => `<i style="left:${a / 24 * 100}%;width:${(b - a) / 24 * 100}%;background:${live ? 'var(--amber)' : 'var(--line-strong)'}"></i>`;
      const bar = s.from < s.to ? seg(s.from, s.to) : seg(s.from, 24) + seg(0, s.to);
      return `<div class="sess ${live ? 'live' : ''}"><span class="name">${s.name}</span><span class="bar">${bar}<i class="now" style="left:${hour / 24 * 100}%"></i></span>`
        + `<span class="when">${localAtNy(s.from)}–${localAtNy(s.to)}　${live ? '还剩 ' + fmt.countdown(left * 3600e3) : fmt.countdown(until * 3600e3) + ' 后开始'}</span></div>`;
    }).join('');
    const nextFund = (Math.floor(now / 28800) + 1) * 28800;
    $('#clock').innerHTML = `<div><span class="dim">纽约时间</span> <span class="big">${nyNow}</span>　<span class="dim">本地</span> <span class="big">${fmt.time(Date.now(), false)}</span></div>`
      + rows + `<p class="note">主流交易所 8 小时结算的资金费下次结算在 ${fmt.time(nextFund * 1000, false)}（还有 ${fmt.countdown((nextFund - now) * 1000)}）。</p>`;
  }
  clock(); setInterval(clock, 1000);
})();
