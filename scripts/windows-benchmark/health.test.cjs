const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {performance}=require('node:perf_hooks');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {healthCollector,ownedHealthUrl,drainIndependentSamplers,HEALTH_TIMEOUT_MS}=require('./driver-contract.cjs');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function actualDriverSampler(rows){
  let nowMs=0;
  const source=fs.readFileSync(path.join(__dirname,'driver.cjs'),'utf8');
  const context={module:{exports:{}},process:{argv:['node','driver.cjs','config']},setTimeout,clearTimeout,
    testPage:{evaluate:async()=>({schema:2,timeOriginMs:100000,nowMs:nowMs+=250,frames:[],inputs:[]})},
    require(id){
      if(id==='node:fs')return {readFileSync:()=>JSON.stringify({output:'unused',playwright:'mock-playwright',manifest:{}}),
        createWriteStream:name=>({on(){return this;},write(value){if(name.endsWith('client.ndjson'))rows.push(JSON.parse(value));}})};
      if(id==='mock-playwright')return {chromium:{}};
      return require(id);
    }};
  vm.runInNewContext(source.slice(0,source.indexOf('\n(async () => {'))+'\npage=testPage;module.exports={sampler};',context);
  return context.module.exports.sampler;
}

async function endpoint(handler, action){
  const sockets=new Set(),server=http.createServer(handler);
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {await action(ownedHealthUrl(`http://127.0.0.1:${server.address().port}`,server.address().port));}
  finally {for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}
}

test('actual held HTTP health for 3.4 seconds leaves independent 4 Hz client and inputs running',async t=>{
  let active=0,peak=0,release,received;
  const entered=new Promise(resolve=>received=resolve),hold=new Promise(resolve=>release=resolve);
  await endpoint(async(req,res)=>{
    active++;peak=Math.max(peak,active);received();
    if(active===1 && !release.done)await hold;
    active--;res.setHeader('Content-Type','application/json');res.end('{"stats_available":true,"exact_ns":1792147180751590701}');
  },async url=>{
    const rows=[],errors=[],snapshots=[];let inputSteps=0;
    const health=healthCollector({url,onObservation:row=>rows.push(structuredClone(row)),onError:error=>errors.push(String(error))});
    // Execute the actual driver's sample()/single-flight path, with the page
    // RPC returning an independent synthetic client clock. Health is real HTTP.
    const client=actualDriverSampler(snapshots);
    health.request();await entered;
    const tick=setInterval(()=>{inputSteps++;},16);
    const sample=setInterval(()=>{client.request(null,true);health.request();},250);
    try {
      await sleep(3425);
      assert.equal(rows.length,0);assert.equal(health.busy,true);
      assert.ok(snapshots.length>=12,`snapshots=${snapshots.length}`);assert.ok(inputSteps>100);
      release.done=true;release();await health.flush();
      assert.equal(rows.length,1);assert.ok(rows[0].requestDurationMs>=3400);
      assert.equal(rows[0].requestEndUnixMs,rows[0].collectorTimeOriginMs+rows[0].requestEndMonoMs);
      assert.equal(rows[0].statusCode,200);assert.equal(rows[0].error,null);
      assert.ok(rows[0].responseBody.includes('1792147180751590701'),'raw HTTP body retains the exact integer');
      await sleep(260);health.request();await health.flush();
    }finally{clearInterval(tick);clearInterval(sample);release.done=true;release();await client.flush();await health.stop();}
    assert.ok(rows.length>=2);assert.equal(peak,1);assert.ok(health.stats.skipped>=10);
    assert.equal(health.stats.started,health.stats.completed);assert.equal(health.stats.started,rows.length);
    assert.equal(health.request(),false);assert.deepEqual(errors,[]);
    assert.equal(new Set(rows.map(row=>row.observationId)).size,rows.length);
    assert.ok(snapshots.slice(1).every((s,i)=>s.nowMs-snapshots[i].nowMs===250));
    assert.ok(snapshots.slice(1).every((s,i)=>s.sourceObservation.collectorEndMs-snapshots[i].sourceObservation.collectorEndMs<1000));
    assert.ok(snapshots.every(s=>s.sampling.contract==='independent-health-v1' && !('health' in s)));
    t.diagnostic(JSON.stringify({probe:'actual-held-health-with-driver-sample',healthLatencyMs:rows[0].requestDurationMs,
      clientSnapshots:snapshots.length,maxActualClientGapMs:Math.max(...snapshots.slice(1).map((s,i)=>
        s.sourceObservation.collectorEndMs-snapshots[i].sourceObservation.collectorEndMs)),inputSteps,
      healthRows:rows.length,maxSimultaneousHttpRequests:peak,healthErrors:errors.length,drained:!health.busy}));
  });
});

