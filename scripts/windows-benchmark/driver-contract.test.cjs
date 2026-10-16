const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const contract=require('./driver-contract.cjs');
const {serializeBenchmarkJson,finish,historyCovered,singleFlightSampler,enableProductionOverlays,productionGoLive,subscriptionAttached}=contract;

function historySnapshot(){
  return {schema:2,nowMs:128.5,timeOriginMs:1700000000000,status:'live',
    subscription:{market:'binance-spot',symbol:'BTCUSDT',mode:'replay',band:'deep',
      startNs:1700000000000123456n,endNs:1700003600000123456n},
    timeline:{oldestSeq:0,newestSeq:14399,viewStartCol:0,viewEndCol:14399,
      timeBase:{anchorSeq:7200,anchorT0Ns:1700001800000123456n,dtNs:250000000}},
    sourceTimeline:{newestT0Ns:'1700003599750123456',edgeEndNs:'1700003600000123456',dtNs:250000000},
    history:{inFlight:false,error:null},overview:{buckets:225,progress:{loaded:225,total:225},
      timeBounds:{startNs:'1700000000000123456',endNs:'1700003600000123456'}},
    nested:[null,{values:[0n,-9007199254740993n,9007199254740993n,7,1.25,true,'ordinary']}]};
}

test('benchmark JSON preserves exact history BigInts and final errors without mutating snapshots',()=>{
  const snapshot=historySnapshot(),result={errors:['Production camera did not respond'],complete:false,historyVerified:true,historySnapshot:snapshot};
  const original=structuredClone(result),prototype=Object.getOwnPropertyDescriptor(BigInt.prototype,'toJSON');
  const json=serializeBenchmarkJson(result,2),parsed=JSON.parse(json);
  const expected=structuredClone(original);
  expected.historySnapshot.subscription.startNs='1700000000000123456';
  expected.historySnapshot.subscription.endNs='1700003600000123456';
  expected.historySnapshot.timeline.timeBase.anchorT0Ns='1700001800000123456';
  expected.historySnapshot.nested[1].values=['0','-9007199254740993','9007199254740993',7,1.25,true,'ordinary'];
  assert.deepEqual(parsed,expected);
  assert.deepEqual(result,original);assert.equal(result.historySnapshot,snapshot);
  assert.deepEqual(Object.getOwnPropertyDescriptor(BigInt.prototype,'toJSON'),prototype);
  assert.ok(json.includes('\n  "errors": ['));assert.equal(json.endsWith('\n'),false);
});

test('benchmark JSON keeps ordinary JSON shape, indentation and newline semantics',()=>{
  const ordinary={nil:null,list:[1,undefined,NaN,Infinity,false,'line\ntext'],omitted:undefined,
    date:new Date('2026-10-15T00:00:00.000Z'),number:1.25};
  for(const indent of [undefined,2,'\t']) assert.equal(serializeBenchmarkJson(ordinary,indent),JSON.stringify(ordinary,null,indent));
  assert.equal(serializeBenchmarkJson(undefined),undefined);
  assert.equal(serializeBenchmarkJson(9007199254740993n),'"9007199254740993"');
});

test('benchmark JSON rejects cyclic values and preserves ordinary serialization errors',()=>{
  const cyclic={historySnapshot:historySnapshot()};cyclic.self=cyclic;
  assert.throws(()=>serializeBenchmarkJson(cyclic,2),TypeError);
  assert.equal(cyclic.self,cyclic);assert.equal(cyclic.historySnapshot.subscription.startNs,1700000000000123456n);
  const failure=new Error('ordinary toJSON failure');
  assert.throws(()=>serializeBenchmarkJson({toJSON(){throw failure;}}),error=>error===failure);
});

