/* Drives the real native page. Never enables perf/heatmap test mode. */
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { SAMPLE_RETRY_MS, HEALTH_CONTRACT, HEALTH_TIMEOUT_MS, ownedHealthUrl, healthCollector, drainIndependentSamplers, serializeBenchmarkJson, benchmarkPageSnapshot, historyCovered, finish, singleFlightSampler, enableProductionOverlays, productionGoLive, subscriptionAttached } = require('./driver-contract.cjs');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { chromium } = require(config.playwright || path.resolve(__dirname, '../../client/node_modules/playwright'));
const write = (name, value) => fs.writeFileSync(path.join(config.output, name), serializeBenchmarkJson(value, 2));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const unixMs = () => performance.timeOrigin + performance.now();
const lines = fs.createWriteStream(path.join(config.output, 'client.ndjson'));
const healthLines = fs.createWriteStream(path.join(config.output, 'health.ndjson'));
let browser, page, health, measuring = false, mouseDown = false;
const result = { errors: [], complete: false, provenance: config.manifest.provenance, workload: config.manifest };
for(const stream of [lines,healthLines])stream.on('error',error=>result.errors.push('Telemetry stream: '+(error.stack||String(error))));

async function snapshot() {
  const collectorStartMs=performance.now(),collectorOriginMs=performance.timeOrigin;
  const data=await page.evaluate(benchmarkPageSnapshot);
  data.sourceObservation={collectorTimeOriginMs:collectorOriginMs,collectorStartMs,collectorEndMs:performance.now()};
  return data;
}

async function sample(baseline=null, captureForMeasurement=measuring) {
  const data=baseline || await snapshot();
  data.sampling={snapshotUnixMs:data.timeOriginMs+data.nowMs,contract:HEALTH_CONTRACT};
  if (captureForMeasurement) lines.write(serializeBenchmarkJson(data) + '\n');
  return data;
}
const sampler=singleFlightSampler(sample,error=>result.errors.push('Client sampler: '+(error.stack||String(error))));

