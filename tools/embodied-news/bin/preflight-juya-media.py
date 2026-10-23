"""Decode every finite edit before starting an expensive full-episode render."""
from pathlib import Path
import argparse,importlib.util,json,hashlib


def main():
    ap=argparse.ArgumentParser();ap.add_argument('directory',type=Path);args=ap.parse_args()
    root=args.directory.resolve()
    spec=importlib.util.spec_from_file_location('entry',Path(__file__).with_name('render-juya-video.py'))
    entry=importlib.util.module_from_spec(spec);spec.loader.exec_module(entry)
    from juya_media import ClipReader,validate_sequence
    unique={}
    for lang in ['zh','en']:
        manifest=json.loads((root/f'manifest.{lang}.json').read_text(encoding='utf-8'));ranges={}
        for ti,theme in enumerate(manifest['themes']):
            validate_sequence(theme['media_sequence'],ranges)
            for item in theme['media_sequence']:
                if item['kind']!='video':continue
                key=(item['path'],item['source_in'],item['source_out'],item['frame_count'])
                if key in unique:
                    unique[key]['uses'].append({'language':lang,'theme':ti+1});continue
                reader=ClipReader(root/item['path'],item,320,180,30)
                try:
                    for _ in range(item['frame_count']):reader.next()
                    assert reader.remaining==0
                finally:reader.close()
                unique[key]={'path':item['path'],'sha256':hashlib.sha256((root/item['path']).read_bytes()).hexdigest(),
                             'sourceIn':item['source_in'],'sourceOut':item['source_out'],
                             'expectedFrames':item['frame_count'],'decodedFrames':item['frame_count'],
                             'uses':[{'language':lang,'theme':ti+1}]}
    proof={'status':'all_finite_clips_decoded','languages':['zh','en'],'clips':list(unique.values()),
           'rendererScaleForCheck':[320,180],'outputFps':30,'loop':False}
    (root/'verification').mkdir(exist_ok=True)
    (root/'verification/finite-clip-preflight.json').write_text(json.dumps(proof,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'status':proof['status'],'distinctVideoCuts':len(unique),'languages':proof['languages']}))


if __name__=='__main__':main()