test('all driver artifacts and raw client rows use the exported benchmark JSON serializer',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'driver.cjs'),'utf8');
  assert.deepEqual([...source.matchAll(/\bwrite\('([^']+)'/g)].map(match=>match[1]),
    ['ready.json','measurement-start.json','driver-result.json']);
  assert.equal(source.includes('JSON.stringify'),false);
  const end=source.indexOf('\n(async () => {');assert.ok(end>0);
  const output=path.join(__dirname,'unused-test-output'),artifacts=new Map(),rows=[],calls=[];
  const config={output,playwright:'mock-playwright',manifest:{}};
  const mockFs={readFileSync:()=>JSON.stringify(config),writeFileSync:(name,value)=>artifacts.set(path.basename(name),value),
    createWriteStream:()=>({write:value=>rows.push(value),on(){return this;}})};
  const context={module:{exports:{}},process:{argv:['node','driver.cjs','mock-config.json']},setTimeout,clearTimeout,
    testPage:{evaluate:async()=>({stats_available:true})},require(id){
      if(id==='node:fs')return mockFs;
      if(id==='mock-playwright')return {chromium:{}};
      if(id==='./driver-contract.cjs')return {...contract,serializeBenchmarkJson(value,indent){calls.push(indent);return serializeBenchmarkJson(value,indent);}};
      return require(id);
    }};
  // Load the actual driver writers, stopping before its native connection IIFE.
  vm.runInNewContext(source.slice(0,end)+'\npage=testPage;module.exports={write,sample};',context);
  const {write,sample}=context.module.exports,snapshot=historySnapshot();
  const result={errors:['earlier driver failure'],complete:false,historySnapshot:snapshot},original=structuredClone(result);
  write('ready.json',result);write('measurement-start.json',{unixMs:1700000000128.5});
  const raw=await sample(historySnapshot(),true);
  write('driver-result.json',result);
  assert.deepEqual(calls,[2,2,undefined,2]);assert.deepEqual(result,original);
  for(const name of ['ready.json','driver-result.json']){
    assert.equal(artifacts.get(name),serializeBenchmarkJson(result,2));
    assert.equal(JSON.parse(artifacts.get(name)).historySnapshot.subscription.endNs,'1700003600000123456');
    assert.equal(artifacts.get(name).endsWith('\n'),false);
  }
  assert.equal(artifacts.get('measurement-start.json'),'{\n  "unixMs": 1700000000128.5\n}');
  assert.equal(rows.length,1);assert.equal(rows[0],serializeBenchmarkJson(raw)+'\n');
  assert.equal(rows[0].split('\n').length,2);
  assert.equal(JSON.parse(rows[0]).timeline.timeBase.anchorT0Ns,'1700001800000123456');
  assert.equal(JSON.parse(rows[0]).sourceTimeline.newestT0Ns,'1700003599750123456');
  assert.equal(raw.timeline.timeBase.anchorT0Ns,1700001800000123456n);
  const cyclic=historySnapshot();cyclic.self=cyclic;
  assert.throws(()=>write('rejected.json',cyclic),TypeError);assert.equal(artifacts.has('rejected.json'),false);
  await assert.rejects(sample(cyclic,true),TypeError);assert.equal(rows.length,1);
});
test('elapsed duration does not hide page errors or post-measurement exceptions',()=>{
  const r={errors:[],measurementStartUnixMs:0,measurementEndUnixMs:10000};
  assert.equal(finish(r,10,false),false);
  r.finalVerificationComplete=true;assert.equal(finish(r,10,false),true);
  r.errors.push('screenshot failed');assert.equal(finish(r,10,false),false);
});
test('replay attaches using connected transport and a matching fresh session/window',()=>{
  const manifest={market:'binance-spot',symbol:'BTCUSDT',mode:'replay',band:'deep',window:{startNs:'100',endNs:'200'}};
  const state={status:'live',sessionId:'new',subscription:{...manifest,startNs:100n,endNs:200n}};
  global.window={__flowmapLive:{store:{getState:()=>state},renderer:{marketFrameReady:true,newestColSeq:0}}};
  const config={manifest,previousSession:'old'};
  try{
    assert.equal(subscriptionAttached(config),true);
    for(const [key,value] of [['mode','live'],['market','sim'],['symbol','ETHUSDT'],['band','native'],['startNs',99n],['endNs',201n]]){
      const prior=state.subscription[key];state.subscription[key]=value;assert.equal(subscriptionAttached(config),false,key);state.subscription[key]=prior;
    }
    state.sessionId='old';assert.equal(subscriptionAttached(config),false);state.sessionId='new';
    state.status='reconnecting';assert.equal(subscriptionAttached(config),false);state.status='live';
    window.__flowmapLive.renderer.marketFrameReady=false;assert.equal(subscriptionAttached(config),false);
  }finally{delete global.window;}
});
test('one replay column and label do not prove full rendered history',()=>{
  const evidence={columns:14400,start_ns:'1000000000',end_ns:'3601000000000'};
  const s={history:{inFlight:false,error:null},overview:{inFlight:false,error:null,stride:64,buckets:225,
    progress:{loaded:225,total:225},timeBounds:{startNs:'1000000000',endNs:'3601000000000'}}};
  assert.equal(historyCovered(s,evidence),true);
  s.overview.buckets=1;assert.equal(historyCovered(s,evidence),false);
  s.overview.buckets=225;s.overview.timeBounds.endNs='2000000000';assert.equal(historyCovered(s,evidence),false);
});
test('slow sampling does not block inputs or create overlapping samplers',async()=>{
  let release,active=0,maxActive=0,inputSteps=0;
  const gate=new Promise(resolve=>release=resolve);
  const sampler=singleFlightSampler(async()=>{active++;maxActive=Math.max(maxActive,active);await gate;active--;},()=>assert.fail('unexpected sampler error'));
  assert.equal(sampler.request(),true);await Promise.resolve();
  for(let i=0;i<30;i++){inputSteps++;assert.equal(sampler.request(),false);await Promise.resolve();}
  assert.equal(inputSteps,30);assert.equal(sampler.stats.skipped,30);assert.equal(maxActive,1);
  release();await sampler.flush();assert.equal(sampler.busy,false);assert.equal(sampler.stats.completed,1);
});
test('asynchronous sampler errors remain visible and do not reject the input loop',async()=>{
  const errors=[];const sampler=singleFlightSampler(async()=>{throw Error('telemetry failed');},e=>errors.push(e.message));
  sampler.request();await sampler.flush();assert.deepEqual(errors,['telemetry failed']);assert.equal(sampler.stats.failed,1);
});
test('production overlay buttons persist state through an App follow update',async()=>{
  const persisted={profile:false,cvd:true,volume:false};let actual={...persisted};const clicks=[];
  const labels={profile:'Liquidity profile — resting orders by price; not executed trade volume',cvd:'CVD — cumulative volume delta (lower pane)',volume:'Volume — traded volume bars along the chart bottom'};
  global.localStorage={getItem:()=>JSON.stringify({overlays:persisted})};
  global.window={__flowmapLive:{renderer:{overlayVisibility:()=>actual}}};
  const page={
    getByTestId(id){return {async click(){clicks.push(id);},getByRole(role,{name}){
      const key=Object.keys(labels).find(k=>name.test(labels[k]));assert.ok(key);
      return {async getAttribute(){return String(persisted[key]);},async click(){clicks.push(key);persisted[key]=!persisted[key];actual={...persisted};}};
    }};},async waitForFunction(fn){assert.equal(fn(),true);},
  };
  try{await enableProductionOverlays(page);actual={...persisted};assert.equal(actual.profile,true);assert.equal(actual.volume,true);assert.deepEqual(clicks,['settings-open','profile','volume','settings-close']);}
  finally{delete global.localStorage;delete global.window;}
});

