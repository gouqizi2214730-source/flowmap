"""Frozen artifact contract. Run inputs BEFORE building, then seal AFTER packaging."""
from pathlib import Path
import argparse
import hashlib
import json
import os


def same_identity(left, right, *, directory=False):
    """Existing filesystem identity, including Windows extended and junction aliases."""
    try:
        left, right = Path(left), Path(right)
        valid = (left.is_dir() and right.is_dir()) if directory else (left.is_file() and right.is_file())
        return valid and left.samefile(right)
    except (OSError, ValueError, TypeError):
        return False


def physical_relative(path, root):
    """Locate a resolved descendant by ancestor identity, without lexical prefix hacks."""
    try:
        path, root = Path(path).resolve(strict=True), Path(root).resolve(strict=True)
    except (OSError, ValueError) as error:
        raise ValueError('Missing/inaccessible provenance path') from error
    for parent in path.parents:
        if same_identity(parent, root, directory=True):
            return path.relative_to(parent)
    raise ValueError('Package outside runtime')


def sample_identity(process, binding):
    return (process.get('pid') == binding['pid'] and
            process.get('creation_ticks') == binding['creation_ticks'] and
            same_identity(process.get('image'), binding['image']))


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def tree(root, *, reject_cache=False, exclude_cache=False):
    root=Path(root).resolve()
    if not root.is_dir(): raise ValueError(f'Missing tree: {root}')
    rows=[]
    for p in sorted(root.rglob('*')):
        if p.is_symlink(): raise ValueError(f'Symlink in frozen tree: {p}')
        if not p.is_file(): continue
        if exclude_cache and ('__pycache__' in p.parts or p.suffix in ('.pyc','.pyo')): continue
        if reject_cache and ('__pycache__' in p.parts or p.suffix in ('.pyc','.pyo')):
            raise ValueError(f'Remove cache from owned artifact before preparation: {p}')
        rows.append({'path':p.relative_to(root).as_posix(),'size':p.stat().st_size,'sha256':sha(p)})
    if not rows: raise ValueError(f'Empty tree: {root}')
    return rows


def digest(rows):
    return hashlib.sha256(json.dumps(rows,sort_keys=True,separators=(',',':')).encode()).hexdigest()


def source_fingerprint(repo, native_config=None):
    repo=Path(repo).resolve(); rows=[]
    excluded={'node_modules','target','dist','pyruntime','__pycache__','.venv','.git','gen','tests','.pytest_cache','.ruff_cache','.mypy_cache','.vite','coverage','build','docs'}
    for directory in ('client','server','app/src-tauri','scripts/windows-benchmark'):
        for base,dirs,files in os.walk(repo/directory):
            dirs[:]=sorted(d for d in dirs if d not in excluded)
            for name in sorted(files):
                p=Path(base)/name
                if p.suffix.lower() in ('.md','.pyc','.pyo') or '.test.' in name: continue
                rows.append({'path':p.relative_to(repo).as_posix(),'size':p.stat().st_size,'sha256':sha(p)})
    if native_config:
        p=Path(native_config)
        rows.append({'path':'@native-build-config','size':p.stat().st_size,'sha256':sha(p)})
    return digest(sorted(rows,key=lambda r:r['path']))


def package_parity(repo, package):
    source=tree(Path(repo)/'server/src/flowmap_server',exclude_cache=True)
    installed=tree(package,reject_cache=True)
    if source!=installed: raise ValueError('Installed server file set/content differs from frozen source')
    return digest(source)


def artifact(repo, exe, runtime, package, native_config=None):
    runtime=Path(runtime).resolve(); package=Path(package).resolve()
    relative=physical_relative(package,runtime)
    return {'schema':1,'source_fingerprint':source_fingerprint(repo,native_config),'native_config_path':str(Path(native_config).resolve()) if native_config else None,'exe_sha256':sha(exe),
            'runtime_sha256':digest(tree(runtime,reject_cache=True)),
            'package_sha256':package_parity(repo,package),'package_relative':relative.as_posix()}


def verify_artifact(manifest,repo,exe,runtime):
    actual=artifact(repo,exe,runtime,Path(runtime)/manifest['package_relative'],manifest.get('native_config_path'))
    if actual!=manifest: raise ValueError('Frozen build manifest differs from current source/executable/runtime/package')
    return actual


def bind_sidecar(native, report, processes, runtime, manifest, owner):
    runtime=Path(runtime).resolve()
    if not report or report.get('owner')!=owner: raise ValueError('Absent/wrong sidecar owner report')
    pid=native.get('sidecarPid')
    matches=[p for p in processes if p.get('pid')==pid]
    if len(matches)!=1 or report.get('pid')!=pid: raise ValueError('Sidecar is not job-owned')
    process=matches[0]
    interpreter=Path(native['interpreter']).resolve()
    origin=Path(report['package_origin']).resolve()
    expected=runtime/manifest['package_relative']/'__init__.py'
    physical_relative(origin,runtime)
    if (not same_identity(interpreter.parent,runtime,directory=True) or
        not same_identity(report['executable'],interpreter) or
        not same_identity(process['image'],interpreter) or not same_identity(origin,expected) or not process.get('creation_ticks')):
        raise ValueError('Sidecar interpreter/package origin/identity mismatch')
    return {'pid':pid,'creation_ticks':process['creation_ticks'],'image':str(interpreter),
            'package_origin':str(origin),'runtime_path':str(runtime),'origin_verified':True}


def provenance_verified(value):
    return isinstance(value,dict) and all(value.get(k) is True for k in
        ('origin_verified','package_parity_verified','source_match_verified','unchanged_verified','identity_verified'))


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('command',choices=['inputs','seal']);p.add_argument('--repo',type=Path,required=True)
    p.add_argument('--inputs',type=Path,required=True);p.add_argument('--exe',type=Path)
    p.add_argument('--runtime',type=Path);p.add_argument('--package',type=Path);p.add_argument('--output',type=Path)
    p.add_argument('--native-config',type=Path,required=True)
    a=p.parse_args()
    for output in (a.inputs,a.output):
        if output and a.repo.resolve() in output.resolve().parents:
            p.error('Preparation outputs must be outside the source tree (no changing self-hash)')
    if a.command=='inputs':
        with a.inputs.open('x',encoding='utf-8') as f: json.dump({'source_fingerprint':source_fingerprint(a.repo,a.native_config)},f,indent=2)
    else:
        record=artifact(a.repo,a.exe,a.runtime,a.package,a.native_config)
        if json.loads(a.inputs.read_text(encoding='utf-8-sig'))['source_fingerprint']!=record['source_fingerprint']:
            raise ValueError('Production inputs changed during build/package')
        with a.output.open('x',encoding='utf-8') as f: json.dump(record,f,indent=2)

if __name__=='__main__': main()
