"""Record an actual inspection, or check whether its exact version is still current."""
import argparse,json
from pathlib import Path
from juya_review import record_review,check_review
if __name__=='__main__':
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('target',type=Path)
    ap.add_argument('--stage',choices=['visual','acceptance'],default='visual');ap.add_argument('--check',action='store_true')
    ap.add_argument('--decision',choices=['approved','rejected']);ap.add_argument('--notes');ap.add_argument('--reviewer')
    ap.add_argument('--evidence',type=Path,action='append',default=[]);a=ap.parse_args()
    if a.check:r=check_review(a.target,a.stage)
    else:
        if not a.decision or not a.notes or not a.reviewer:ap.error('Explicit decision, notes and reviewer required; never infer approval')
        r=record_review(a.target,a.stage,a.decision,a.notes,a.evidence,a.reviewer)
    print(json.dumps({'stage':r['stage'],'decision':r['decision'],'identity':r['identity']},ensure_ascii=False))
