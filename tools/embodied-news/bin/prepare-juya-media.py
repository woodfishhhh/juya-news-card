"""Rebuild sentence-bound edits from existing audio, with no TTS/API calls."""
import argparse,json
from pathlib import Path
from juya_media import schedule_bound_media

def prepare(root,locale):
    content=json.loads((root/'content.json').read_text(encoding='utf-8'))
    path=root/f'manifest.{locale}.json'
    manifest=json.loads(path.read_text(encoding='utf-8'))
    if len(content['themes'])!=len(manifest['themes']):raise ValueError('Theme count changed; prepare matching audio first')
    for authored,theme in zip(content['themes'],manifest['themes']):
        cues=theme['narration_captions']
        if [c['text'] for c in cues]!=authored['versions'][locale]['sentences']:
            raise ValueError('Narration changed; matching audio is required before media scheduling')
        items=authored.get('mediaSequences',{}).get(locale,authored.get('mediaSequence',[]))
        theme['media_sequence']=schedule_bound_media(items,cues,theme['duration_seconds'])
    manifest['media_binding_policy']='sentence-v1'
    return manifest

if __name__=='__main__':
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('directory',type=Path)
    ap.add_argument('--locale',choices=['zh','en','all'],default='all');ap.add_argument('--write',action='store_true')
    args=ap.parse_args();root=args.directory.resolve();languages=['zh','en'] if args.locale=='all' else [args.locale]
    results={lang:prepare(root,lang) for lang in languages}
    if args.write:
        for lang,m in results.items():
            path=root/f'manifest.{lang}.json';temp=path.with_suffix('.json.tmp')
            temp.write_text(json.dumps(m,ensure_ascii=False,indent=2)+'\n',encoding='utf-8');temp.replace(path)
    print(json.dumps({'status':'media_written' if args.write else 'media_validated','languages':languages,'ttsCalls':0}))
