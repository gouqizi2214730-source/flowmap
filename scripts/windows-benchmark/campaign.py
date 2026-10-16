"""Link immutable run results; a single diagnostic PASS never certifies a minimum."""
import argparse
import hashlib
import json
from pathlib import Path
from core import campaign_assess

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--history-result',type=Path,required=True)
    p.add_argument('--live-result',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True)
    p.add_argument('--boundary-result',type=Path,action='append',default=[])
    p.add_argument('--soak-result',type=Path)
    p.add_argument('--live-soak-result',type=Path)
    a=p.parse_args()
    if a.output.exists(): p.error('Campaign output must be new; previous evidence is preserved')
    h=json.loads(a.history_result.read_text(encoding='utf-8-sig'))
    l=json.loads(a.live_result.read_text(encoding='utf-8-sig'))
    boundary=[json.loads(f.read_text(encoding='utf-8-sig')) for f in a.boundary_result]
    soak=json.loads(a.soak_result.read_text(encoding='utf-8-sig')) if a.soak_result else None
    live_soak=json.loads(a.live_soak_result.read_text(encoding='utf-8-sig')) if a.live_soak_result else None
    result=campaign_assess(h,l,boundary,soak,live_soak)
    files=[a.history_result,a.live_result]+a.boundary_result+([a.soak_result] if a.soak_result else [])+([a.live_soak_result] if a.live_soak_result else [])
    result['linked_results']=[{'path':str(f.resolve()),'sha256':hashlib.sha256(f.read_bytes()).hexdigest()} for f in files]
    a.output.write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps(result)); raise SystemExit(0 if result['status']=='PASS' else 2)
