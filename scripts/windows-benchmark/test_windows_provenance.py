import ast
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import test_provenance
from provenance import artifact, bind_sidecar, same_identity, sample_identity, verify_artifact

HERE = Path(__file__).resolve().parent

class WindowsIdentityTests(unittest.TestCase):
    @unittest.skipUnless(os.name == 'nt', 'Windows aliases')
    def test_aliases_junction_and_final_sample(self):
        with tempfile.TemporaryDirectory(prefix='Kullanıcı-') as d:
            root=Path(d)
            repo,runtime,exe,package=test_provenance.ContractTests().fixture(root)
            manifest=artifact(repo,exe,runtime,package)
            extended=lambda p: '\\\\?\\'+str(p.resolve())
            native={'sidecarPid':123,'interpreter':extended(runtime/'python.exe')}
            report={'pid':123,'owner':'token','executable':str(runtime/'python.exe'),'package_origin':str(package/'__init__.py')}
            process={'pid':123,'creation_ticks':456,'image':str(runtime/'python.exe')}
            binding=bind_sidecar(native,report,[process],Path(native['interpreter']).parent,manifest,'token')
            self.assertTrue(sample_identity(process,binding))
            self.assertFalse(sample_identity(process|{'image':str(exe)},binding))
            self.assertFalse(sample_identity(process|{'pid':124},binding))
            self.assertFalse(sample_identity(process|{'creation_ticks':457},binding))
            self.assertFalse(same_identity(root/'missing',root/'missing'))
            junction=root/'alias'
            subprocess.run(['cmd','/c','mklink','/J',str(junction),str(runtime)],check=True,capture_output=True)
            try:
                alias_report=report|{'package_origin':str(junction/'Lib/site-packages/flowmap_server/__init__.py')}
                self.assertTrue(bind_sidecar(native,alias_report,[process],runtime,manifest,'token')['origin_verified'])
                self.assertEqual(artifact(repo,exe,runtime,junction/'Lib/site-packages/flowmap_server'),manifest)
                outside=root/'external.py';outside.write_text('external',encoding='utf-8')
                other=runtime/'Lib/site-packages/other/__init__.py'
                other.parent.mkdir();other.write_text('other',encoding='utf-8')
                for bad in (report|{'owner':'wrong'},report|{'package_origin':str(outside)},
                            report|{'package_origin':str(other)}):
                    with self.assertRaises(ValueError): bind_sidecar(native,bad,[process],runtime,manifest,'token')
            finally:
                junction.rmdir()

    @unittest.skipUnless(os.name == 'nt', 'Windows isolated startup')
    def test_actual_guard_isolated_unicode_profile(self):
        source=HERE.parents[1]/'server/src/flowmap_server/__main__.py'
        module=ast.parse(source.read_text(encoding='utf-8'))
        guard=ast.unparse(next(n for n in module.body if isinstance(n,ast.FunctionDef) and n.name=='_benchmark_provenance'))
        with tempfile.TemporaryDirectory(prefix='Kullanıcı-') as d:
            profile=Path(d); (profile/'.flowmap-benchmark-owner').write_text('token',encoding='utf-8')
            code="import os,sys,types\nsys.modules['flowmap_server']=types.SimpleNamespace(__file__=sys.executable)\n"+guard+'\n_benchmark_provenance()'
            env=os.environ.copy();env.pop('PYTHONUTF8',None)
            env.update(FLOWMAP_BENCHMARK_OWNER='token',FLOWMAP_BENCHMARK_PROFILE=str(profile),FLOWMAP_BENCHMARK_PROVENANCE='\\\\?\\'+str(profile/'sidecar-provenance.json'))
            result=subprocess.run([sys.executable,'-I','-B','-c',code],env=env,capture_output=True)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(json.loads((profile/'sidecar-provenance.json').read_text(encoding='utf-8'))['owner'],'token')
            different=profile/'different';different.mkdir()
            (different/'.flowmap-benchmark-owner').write_text('token',encoding='utf-8')
            for changes in ({'FLOWMAP_BENCHMARK_OWNER':'wrong'},{'FLOWMAP_BENCHMARK_PROFILE':str(profile/'missing')},
                            {'FLOWMAP_BENCHMARK_PROFILE':str(different)}):
                bad=subprocess.run([sys.executable,'-I','-B','-c',code],env=env|changes,capture_output=True)
                self.assertNotEqual(bad.returncode,0)

    def test_all_json_reads_explicit_utf8_with_cp1254_default(self):
        original=io.open
        def locale_open(file,mode='r',buffering=-1,encoding=None,*args,**kwargs):
            return original(file,mode,buffering,encoding or ('cp1254' if 'b' not in mode else None),*args,**kwargs)
        with tempfile.TemporaryDirectory(prefix='Kullanıcı-') as d:
            root=Path(d); path=root/'native-info.json'
            expected={'profile':str(root),'text':'Kullanıcı'}
            path.write_text(json.dumps(expected,ensure_ascii=False),encoding='utf-8')
            # Path.read_text resolves omitted encoding before io.open, including
            # under -X utf8. Simulate the default explicitly at that boundary.
            with patch('io.open',locale_open), patch('io.text_encoding',side_effect=lambda encoding,*args: 'cp1254' if encoding is None else encoding):
                self.assertNotEqual(json.loads(path.read_text()),expected)
                count=0
                for name in ('run.py','provenance.py','campaign.py','fixture.py','create_fixture.py'):
                    module=ast.parse((HERE/name).read_text(encoding='utf-8'))
                    for call in ast.walk(module):
                        if isinstance(call,ast.Call) and isinstance(call.func,ast.Attribute) and call.func.attr=='read_text':
                            encoding=next((ast.literal_eval(k.value) for k in call.keywords if k.arg=='encoding'),None)
                            self.assertIn(encoding,('utf-8','utf-8-sig'),name)
                            # Execute the production call itself against Unicode JSON while
                            # io.open's omitted-encoding behavior is deliberately cp1254.
                            expression=ast.Expression(ast.Call(
                                func=ast.Attribute(value=ast.Name(id='path',ctx=ast.Load()),attr='read_text',ctx=ast.Load()),
                                args=call.args,keywords=call.keywords))
                            self.assertEqual(json.loads(eval(compile(ast.fix_missing_locations(expression),name,'eval'),{'path':path})),expected)
                            count+=1
                self.assertGreater(count,10)
                repo,runtime,exe,package=test_provenance.ContractTests().fixture(root)
                config=root/'Kullanıcı-config.json';config.write_text('{}',encoding='utf-8')
                manifest=artifact(repo,exe,runtime,package,config)
                sealed=root/'sealed.json';sealed.write_text(json.dumps(manifest,ensure_ascii=False),encoding='utf-8')
                self.assertEqual(verify_artifact(json.loads(sealed.read_text(encoding='utf-8-sig')),repo,exe,runtime),manifest)

if __name__=='__main__': unittest.main()