test('250 ms single-flight retry keeps bounded slow health inside strict 3000 ms coverage',async()=>{
  const {SAMPLE_RETRY_MS}=require('./driver-contract.cjs');
  async function simulation(healthMs){
    let now=0,doneAt=-1,resolveHealth;const snapshots=[];
    const sampler=singleFlightSampler(()=>{snapshots.push(now);doneAt=now+healthMs;return new Promise(r=>resolveHealth=r);},e=>{throw e;});
    for(now=0;now<=8000;now+=10){
      if(sampler.busy && now>=doneAt && resolveHealth){resolveHealth();resolveHealth=null;await sampler.flush();}
      if(now%SAMPLE_RETRY_MS===0) sampler.request();
      await Promise.resolve();
    }
    if(resolveHealth) resolveHealth();await sampler.flush();
    return Math.max(...snapshots.slice(1).map((v,i)=>v-snapshots[i]));
  }
  assert.equal(SAMPLE_RETRY_MS,250);
  assert.ok(await simulation(2322.877)<=3000);
  assert.ok(await simulation(3100)>3000);
});

test('go-live cycle uses the production App button and verifies actual follow before gestures resume',async()=>{
  let following=false;const actions=[];
  global.window={__flowmapLive:{renderer:{get following(){return following;}}}};
  const page={getByTestId(id){assert.equal(id,'go-live');return {async click(){actions.push('production-click');following=true;}};},
    async waitForFunction(fn){actions.push('verify-follow');assert.equal(fn(),true);}};
  try{await productionGoLive(page);actions.push('resume-gestures');assert.deepEqual(actions,['production-click','verify-follow','resume-gestures']);}
  finally{delete global.window;}
});

