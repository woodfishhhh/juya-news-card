"""Bind render, technical checks and actual review to immutable file identities."""
import hashlib,json
from pathlib import Path
from datetime import datetime,timezone

PROJECT=Path(__file__).resolve().parents[1]
def digest(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
    return h.hexdigest()
def object_hash(value):return hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
def read(path):return json.loads(Path(path).read_text(encoding='utf-8'))
def write(path,value):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    temp=path.with_suffix(path.suffix+'.tmp');temp.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8');temp.replace(path)
def local(root,value):
    p=(root/value).resolve()
    if not p.is_relative_to(root.resolve()) or not p.is_file():raise ValueError('Missing or out-of-package asset: '+value)
    return p
def build_identity(manifest_path,parameters=None):
    manifest_path=Path(manifest_path).resolve();root=manifest_path.parent;m=read(manifest_path)
    files={manifest_path};lang=m['language']
    for name in ['content.json',f'cards.{lang}.json','music-order.json']:
        if (root/name).exists():files.add(root/name)
    keys={'path','narration','card_image','opening_card_image','opening_narration','closing_narration','transition_sound','media','video','image'}
    def visit(value):
        if isinstance(value,dict):
            for k,v in value.items():
                if k in keys and isinstance(v,str) and v and not v.startswith(('https://','http://')):
                    p=local(root,v);files.add(p)
                    timeline=p.with_suffix('.timeline.json')
                    if k.endswith('narration') and timeline.exists():files.add(timeline)
                elif isinstance(v,(dict,list)):visit(v)
        elif isinstance(value,list):
            for v in value:visit(v)
    visit(m)
    code=[PROJECT/'bin/render-juya-video.py',PROJECT/'bin/prepare-juya-audio.py',PROJECT/'bin/prepare-juya-media.py',
          PROJECT/'vendor/juya-news-card/tools/evening-video/render_evening.py']
    code+=sorted((PROJECT/'bin').glob('juya_*.py'))
    value={'schemaVersion':1,'files':{p.relative_to(root).as_posix():digest(p) for p in sorted(files)},
           'code':{p.relative_to(PROJECT).as_posix():digest(p) for p in code},'parameters':parameters or {},'fontSha256':digest(parameters['font']) if parameters and parameters.get('font') else None}
    return {**value,'buildHash':object_hash(value)}
def video_identity(video):
    video=Path(video).resolve();meta=read(video.with_suffix('.manifest.json'));binding=meta.get('productionBinding')
    if not binding:raise ValueError('No version-bound render receipt; historical output is not newly reviewed')
    manifest=video.parent/binding['manifest']
    current=build_identity(manifest,binding['inputs']['parameters'])
    if current['buildHash']!=binding['inputs']['buildHash']:raise ValueError('Stale render: source, asset, audio, captions or renderer changed')
    actual=digest(video)
    if actual!=meta['sha256']:raise ValueError('Video bytes changed after rendering')
    return {'kind':'video','language':meta['language'],'buildHash':current['buildHash'],'sha256':actual,'issueContentSha256':current['files'].get('content.json')}
def review_identity(target):
    target=Path(target).resolve()
    if target.suffix.lower()=='.mp4':return video_identity(target)
    p=read(target)
    if p.get('kind')!='independent-cover':raise ValueError('Expected an independent cover provenance file')
    for row in p['dependencies']+p['outputs']:
        if digest(local(target.parent,row['file']))!=row['sha256']:raise ValueError('Cover input or output changed')
    return {'kind':'cover','language':p['language'],'sha256':digest(target),'issueContentSha256':p['issueContentSha256']}
def current_technical(video,identity):
    receipt=read(Path(video).parent/f'verification/video.{identity["language"]}.json')
    if receipt.get('status')!='technical_checks_passed' or receipt.get('productionIdentity')!=identity:
        raise ValueError('Matching technical verification is required')
    return receipt
def review_path(target,stage):return Path(str(target)+f'.{stage}-review.json')
def check_review(target,stage):
    identity=review_identity(target);receipt=read(review_path(target,stage))
    if receipt.get('identity')!=identity or receipt.get('decision')!='approved':raise ValueError('Review missing, rejected or stale: '+stage)
    for row in receipt['evidence']:
        if digest(local(Path(target).resolve().parent,row['file']))!=row['sha256']:raise ValueError('Review evidence changed')
    return receipt
def record_review(target,stage,decision,notes,evidence,reviewer):
    target=Path(target).resolve();identity=review_identity(target)
    if not notes.strip() or not reviewer.strip() or not evidence:raise ValueError('Reviewer, actual inspection notes and evidence required')
    if decision=='approved' and identity['kind']=='video':
        current_technical(target,identity)
        if stage=='acceptance':check_review(target,'visual')
    rows=[]
    for value in evidence:
        path=Path(value).resolve()
        if not path.is_relative_to(target.parent):raise ValueError('Keep review evidence in the production package')
        rows.append({'file':path.relative_to(target.parent).as_posix(),'sha256':digest(path)})
    receipt={'schemaVersion':1,'identity':identity,'stage':stage,'decision':decision,'reviewer':reviewer,
             'notes':notes,'evidence':rows,'recordedAt':datetime.now(timezone.utc).isoformat()}
    destination=review_path(target,stage)
    # Keep the prior attestation for audit; changing a decision does not erase it.
    if destination.exists():
        old=read(destination);write(destination.with_name(destination.name+'.'+object_hash(old)[:16]+'.history.json'),old)
    write(destination,receipt);return receipt