test('real pending HTTP is drained, timeout is retained, and stopped worker cannot restart',async()=>{
  await endpoint(()=>{},async url=>{
    const rows=[],errors=[];
    const health=healthCollector({url,timeoutMs:60,onObservation:row=>rows.push(row),onError:e=>errors.push(String(e))});
    assert.equal(HEALTH_TIMEOUT_MS,10000);health.request();await Promise.resolve();
    const stop=health.stop();assert.equal(health.busy,true);assert.equal(health.request(),false);
    await stop;assert.equal(rows.length,1);assert.equal(rows[0].timedOut,true);assert.match(rows[0].error,/timed out/);
    assert.ok(rows[0].requestDurationMs>=50);assert.equal(rows[0].statusCode,null);assert.equal(errors.length,1);
    assert.equal(health.busy,false);assert.equal(health.stats.completed,1);assert.ok(health.collectionEndMonoMs>=rows[0].requestEndMonoMs);
  });
});

test('recent idle success gets a real clean or changed final bracket without relaxing ordinary pacing',async()=>{
  for(const changed of [false,true]){
    let loss=0,active=0,peak=0;
    await endpoint((req,res)=>{
      active++;peak=Math.max(peak,active);
      res.end(JSON.stringify({stats:{drops:{feed:loss}}}));active--;
    },async url=>{
      const rows=[],errors=[],health=healthCollector({url,onObservation:r=>rows.push(r),onError:e=>errors.push(String(e))});
      health.request();await health.flush();
      assert.equal(health.request(),false,'ordinary 250ms pacing remains');
      const end=performance.timeOrigin+performance.now();loss=changed?1:0;
      let captured=false;
      await drainIndependentSamplers(health,{flush:async()=>{}},async()=>{captured=true;});
      assert.equal(captured,true);assert.equal(rows.length,2);
      assert.ok(rows[1].requestEndUnixMs>end,'actual completed final response');
      assert.equal(JSON.parse(rows[1].responseBody).stats.drops.feed,loss);
      assert.equal(health.stats.started,2);assert.equal(health.stats.completed,2);
      assert.equal(peak,1);assert.deepEqual(errors,[]);assert.equal(health.request(),false);
    });
  }
});

test('pre-end HTTP success still persisting at drain gets a fresh bracket and client stays independent',async()=>{
  let release,entered;
  const hold=new Promise(resolve=>release=resolve),persisting=new Promise(resolve=>entered=resolve);
  await endpoint((req,res)=>res.end('{"actual":true}'),async url=>{
    const rows=[],health=healthCollector({url,onObservation:async r=>{
      rows.push(r);if(rows.length===1){entered();await hold;}
    },onError:e=>assert.fail(String(e))});
    health.request();await persisting;
    const end=performance.timeOrigin+performance.now();
    let captured=false;
    const drain=drainIndependentSamplers(health,{flush:async()=>{}},async()=>{captured=true;});
    await sleep(10);assert.equal(captured,true);assert.equal(rows.length,1);
    release();await drain;
    assert.equal(rows.length,2);assert.ok(rows[0].requestEndUnixMs<end);
    assert.ok(rows[1].requestEndUnixMs>end);
  });
});

test('final forced real request retains timeout/failure evidence after recent success',async()=>{
  for(const kind of ['timeout','status']){
    let requests=0;
    await endpoint((req,res)=>{
      if(++requests===1)res.end('{"actual":true}');
      else if(kind==='status'){res.statusCode=503;res.end('{}');}
    },async url=>{
      const rows=[],errors=[],health=healthCollector({url,timeoutMs:60,onObservation:r=>rows.push(r),onError:e=>errors.push(String(e))});
      health.request();await health.flush();
      await drainIndependentSamplers(health,{flush:async()=>{}},async()=>{});
      assert.equal(rows.length,2);assert.equal(errors.length,1);
      assert.ok(rows[1].error);assert.equal(rows[1].timedOut,kind==='timeout');
      assert.equal(health.stats.started,health.stats.completed);assert.equal(health.busy,false);
    });
  }
});