test('page snapshot keeps scalar timeline and exact source edge without reading growing slot table',()=>{
  const {benchmarkPageSnapshot}=require('./driver-contract.cjs');
  const base={anchorSeq:7200,anchorT0Ns:1700001800000000000n,dtNs:250000000};
  Object.defineProperty(base,'slots',{get(){throw Error('growing slot table must not be read or serialized');}});
  const timeline={oldestSeq:0,newestSeq:7200,viewStartCol:12,viewEndCol:72,timeBase:base};
  const history={inFlight:false,error:null,loaded:7200},overview={inFlight:false,timeBounds:{startNs:'1',endNs:'2'}};
  global.window={__flowmapLive:{store:{getState:()=>({status:'live',feedState:'live',sessionId:'owned',subscription:{mode:'live'},capability:{source_book_events:10}})},
    renderer:{benchmarkDrain:()=>({schema:2,nowMs:1}),timeline:()=>timeline,timestampAtColumn:seq=>{assert.equal(seq,7200);return 1700001800000123456n;},
      overviewStats:()=>overview,historyStats:()=>history,viewSnapshot:{colOffset:12},overlayVisibility:()=>({profile:true}),
      overlayDebugForTest:()=>({}),cvdSeries:()=>[1,2],drawCount:42},bookStore:{getSnapshot:()=>({trades:[1],book:{}})}}};
  global.innerWidth=1920;global.innerHeight=1080;global.devicePixelRatio=1;
  global.document={visibilityState:'visible',querySelector:()=>({getBoundingClientRect:()=>({height:20})})};
  try{
    const result=benchmarkPageSnapshot();
    assert.deepEqual(Object.keys(result.timeline.timeBase),['anchorSeq','anchorT0Ns','dtNs']);
    assert.equal(result.sourceTimeline.newestT0Ns,'1700001800000123456');
    assert.equal(result.sourceTimeline.edgeEndNs,'1700001800250123456');
    assert.equal(result.history,history);assert.equal(result.overview,overview);
    const compact=serializeBenchmarkJson(result);
    assert.equal(compact.includes('slots'),false);assert.ok(compact.length<2000);
    assert.equal(timeline.timeBase,base);assert.equal(result.book.trades,1);assert.equal(result.panels.length,3);
  }finally{for(const key of ['window','innerWidth','innerHeight','devicePixelRatio','document'])delete global[key];}
});
