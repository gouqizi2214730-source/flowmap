import copy
import json
import tempfile
import unittest
from pathlib import Path
from core import workload_sample
from provenance import artifact, verify_artifact, source_fingerprint, bind_sidecar, digest, tree

class ContractTests(unittest.TestCase):
    def test_workload(self):
        manifest=dict(market='binance-spot',symbol='BTCUSDT',mode='replay',band='deep',window={'startNs':'100','endNs':'200'})
        baseline={'required_panels':['dom','tape','cvd'],'required_overlays':['profile','cvd','volume']}
        s={'status':'live','session':'session','subscription':manifest|manifest['window'],
           'panels':[{'id':p,'visible':True} for p in baseline['required_panels']],
           'overlays':{k:True for k in baseline['required_overlays']},'overlayData':{'profileMax':1,'volumeBars':1},'cvdPoints':1,
           'health':{'feeds':[manifest|{'session_id':'session','state':'live'}]},'feedState':'live','book':{'hasBook':True,'trades':1}}
        self.assertTrue(workload_sample(s,manifest,'normalized-history-replay',baseline))
        for status in ('replay','reconnecting',None):
            self.assertFalse(workload_sample(s|{'status':status},manifest,'normalized-history-replay',baseline))
        for key in ('mode','band','market','symbol','startNs','endNs'):
            self.assertFalse(workload_sample(s|{'subscription':s['subscription']|{key:'wrong'}},manifest,'normalized-history-replay',baseline))
        for change in ({'session':''},{'session':'wrong'},{'overlayData':{}},{'cvdPoints':0},{'panels':[]},{'overlays':{}}):
            self.assertFalse(workload_sample(s|change,manifest,'normalized-history-replay',baseline))
        manifest['mode']='live';manifest.pop('window');s['subscription']=manifest.copy();s['health']['feeds'][0]['mode']='live'
        self.assertTrue(workload_sample(s,manifest,'live-recording',baseline))
        for change in ({'book':{}},{'feedState':'reconnecting'}):
            self.assertFalse(workload_sample(s|change,manifest,'live-recording',baseline))

    def fixture(self, root):
        repo=root/'source';runtime=root/'external-runtime';exe=root/'Benchmark.exe';package=runtime/'Lib/site-packages/flowmap_server'
        for p in (repo/'server/src/flowmap_server',repo/'client/src',package): p.mkdir(parents=True)
        for p in (repo/'server/src/flowmap_server/__init__.py',package/'__init__.py'): p.write_text('VERSION="1.5.0"')
        for p in (runtime/'python.exe',runtime/'native.dll',exe): p.write_bytes(b'fixture')
        for relative in ('client/src/style.css','client/index.html','client/package-lock.json','client/vite.config.ts'):
            (repo/relative).write_text('original')
        return repo,runtime,exe,package

    def test_frozen_runtime_and_source(self):
        with tempfile.TemporaryDirectory() as directory:
            repo,runtime,exe,package=self.fixture(Path(directory)); manifest=artifact(repo,exe,runtime,package)
            self.assertEqual(verify_artifact(manifest,repo,exe,runtime),manifest)
            config=Path(directory)/'native-build-config.json';config.write_text('{}')
            before=source_fingerprint(repo,config);config.write_text('{"changed":true}')
            self.assertNotEqual(before,source_fingerprint(repo,config))
            for path in (runtime/'native.dll',package/'__init__.py',repo/'server/src/flowmap_server/__init__.py',repo/'client/src/style.css',repo/'client/index.html',repo/'client/package-lock.json',repo/'client/vite.config.ts',exe):
                old=path.read_bytes();path.write_bytes(old+b'changed')
                if runtime in path.parents: self.assertNotEqual(digest(tree(runtime)),manifest['runtime_sha256'])
                with self.assertRaises(ValueError): verify_artifact(manifest,repo,exe,runtime)
                path.write_bytes(old)
            (runtime/'cache.pyc').write_bytes(b'executable cache')
            with self.assertRaises(ValueError): artifact(repo,exe,runtime,package)

    def test_sidecar_origin_and_owned_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);repo,runtime,exe,package=self.fixture(root);manifest=artifact(repo,exe,runtime,package)
            native={'sidecarPid':123,'interpreter':str(runtime/'python.exe')}
            report={'pid':123,'owner':'token','executable':str(runtime/'python.exe'),'package_origin':str(package/'__init__.py')}
            processes=[{'pid':123,'creation_ticks':456,'image':str(runtime/'python.exe')}]
            self.assertTrue(bind_sidecar(native,report,processes,runtime,manifest,'token')['origin_verified'])
            for bad in ({},report|{'pid':456},report|{'owner':'wrong'},report|{'executable':str(exe)},report|{'package_origin':str(root/'__init__.py')}):
                with self.assertRaises((ValueError,KeyError)): bind_sidecar(native,bad,processes,runtime,manifest,'token')
            for bad in ([],[processes[0]|{'image':str(exe)}],[processes[0]|{'creation_ticks':0}]):
                with self.assertRaises(ValueError): bind_sidecar(native,report,bad,runtime,manifest,'token')

if __name__=='__main__': unittest.main()