test('final client capture completes before held post-window health drain, including callback failure',async()=>{
  for(const fail of [false,true]){
    let release,received;
    const hold=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>received=resolve);
    await endpoint(async(req,res)=>{received();await hold;res.end('{"actual":true}');},async url=>{
      const rows=[],clients=[],health=healthCollector({url,onObservation:r=>rows.push(r),onError:e=>assert.fail(String(e))});
      health.request();await entered;
      let captured=false,finished=false;
      const client=actualDriverSampler(clients);
      const drain=drainIndependentSamplers(health,client,async()=>{
        client.request(null,true);await client.flush();captured=true;
        if(fail)throw Error('final client failed');
      });
      // Attach rejection immediately; it must retain the client failure after
      // the independent health drain, without an unhandled rejected promise.
      const outcome=drain.then(()=>{finished=true;return null;},error=>{finished=true;return error;});
      try {
        await sleep(25);assert.equal(captured,true);assert.equal(clients.length,1);assert.equal(rows.length,0);
        assert.equal(finished,false);assert.equal(health.request(),false);
      }finally{release();}
      const error=await outcome;assert.equal(rows.length,1);assert.equal(health.busy,false);
      if(fail)assert.match(error.message,/final client failed/);else assert.equal(error,null);
    });
  }
});

test('redirect, malformed JSON, status and aborted responses are retained as actual errors',async()=>{
  for(const kind of ['redirect','json','status','aborted']){
    await endpoint((req,res)=>{
      if(kind==='redirect'){res.writeHead(302,{Location:'http://127.0.0.1:1/api/health'});res.end('{}');}
      if(kind==='json')res.end('{bad');
      if(kind==='status'){res.statusCode=503;res.end('{"error":"busy"}');}
      if(kind==='aborted'){res.writeHead(200,{'Content-Length':100});res.write('{');setImmediate(()=>res.destroy());}
    },async url=>{
      const rows=[],errors=[],health=healthCollector({url,onObservation:r=>rows.push(r),onError:e=>errors.push(String(e))});
      health.request();await health.stop();assert.equal(rows.length,1,kind);assert.equal(errors.length,1,kind);
      assert.ok(rows[0].error,kind);assert.ok(rows[0].requestEndMonoMs>=rows[0].requestStartMonoMs);
      if(kind==='redirect'){assert.equal(rows[0].statusCode,302);assert.match(rows[0].error,/redirects are forbidden/);}
    });
  }
});

test('failed async persistence/error callbacks preserve the original health row and failure without rejection',async()=>{
  await endpoint((req,res)=>res.end('{"actual":true}'),async url=>{
    const rows=[];
    const health=healthCollector({url,onObservation:async row=>{rows.push(row);await Promise.resolve();throw Error('disk failed');},
      onError:()=>{throw Error('error callback failed');}});
    health.request();await health.stop();assert.equal(rows.length,1);assert.equal(rows[0].error,null);
    assert.equal(rows[0].responseBody,'{"actual":true}');
    assert.equal(health.errors.length,2);assert.match(health.errors[0],/disk failed/);assert.match(health.errors[1],/error callback failed/);
  });
});

test('health endpoint validation rejects alternate hosts, redirects, paths and owned-port mismatch',()=>{
  for(const base of ['http://localhost:1234','http://127.0.0.2:1234','https://127.0.0.1:1234','http://127.0.0.1:1234/',
    'http://user@127.0.0.1:1234','http://127.0.0.1:1235'])assert.throws(()=>ownedHealthUrl(base,1234));
  for(const url of ['http://127.1:1234/api/health','http://127.0.0.1:1234/api/health?cache=1','http://127.0.0.1:1234/else'])
    assert.throws(()=>healthCollector({url,onObservation(){},onError(){}}));
});