(async () => {
  try {
    const connectDeadline = performance.now() + 45_000;
    while (!browser && performance.now() < connectDeadline) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${config.cdpPort}`); }
      catch { await sleep(200); }
    }
    if (!browser) throw new Error('Owned WebView2 CDP endpoint did not become available');
    page = browser.contexts()[0].pages().find(p => /tauri\.localhost|tauri:\/\//.test(p.url()));
    if (!page) throw new Error('Owned native page unavailable');
    page.on('pageerror', error => result.errors.push(error.message));
    await page.waitForFunction(() => window.__FLOWMAP_BENCHMARK__ === true && !!window.__flowmapLive, null, { timeout: 45_000 });
    const healthUrl=ownedHealthUrl(await page.evaluate(()=>window.__FLOWMAP_SERVER__),config.serverPort);
    health=healthCollector({url:healthUrl,onObservation:row=>healthLines.write(serializeBenchmarkJson(row)+'\n'),
      onError:error=>result.errors.push('Health collector: '+(error.stack||String(error)))});
    result.healthCollection={schema:1,contract:HEALTH_CONTRACT,collectionId:health.collectionId,url:healthUrl,
      collectionStartMonoMs:health.collectionStartMonoMs,
      collectorTimeOriginMs:performance.timeOrigin,timeoutMs:HEALTH_TIMEOUT_MS,coverageLimitMs:5000,drained:false};
    const onboarding = page.getByTestId('onboarding-skip');
    if (await onboarding.isVisible()) await onboarding.click();
    const m = config.manifest, coldStart = unixMs();
    const previousSession=await page.evaluate(m=>{
      const s=window.__flowmapLive.store.getState(),sub=s.subscription;
      // An identical startup subscription is already fresh in this newly
      // owned profile/job; an actual replacement must have a different Hello.
      const same=sub && sub.market===m.market && sub.symbol===m.symbol && sub.mode===m.mode && sub.band===m.band &&
        String(sub.startNs??'')===String(m.window?.startNs??'') && String(sub.endNs??'')===String(m.window?.endNs??'');
      return same?null:s.sessionId;
    },m);
    await page.evaluate(m => {
      window.__flowmapLive.store.getState().connectAndSubscribe(m.market, m.symbol, m.mode, m.band,
        m.window ? { startNs: BigInt(m.window.startNs), endNs: BigInt(m.window.endNs) } : undefined);
    }, m);
    // Controls sent before the replacement socket opens are intentionally rejected.
    // Connection.status='live' means attached transport in either stream mode.
    await page.waitForFunction(subscriptionAttached,{manifest:m,previousSession},{timeout:120_000});
    if (config.scope === 'normalized-history-replay') {
      if (!config.historyEvidence) throw new Error('Verified history fixture evidence required');
      await page.evaluate(() => { const s=window.__flowmapLive.store.getState(); s.setSpeed(100); s.resume(); });
      await page.waitForFunction(e => window.__flowmapLive.renderer.newestColSeq >= e.columns-1,
        config.historyEvidence, {timeout:config.historyTimeoutMs || 180_000});
      await page.evaluate(m => {
        const l=window.__flowmapLive; l.store.getState().pause();
        l.renderer.goLive(); l.renderer.setTimeWindowMs(m.timeWindowMs || 3_600_000);
        l.renderer.prefetchHistory(l.renderer.residentBudgetCols);
      }, m);
      const deadline=performance.now()+(config.historyTimeoutMs || 180_000);
      let snapshot;
      do { snapshot=await sample(); if (historyCovered(snapshot,config.historyEvidence)) break; await sleep(250); } while(performance.now()<deadline);
      if (!historyCovered(snapshot,config.historyEvidence)) throw new Error('One-hour renderer overview/history coverage did not complete');
      result.historyVerified=true; result.historySnapshot=snapshot;
    }
    await page.waitForFunction(subscriptionAttached,{manifest:m,previousSession},{timeout:120_000});
    result.coldHistoryLoadMs=unixMs()-coldStart;
    await page.evaluate(m => {
      const r = window.__flowmapLive.renderer;
      r.goLive(); r.setTimeWindowMs(m.timeWindowMs || 15000); r.setPriceFollow('fit');
    }, m);
    await enableProductionOverlays(page);
    const browserCDP = await browser.newBrowserCDPSession();
    try { result.systemInfo = await browserCDP.send('SystemInfo.getInfo'); }
    catch (error) { result.systemInfoError = String(error); }
    try { result.processInfo = await browserCDP.send('SystemInfo.getProcessInfo'); }
    catch (error) { result.processInfoError = String(error); }
    result.geometry = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      const gl = canvas?.getContext('webgl2');
      const ext = gl?.getExtension('WEBGL_debug_renderer_info');
      const rect = canvas?.getBoundingClientRect();
      return { innerWidth, innerHeight, devicePixelRatio, physicalContentWidth: innerWidth * devicePixelRatio,
        physicalContentHeight: innerHeight * devicePixelRatio, screen: { width: screen.width, height: screen.height },
        canvas: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height, backingWidth: canvas.width, backingHeight: canvas.height } : null,
        glRenderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
        glVendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null,
        panels: ['dom-ladder', 'tape', 'cvd-pane'].map(id => ({ id, visible: !!document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect().height })),
        localStorage: Object.fromEntries(Object.entries(localStorage)) };
    });
    await page.screenshot({ path: path.join(config.output, 'native-start.png') });
    const canvas = await page.locator('canvas').first().boundingBox();
    if (!canvas) throw new Error('Chart canvas missing');
    const cx = canvas.x + canvas.width * .5, cy = canvas.y + canvas.height * .5;
    // A fully fitted history viewport may legitimately clamp a pan/zoom. Probe
    // the production handlers at a smaller actual frame, then restore baseline.
    await page.waitForFunction(() => window.__flowmapLive.renderer.newestColSeq>=64,null,{timeout:30_000});
    await page.evaluate(() => { const r=window.__flowmapLive.renderer; r.goLive(); r.setTimeWindowMs(12000); });
    await sleep(100);
    await page.mouse.move(cx, cy);
    const before=await page.evaluate(() => window.__flowmapLive.renderer.viewSnapshot);
    await page.mouse.down(); await page.mouse.move(cx+80,cy+10,{steps:8}); await page.mouse.up();
    await sleep(100);
    const pan=await page.evaluate(() => ({view:window.__flowmapLive.renderer.viewSnapshot,following:window.__flowmapLive.renderer.following}));
    await page.mouse.wheel(0,-90); await sleep(100);
    const zoom=await page.evaluate(() => window.__flowmapLive.renderer.viewSnapshot);
    result.interactionResponse={pan:pan.following===false && pan.view.colOffset!==before.colOffset,
      zoom:zoom.colScale!==pan.view.colScale,
      wheelAxis:'time (unmodified chart wheel; Shift/Ctrl are absent)',before,afterPan:pan.view,afterZoom:zoom};
    if (!result.interactionResponse.pan || !result.interactionResponse.zoom) throw new Error('Production camera did not respond to pan and wheel gestures');
    await page.evaluate(m => { const r=window.__flowmapLive.renderer; r.goLive(); r.setTimeWindowMs(m.timeWindowMs || 15000); },m);
    // Restore the full overview and await any history work caused by the probe.
    if (config.scope === 'normalized-history-replay') {
      const deadline=performance.now()+(config.historyTimeoutMs || 180_000);
      let snapshot;
      do { snapshot=await sample(); if(historyCovered(snapshot,config.historyEvidence)) break; await sleep(250); } while(performance.now()<deadline);
      if (!historyCovered(snapshot,config.historyEvidence)) throw new Error('History coverage unavailable after gesture probe');
    }
    health.request();
    write('ready.json', result);
    const start = performance.now(), warmupEnd = start + config.warmup * 1000;
    let finalDeadline = Infinity;
    let nextSample = start, step = 0, interactionCycle = 0;
    result.goLiveCycles=[];
    while (performance.now() < finalDeadline && !fs.existsSync(path.join(config.output, 'stop'))) {
      const now = performance.now();
      if (!measuring && now >= warmupEnd && !sampler.busy && !health.busy && health.last) {
        // A completed warmup health baseline precedes the cheap client boundary.
        // No new health request begins until this snapshot has returned.
        const baseline=await snapshot();
        measuring = true;
        result.measurementStartUnixMs = baseline.timeOriginMs+baseline.nowMs;
        result.pageMeasurementStartMs = baseline.nowMs;
        finalDeadline = performance.now() + config.duration * 1000;
        sampler.request(baseline,true);
        write('measurement-start.json', { unixMs: result.measurementStartUnixMs });
        console.log('MEASURED_START', new Date().toISOString());
      }
      const cycle=Math.floor((now-start)/m.interaction.cycleMs);
      if(m.mode==='live' && cycle>interactionCycle) {
        if(cycle!==interactionCycle+1) throw new Error('Interaction cycle skipped during a driver stall');
        if(mouseDown){await page.mouse.up();mouseDown=false;}
        const actionStartUnixMs=unixMs();
        await productionGoLive(page);
        result.goLiveCycles.push({cycle,actionStartUnixMs,actionEndUnixMs:unixMs(),followingVerified:true});
      }
      interactionCycle=cycle;
      const phase = ((now - start) % m.interaction.cycleMs) / m.interaction.cycleMs;
      if (phase < .5) {
        if (!mouseDown) { await page.mouse.move(cx, cy); await page.mouse.down(); mouseDown = true; }
        await page.mouse.move(cx + Math.sin(step * .045 + m.seed) * canvas.width * .12, cy + Math.cos(step * .03) * 18);
      } else {
        if (mouseDown) { await page.mouse.up(); mouseDown = false; }
        await page.mouse.move(cx, cy);
        await page.mouse.wheel(0, step % 2 ? 2 : -2);
      }
      if (now >= nextSample) {
        // Single flight: skip overlap instead of awaiting it in the input loop.
        sampler.request(null,measuring);
        health.request();
        nextSample = now + SAMPLE_RETRY_MS;
      }
      step++;
      // Real input events dispatch to the unmodified gesture handlers; stalls remain in the run.
      await sleep(Math.max(0, start + step * m.interaction.stepMs - performance.now()));
    }
    // End the measured phase at the end of continuous input, before final
    // health/screenshot/CDP verification. Their errors still prevent completion.
    result.measurementEndUnixMs = unixMs();
    if (mouseDown) { await page.mouse.up(); mouseDown = false; }
    // Keep the actual pending/final response, but its end cannot be moved into
    // the measured interval. stop() drains at the original 10-second deadline.
    await drainIndependentSamplers(health,sampler,async()=>{
      await sample();
      result.pageMeasurementEndMs = await page.evaluate(() => performance.now());
    });
    result.healthCollection.drained=true;
    result.interactionSteps = step;
    await page.screenshot({ path: path.join(config.output, 'native-end.png') });
    result.systemInfoEnd=await browserCDP.send('SystemInfo.getInfo');
    result.processInfoEnd=await browserCDP.send('SystemInfo.getProcessInfo');
    result.finalVerificationComplete=measuring;
  } catch (error) { result.errors.push(error.stack || String(error)); process.exitCode = 1; }
  finally {
    if(health){await health.stop();result.healthCollection.drained=true;result.healthCollection.collectionEndMonoMs=health.collectionEndMonoMs;result.healthCollection.stats=health.stats;result.healthCollection.errors=health.errors;}
    await sampler.flush();
    result.sampler= sampler.stats;
    await new Promise(resolve => lines.end(resolve));
    await new Promise(resolve => healthLines.end(resolve));
    finish(result,config.duration,fs.existsSync(path.join(config.output,'stop')));
    if(!result.complete) process.exitCode=1;
    write('driver-result.json', result);
    // Do not close the CDP browser: its lifecycle belongs to the owned Windows job.
    process.exit();
  }
})();
