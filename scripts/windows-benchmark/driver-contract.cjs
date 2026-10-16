const SAMPLE_RETRY_MS = 250;
const HEALTH_CONTRACT = 'independent-health-v1';
const HEALTH_TIMEOUT_MS = 10_000;
function ownedHealthUrl(base, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || base !== `http://127.0.0.1:${port}`)
    throw new Error('Health target does not match the owned literal loopback server port');
  return base + '/api/health';
}
function healthCollector({url, onObservation, onError, timeoutMs=HEALTH_TIMEOUT_MS,
    clock=()=>require('node:perf_hooks').performance.now(),
    origin=require('node:perf_hooks').performance.timeOrigin,
    collectionId=require('node:crypto').randomUUID()}) {
  const http=require('node:http'), parsed=new URL(url);
  if (ownedHealthUrl(parsed.origin,Number(parsed.port)) !== url)
    throw new Error('Health URL must be the exact owned loopback health endpoint');
  let stopped=false, sequence=0, last=null, nextRequest=-Infinity, collectionEndMonoMs=null;
  const collectionStartMonoMs=clock();
  const errors=[];
  const report=error=>{const message=error.stack||String(error);errors.push(message);try{onError(error);}catch(e){errors.push('Health error callback: '+(e.stack||String(e)));}};
  const sampler=singleFlightSampler(async()=>{
    const start=clock();
    const row={schema:1,contract:HEALTH_CONTRACT,collectionId,observationId:`${collectionId}:${++sequence}`,
      requestSequence:sequence,url,method:'GET',collectorTimeOriginMs:origin,
      requestStartMonoMs:start,requestStartUnixMs:origin+start,statusCode:null,error:null,timedOut:false,
      responseBody:''};
    await new Promise(resolve=>{
      let settled=false,request,timer;
      const done=error=>{
        if(settled)return;settled=true;clearTimeout(timer);
        if(error)row.error=String(error);
        row.requestEndMonoMs=clock();row.requestEndUnixMs=origin+row.requestEndMonoMs;
        row.requestDurationMs=row.requestEndMonoMs-start;
        resolve();
      };
      timer=setTimeout(()=>{row.timedOut=true;request?.destroy(new Error('Health request timed out'));done(new Error('Health request timed out'));},timeoutMs);
      try {
        request=http.get(url,{agent:false,headers:{'Cache-Control':'no-cache, no-store','Connection':'close'}},response=>{
          row.statusCode=response.statusCode;
          response.setEncoding('utf8');
          response.on('data',chunk=>{if(!settled)row.responseBody+=chunk;});
          response.on('error',done);
          response.on('aborted',()=>done(new Error('Health response aborted')));
          response.on('end',()=>{
            if(settled)return;
            try {
              if(row.statusCode!==200)throw new Error(`Health HTTP status ${row.statusCode}; redirects are forbidden`);
              const body=JSON.parse(row.responseBody);
              if(!body || Array.isArray(body) || typeof body!=='object')throw new Error('Health JSON must be an object');
              done();
            } catch(error){done(error);}
          });
          response.on('close',()=>{if(!response.complete)done(new Error('Health response closed before completion'));});
        });
        request.on('socket',socket=>socket.once('connect',()=>{
          if(socket.remoteAddress!=='127.0.0.1' || socket.remotePort!==Number(parsed.port))
            request.destroy(new Error('Health connection target differs from owned loopback endpoint'));
        }));
        request.on('error',done);
      } catch(error){done(error);}
    });
    last=row;
    // Preserve the actual row before reporting HTTP or persistence failures.
    try {await onObservation(row);}catch(error){report(error);}
    if(row.error)report(new Error(`${row.observationId}: ${row.error}`));
  },report);
  return {collectionId,url,errors,stats:sampler.stats,collectionStartMonoMs,
    get collectionEndMonoMs(){return collectionEndMonoMs;},get busy(){return sampler.busy;},get last(){return last;},
    request(){if(stopped)return false;const now=clock();if(now<nextRequest)return false;
      nextRequest=now+SAMPLE_RETRY_MS;return sampler.request();},
    async stop({final=false}={}){
      const boundary=final?clock():null;
      stopped=true;await sampler.flush();
      // A recent ordinary success can still leave an unsampled end tail.
      // Reuse an in-flight response only if it actually completed after this
      // boundary. Otherwise issue one final real request outside ordinary pacing.
      if(boundary!==null && (!last || last.requestEndMonoMs<=boundary)){
        sampler.request();await sampler.flush();
      }
      if(collectionEndMonoMs===null)collectionEndMonoMs=clock();
    },
    async flush(){await sampler.flush();}};
}
async function drainIndependentSamplers(health, client, finalClient) {
  const draining=health.stop({final:true});
  // Capture the final client drain immediately. Waiting for a pending health
  // response first would introduce its latency into the last client interval.
  try {await client.flush();return await finalClient();}
  finally {await draining;}
}
function serializeBenchmarkJson(value, space) {
  // Nanosecond timestamps must stay exact in JSON artifacts and raw rows.
  return JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, space);
}
function benchmarkPageSnapshot() {
  const l=window.__flowmapLive,state=l.store.getState();
  const metrics=l.renderer.benchmarkDrain();
  if(!metrics) throw new Error('Benchmark raw instrumentation unavailable');
  const raw=l.renderer.timeline(),base=raw?.timeBase;
  // Copy scalars only. Never clone/serialize the renderer's growing slot table.
  const timeline=raw ? {oldestSeq:raw.oldestSeq,newestSeq:raw.newestSeq,
    viewStartCol:raw.viewStartCol,viewEndCol:raw.viewEndCol,
    timeBase:base ? {anchorSeq:base.anchorSeq,anchorT0Ns:base.anchorT0Ns,dtNs:base.dtNs} : null} : null;
  const newestT0=raw && l.renderer.timestampAtColumn(raw.newestSeq),dtNs=base?.dtNs;
  const sourceTimeline=newestT0!==null && newestT0!==undefined && Number.isSafeInteger(dtNs) && dtNs>0
    ? {newestSeq:raw.newestSeq,newestT0Ns:String(newestT0),dtNs,edgeEndNs:String(newestT0+BigInt(dtNs)),
       meaning:'Exclusive end of newest renderer column from timestampAtColumn(newestSeq)+dtNs; independent of camera; not an exchange-event timestamp'} : null;
  return {...metrics,status:state.status,feedState:state.feedState,
    session:state.sessionId,subscription:state.subscription,capability:state.capability,drawCount:l.renderer.drawCount,
    overview:l.renderer.overviewStats(),history:l.renderer.historyStats(),timeline,sourceTimeline,view:l.renderer.viewSnapshot,
    overlays:l.renderer.overlayVisibility(),overlayData:l.renderer.overlayDebugForTest(),
    cvdPoints:l.renderer.cvdSeries(0,Number.MAX_SAFE_INTEGER).length,
    geometry:{physicalContentWidth:innerWidth*devicePixelRatio,physicalContentHeight:innerHeight*devicePixelRatio,devicePixelRatio},
    panels:['dom-ladder','tape','cvd-pane'].map(id=>({id,visible:!!document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect().height})),
    book:{trades:l.bookStore.getSnapshot().trades.length,hasBook:!!l.bookStore.getSnapshot().book},pageVisibility:document.visibilityState};
}
function historyCovered(snapshot, evidence) {
  const o = snapshot.overview, h = snapshot.history;
  return !!(evidence && o && h && !o.inFlight && !h.inFlight && !o.error && !h.error &&
    o.progress.total > 0 && o.progress.loaded >= o.progress.total &&
    o.buckets >= Math.ceil(evidence.columns / o.stride) && o.timeBounds &&
    BigInt(o.timeBounds.startNs) <= BigInt(evidence.start_ns) &&
    BigInt(o.timeBounds.endNs) >= BigInt(evidence.end_ns));
}
function finish(result, duration, stopped) {
  result.complete = !!(result.finalVerificationComplete && !stopped && result.errors.length === 0 &&
    Number.isFinite(result.measurementStartUnixMs) && Number.isFinite(result.measurementEndUnixMs) &&
    result.measurementEndUnixMs-result.measurementStartUnixMs >= duration*1000);
  return result.complete;
}
function singleFlightSampler(sample, onError) {
  let active=null;
  const stats={started:0,completed:0,skipped:0,failed:0};
  return {
    stats, get busy(){return active!==null;},
    request(...args){
      if(active){stats.skipped++;return false;}
      stats.started++;
      active=Promise.resolve().then(()=>sample(...args)).catch(error=>{stats.failed++;onError(error);})
        .finally(()=>{stats.completed++;active=null;});
      return true;
    },
    async flush(){if(active) await active;},
  };
}
async function enableProductionOverlays(page) {
  await page.getByTestId('settings-open').click();
  const drawer=page.getByTestId('settings-drawer');
  for(const prefix of ['Liquidity profile','CVD —','Volume —']) {
    const button=drawer.getByRole('button',{name:new RegExp('^'+prefix)});
    if(await button.getAttribute('aria-pressed')!=='true') await button.click();
  }
  await page.getByTestId('settings-close').click();
  await page.waitForFunction(()=>{
    const persisted=JSON.parse(localStorage.getItem('flowmap.settings.v1')||'{}').overlays;
    const actual=window.__flowmapLive.renderer.overlayVisibility();
    return ['profile','cvd','volume'].every(key=>persisted?.[key]===true && actual[key]===true);
  });
}
async function productionGoLive(page) {
  // The production button routes through App and persists follow policy.
  await page.getByTestId('go-live').click();
  await page.waitForFunction(()=>window.__flowmapLive.renderer.following===true);
}
function subscriptionAttached({manifest,previousSession}) {
  const l=window.__flowmapLive,s=l?.store.getState(),sub=s?.subscription;
  return !!(s && sub && s.status==='live' && s.sessionId && s.sessionId!==previousSession &&
    sub.market===manifest.market && sub.symbol===manifest.symbol && sub.mode===manifest.mode && sub.band===manifest.band &&
    String(sub.startNs??'')===String(manifest.window?.startNs??'') &&
    String(sub.endNs??'')===String(manifest.window?.endNs??'') &&
    l.renderer.marketFrameReady && l.renderer.newestColSeq>=0);
}
module.exports = { SAMPLE_RETRY_MS, HEALTH_CONTRACT, HEALTH_TIMEOUT_MS, ownedHealthUrl, healthCollector, drainIndependentSamplers, serializeBenchmarkJson, benchmarkPageSnapshot, historyCovered, finish, singleFlightSampler, enableProductionOverlays, productionGoLive, subscriptionAttached };
