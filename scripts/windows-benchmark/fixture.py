"""Verify actual normalized Parquet geometry and coverage, independently of labels."""
import hashlib
import json
from pathlib import Path
from core import fixture_files


def verify_fixture(root, manifest):
    import pyarrow.parquet as pq
    import pyarrow.compute as pc
    root=Path(root).resolve()
    if manifest.get('rows')!=4096 or manifest.get('band')!='deep' or not manifest.get('provenance'):
        raise ValueError('Fixture needs explicit provenance and 4096-row deep production geometry')
    if fixture_files(root) != manifest['history']['files']: raise ValueError('History fixture hashes changed')
    epochs={}
    columns=[]
    for path in sorted(root.rglob('*-epochs-*.parquet')):
        for e in pq.read_table(path).to_pylist():
            key=(e.get('recording_id',''),e['epoch'])
            geometry={k:e[k] for k in ('rows','dt_ns','tick','p0')}
            if key in epochs and epochs[key]!=geometry: raise ValueError('Conflicting fixture epoch geometry')
            epochs[key]=geometry
    for path in sorted(root.rglob('*-columns-*.parquet')):
        table=pq.read_table(path,columns=['recording_id','epoch','col_seq','t0_ns','bid','ask'])
        bid_lengths=pc.list_value_length(table['bid']).to_pylist()
        ask_lengths=pc.list_value_length(table['ask']).to_pylist()
        for c,bid_rows,ask_rows in zip(table.select(['recording_id','epoch','col_seq','t0_ns']).to_pylist(),bid_lengths,ask_lengths):
            epoch=epochs.get((c.get('recording_id',''),c['epoch']))
            if not epoch or bid_rows!=epoch['rows'] or ask_rows!=epoch['rows']:
                raise ValueError('Fixture column row/epoch mismatch')
            if epoch['dt_ns']!=250_000_000 or epoch['rows']!=4096: raise ValueError('Fixture epoch does not match deep production geometry')
            columns.append((c['t0_ns'],c['col_seq'],epoch['dt_ns'],c.get('recording_id','')))
    columns.sort()
    if not columns: raise ValueError('Fixture contains no finalized columns')
    if len({(c[0],c[3]) for c in columns})!=len(columns): raise ValueError('Duplicate fixture finalized timestamps')
    if any(b[0]!=a[0]+a[2] or b[1]!=a[1]+1 or b[3]!=a[3] for a,b in zip(columns,columns[1:])):
        raise ValueError('Fixture finalized columns are not one contiguous recording')
    start,end=columns[0][0],columns[-1][0]+columns[-1][2]
    span=(end-start)/1e9
    window=manifest.get('window') or {}
    if int(window.get('startNs',-1))!=start or int(window.get('endNs',-1))!=end:
        raise ValueError('Fixture timestamp span differs from manifest window')
    if span<manifest['history']['requiredSeconds'] or span<3600: raise ValueError('Fixture has less than one hour of finalized coverage')
    if manifest.get('columns',len(columns))!=len(columns): raise ValueError('Fixture column count differs from manifest')
    return {'verified':True,'span_seconds':span,'columns':len(columns),'start_ns':str(start),'end_ns':str(end),
            'dt_ns':columns[0][2],'rows':manifest.get('rows',4096),'recording_id':columns[0][3],
            'provenance':manifest.get('provenance'),'files_digest':hashlib.sha256(json.dumps(manifest['history']['files'],sort_keys=True).encode()).hexdigest()}
