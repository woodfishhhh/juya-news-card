"""Independently inspect every encoded frame for card/media/gap coverage."""
from pathlib import Path
import json,subprocess
import numpy as np
from PIL import Image

def verify_coverage(video,root,manifest,timeline,paper):
    fps=30;w,h=95,51;size=w*h*3
    refs=[]
    for t in manifest['themes']:
        with Image.open(root/t['card_image']) as im:
            a=np.asarray(im.convert('RGB').crop((200,67,1720,883))).astype(np.float32)
            refs.append(a.reshape(h,16,w,16,3).mean(axis=(1,3)))
    phases=[(round(a*fps),round(b*fps),kind,i) for a,b,kind,i in timeline]
    proof=[{'theme':i+1,'headCardFrames':0,'mediaFrames':0,'tailCardFrames':0,
            'maximumCardError':0.,'minimumMediaDifferenceFromCard':999.,
            'minimumMediaDifferenceFromDimmedCard':999.} for i in range(len(refs))]
    gaps=[];frame=0;cursor=0
    p=subprocess.Popen(['ffmpeg','-v','error','-i',str(video),'-an','-vf',
        'crop=1520:816:200:67,scale=95:51:flags=area','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    try:
        while True:
            raw=p.stdout.read(size)
            if not raw:break
            if len(raw)!=size:raise AssertionError('Incomplete coverage probe frame')
            a=np.frombuffer(raw,dtype=np.uint8).reshape(h,w,3).astype(np.float32)
            while cursor<len(phases) and frame>=phases[cursor][1]:cursor+=1
            if cursor<len(phases):
                start,end,kind,i=phases[cursor]
                if start<=frame<end and kind=='theme':
                    rel=frame-start;row=proof[i];error=float(np.abs(a-refs[i]).mean())
                    if rel<75 or frame>=end-75:
                        assert error<4.5,('Media intruded into 2.5 second card bookend',i,frame,error)
                        key='headCardFrames' if rel<75 else 'tailCardFrames';row[key]+=1
                        row['maximumCardError']=max(row['maximumCardError'],error)
                    else:
                        dim_error=float(np.abs(a-refs[i]*.82).mean())
                        assert error>6 and dim_error>3,('Empty card or dimmed card in continuous media window',i,frame,error,dim_error)
                        row['mediaFrames']+=1
                        row['minimumMediaDifferenceFromCard']=min(row['minimumMediaDifferenceFromCard'],error)
                        row['minimumMediaDifferenceFromDimmedCard']=min(row['minimumMediaDifferenceFromDimmedCard'],dim_error)
                elif start<=frame<end and kind=='gap':
                    error=float(np.abs(a-np.asarray(paper)).mean())
                    assert error<3,('Transition interval has unexpected content',frame,error)
                    if not gaps or gaps[-1]['endFrame']!=frame:gaps.append({'startFrame':frame,'endFrame':frame,'frames':0})
                    gaps[-1]['frames']+=1;gaps[-1]['endFrame']=frame+1
            frame+=1
        error=p.stderr.read().decode(errors='replace');assert p.wait()==0,error
    finally:
        if p.poll() is None:p.kill();p.wait()
        p.stdout.close();p.stderr.close()
    assert frame==round(timeline[-1][1]*fps),(frame,timeline[-1][1])
    for row in proof:assert row['headCardFrames']==row['tailCardFrames']==75,row
    assert len(gaps)==len(refs)-1 and all(g['frames']==15 for g in gaps),gaps
    result={'status':'every_encoded_frame_coverage_passed','method':'Every decoded frame, original-card and 18-percent-dimmed-card pixel comparisons; excludes subtitle/navigation bands',
            'checkedFrames':frame,'themes':proof,'gaps':gaps,'headCardSeconds':2.5,'tailCardSeconds':2.5,'transitionSeconds':.5,'unplannedCardFramesInMedia':0}
    (root/f'verification/coverage.{manifest["language"]}.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    return result
