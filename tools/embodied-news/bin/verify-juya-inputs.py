"""Validate actual cards, source samples and sentence geometry before production."""
import argparse, hashlib, importlib.util, json, os, subprocess, wave
from pathlib import Path
from PIL import Image, ImageDraw
from juya_production import caption_geometry, timeline_for
from juya_media import validate_sequence, validate_bindings
from juya_captions import display_text

def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def check(root):
    spec=importlib.util.spec_from_file_location('entry',Path(__file__).with_name('render-juya-video.py'))
    entry=importlib.util.module_from_spec(spec);spec.loader.exec_module(entry);r=entry.renderer
    content=json.loads((root/'content.json').read_text(encoding='utf-8'));cards=[];cues=[];media={};duration={}
    for lang in ['zh','en']:
        pack=json.loads((root/f'cards.{lang}.json').read_text(encoding='utf-8'))
        m=json.loads((root/f'manifest.{lang}.json').read_text(encoding='utf-8'))
        assert len(pack['pages'])==len(content['themes'])+1==len(m['themes'])+1
        total,timeline=timeline_for(m,30);duration[lang]=total
        continuous=m.get('media_layout')=='continuous-bookends'
        assert m['transition_mode']==('page-turn' if continuous else 'cut')
        assert m['theme_gap_seconds']==(.5 if continuous else 0)
        assert sum(k=='gap' for s,e,k,i in timeline)==(len(m['themes'])-1 if continuous else 0)
        if continuous:
            with wave.open(str(root/m['transition_sound']),'rb') as sound:
                assert sound.getframerate()==48000 and sound.getnchannels()==2
                assert abs(sound.getnframes()/48000-.32)<.001
        starts={i:s for s,e,k,i in timeline if k=='theme'};ends={i:e for s,e,k,i in timeline if k=='theme'}
        for i,p in enumerate(pack['pages']):
            path=root/f'cards/{lang}/card-{i+1:02d}.png'
            with Image.open(path) as image:assert image.size==(1920,1080);image.load()
            if i:assert 4<=len(p['cards'])<=6 and all(c['topicId']==p['topicId'] for c in p['cards'])
            cards.append({'path':str(path.relative_to(root)),'sha256':sha(path)})
        used_ranges={}
        assert m['host_line']==content['versions'][lang]['hostLine']
        assert m['closing_line']==content['versions'][lang]['closingLine']
        extra_captions=m['opening_captions']+m['closing_captions']
        for i,t in enumerate(m['themes']):
            authored=content['themes'][i]['versions'][lang]
            sentences=t.get('narration_captions',t['captions'])
            assert [c['text'] for c in sentences]==authored['sentences']
            assert ''.join(c['text'] for c in t['captions'])==''.join(authored['sentences'])
            path=root/t['narration'];info=json.loads(path.with_suffix('.timeline.json').read_text(encoding='utf-8'))
            assert sha(path)==info['sha256']
            with wave.open(str(path),'rb') as sound:
                assert sound.getparams()[:3]==(1,2,32000)
                assert sound.getnframes()==info['samples']
            offset=float(t.get('narration_offset_seconds',5))
            assert t['card_seconds']==(2.5 if continuous else 5) and offset==0
            if continuous:assert t['closing_card_seconds']==2.5
            assert starts[i]+offset+info['samples']/32000/1.3<=ends[i]+.001
            assert info['providerTimingUnit']=='milliseconds' and info['words']
            for c in t['captions']+(extra_captions if i==0 else []):
                image=Image.new('RGBA',(1920,1080),'black');draw=ImageDraw.Draw(image)
                font,plate,lines=caption_geometry(r,draw,c['text'],1920,1080,1)
                assert ''.join(a[0] for a in lines)==display_text(c['text']) and len(lines)==1 and font.size==40
                assert plate[1]>=884 and plate[3]<=1008
                assert plate[3]-plate[1]<=60
                cues.append({'lang':lang,'theme':i+1,'lines':len(lines),'font':font.size,'plate':plate})
            for source in info['sources']:
                assert sha(root/source['source'])==source['audioSha256']
            assert t['media_sequence'],'No distinct media supplied'
            if m.get('media_binding_policy')=='sentence-v1':validate_bindings(t['media_sequence'],sentences,t['duration_seconds'])
            validate_sequence(t['media_sequence'],used_ranges,(2.5,ends[i]-starts[i]-2.5) if continuous else None)
            for edit in t['media_sequence']:
                assert edit['end_seconds']<=t['duration_seconds']-.10
                asset=root/edit['path']
                if asset.name not in media:
                    if edit['kind']=='image':
                        with Image.open(asset) as im:im.load();details={'dimensions':list(im.size)}
                    else:
                        r.run(['ffmpeg','-v','error','-xerror','-i',str(asset),'-f','null','-'])
                        details=json.loads(r.run(['ffprobe','-v','error','-show_entries','stream=codec_name,width,height:format=duration','-of','json',str(asset)]).stdout)
                    media[asset.name]={'file':str(asset.relative_to(root)),'sha256':sha(asset),'bytes':asset.stat().st_size,'probe':details}
                if edit['kind']=='video':assert edit['source_out']<=float(media[asset.name]['probe']['format']['duration'])+.025
        for kind in ['opening','closing']:
            path=root/m[f'{kind}_narration'];info=json.loads(path.with_suffix('.timeline.json').read_text(encoding='utf-8'))
            assert sha(path)==info['sha256']
            assert ''.join(c['text'] for c in m[f'{kind}_captions'])==m['host_line' if kind=='opening' else 'closing_line']
    assert [t['name'] for t in json.loads((root/'manifest.zh.json').read_text(encoding='utf-8'))['music_tracks']]==[t['name'] for t in json.loads((root/'manifest.en.json').read_text(encoding='utf-8'))['music_tracks']]
    result={'status':'inputs_verified','contentSha256':sha(root/'content.json'),'themes':len(content['themes']),'cardCount':len(cards),'cards':cards,'media':list(media.values()),'captionCueCount':len(cues),'minimumCaptionFont':min(c['font'] for c in cues),'captionGeometry':cues,'videoDurations':duration}
    (root/'verification/inputs.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({k:result[k] for k in ['status','themes','cardCount','captionCueCount','minimumCaptionFont','videoDurations']}))

if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('directory',type=Path);args=ap.parse_args();check(args.directory.resolve())
