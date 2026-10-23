"""Match actual encoded speech to independently decoded source waveforms."""
from pathlib import Path
import argparse, hashlib, json, os, shutil, subprocess, wave
import numpy as np
from juya_production import timeline_for

def decode(path,tempo=False):
    args=['ffmpeg','-v','error','-i',str(path)]
    if tempo:args+=['-af','atempo=1.3']
    args+=['-f','f32le','-ar','8000','-ac','1','pipe:1']
    return np.frombuffer(subprocess.check_output(args),dtype='<f4').astype(np.float64)

def correlate(y,x):
    x=x-x.mean();n=1<<(len(y)+len(x)-1).bit_length()
    raw=np.fft.irfft(np.fft.rfft(y,n)*np.fft.rfft(x[::-1],n),n)[len(x)-1:len(y)]
    sums=np.concatenate(([0.],np.cumsum(y*y)))
    power=sums[len(x):]-sums[:-len(x)]
    return raw[:len(power)]/np.sqrt(np.maximum(power*np.sum(x*x),1e-16))

def video_language(video):
    receipt=video.with_suffix('.manifest.json')
    lang=json.loads(receipt.read_text(encoding='utf-8')).get('language') if receipt.exists() else video.stem.rsplit('-',1)[-1]
    if lang not in ('zh','en'):raise ValueError('Video language requires a zh/en render receipt or legacy filename suffix')
    return lang

def verify(video):
    root=video.parent;lang=video_language(video)
    manifest=json.loads((root/f'manifest.{lang}.json').read_text(encoding='utf-8'))
    _,timeline=timeline_for(manifest,30)
    entries=[('opening',manifest['opening_narration'],float(manifest.get('opening_audio_offset',0)),manifest.get('opening_narration_captions',manifest.get('opening_captions',[])))]
    for start,end,kind,i in timeline:
        if kind=='closing':
            entries.append(('closing',manifest['closing_narration'],start+float(manifest.get('closing_audio_offset',.25)),manifest['closing_narration_captions']))
            continue
        if kind!='theme':continue
        t=manifest['themes'][i]
        entries.append((t['title'],t['narration'],start+float(t.get('narration_offset_seconds',t.get('card_seconds',5))),t.get('narration_captions',t['captions'])))
    y=decode(video);found=[];previous=0;spoken=[]
    for title,path,expected,cues in entries:
        stem=decode(root/path,True);offset=min(4800,round(len(stem)*.15));window=min(16000,len(stem)-offset)
        assert window>2000
        scores=correlate(y,stem[offset:offset+window]);peak=int(np.argmax(scores));actual=peak/8000-offset/8000
        error=actual-expected
        assert abs(error)<=.065,(title,'speech at wrong video time',expected,actual,float(scores[peak]))
        assert scores[peak]>.50,(title,'weak waveform match',float(scores[peak]))
        assert expected>=previous-.02,(title,'overlapping narration schedule')
        previous=expected+len(stem)/8000
        hop=80;n=len(stem)//hop
        rms=np.sqrt(np.mean(stem[:n*hop].reshape(n,hop)**2,axis=1))
        active=np.flatnonzero(rms>max(.0008,float(rms.max())*.012))
        with wave.open(str(root/path),'rb') as original:
            nominal=original.getnframes()/original.getframerate()/1.3
        spoken.append({'title':title,'firstSpeech':actual+active[0]*.01,
                       'lastSpeech':actual+(active[-1]+1)*.01,'scheduledStart':expected,'scheduledEnd':previous,
                       'tempoLengthDifferenceSeconds':max(0,nominal-len(stem)/8000)})
        # Check the MIDDLE of every actual sentence, not just its first word.
        cue_matches=[]
        for cue in cues:
            cue_duration=(float(cue['end'])-float(cue['start']))/1.3
            relative=(float(cue['start'])/1.3)+min(.35,cue_duration*.15)
            source_start=round(relative*8000)
            length=min(8000,round((float(cue['end'])/1.3-relative)*8000)-500)
            assert length>=2000
            reference=stem[source_start:source_start+length]
            predicted=round((expected+relative)*8000);radius=640
            lo=max(0,predicted-radius);hi=min(len(y),predicted+length+radius)
            local=correlate(y[lo:hi],reference)
            best=int(np.argmax(local));delta=(lo+best-predicted)/8000
            assert abs(delta)<.065 and local[best]>.45,(title,cue['text'],'sentence sync',delta,float(local[best]))
            cue_matches.append({'sourceStart':cue['start'],'videoStart':expected+cue['start']/1.3,'matchedOffsetMs':round(delta*1000,3),'correlation':round(float(local[best]),4)})
        found.append({'title':title,'source':path,'expectedStartSeconds':expected,'measuredStartSeconds':actual,'errorMilliseconds':round(error*1000,3),'globalMatchCorrelation':round(float(scores[peak]),4),'sentences':cue_matches})
    joins=[{'from':a['title'],'to':b['title'],'measuredSpeechGapSeconds':b['firstSpeech']-a['lastSpeech'],
            'scheduledPaddingSeconds':b['scheduledStart']-a['scheduledEnd'],
            'tempoLengthDifferenceSeconds':a['tempoLengthDifferenceSeconds'],
            'frameQuantizationSeconds':b['scheduledStart']-a['scheduledEnd']-a['tempoLengthDifferenceSeconds']} for a,b in zip(spoken,spoken[1:])]
    for join in joins:
        join['authoredTransitionSeconds']=.5 if manifest.get('transition_mode')=='page-turn' and join['from']!='opening' and join['to']!='closing' else 0
    if manifest.get('transition_mode') in ('cut','page-turn'):
        for join in joins:
            # atempo uses analysis windows, so its decoded duration can be
            # slightly shorter than source_duration/1.3 (24.6 ms in this real
            # Gecko stem). Separate that measured difference from frame
            # quantization instead of calling the whole 40 ms an added hold.
            planned=join['authoredTransitionSeconds']
            assert -.03<=join['frameQuantizationSeconds']-planned<=1/30+.003,join
            assert -.03<=join['measuredSpeechGapSeconds']-planned<=.24,join
    effects=[]
    if manifest.get('transition_sound'):
        ref=decode(root/manifest['transition_sound'])
        # Paper rustle is broadband, while the continuous music has strong
        # low-frequency energy. First differences suppress that unrelated
        # bass without changing the reference sound's position. Keep the
        # same timing/correlation requirements and retain the raw score.
        edge_y=np.diff(y);edge_ref=np.diff(ref)
        for start,end,kind,_ in timeline:
            if kind!='gap':continue
            expected=(start+end)/2-len(ref)/8000/2
            lo=max(0,round(expected*8000)-400);hi=min(len(y),round(expected*8000)+len(ref)+400)
            scores=correlate(edge_y[lo:hi-1],edge_ref);at=int(np.argmax(scores));actual=(lo+at)/8000
            assert abs(actual-expected)<.04 and scores[at]>.45,('page turn sound missing or misplaced',expected,actual,float(scores[at]))
            raw=correlate(y[lo:hi],ref)
            effects.append({'expectedStart':expected,'measuredStart':actual,'correlation':float(scores[at]),'rawCorrelationAtMatch':float(raw[at]),'matchingMethod':'first-difference waveform correlation to suppress music bass','gapSeconds':end-start})
    result={'status':'encoded_audio_timing_passed','videoSha256':hashlib.sha256(video.read_bytes()).hexdigest(),'method':'global waveform matching plus every-sentence local correlation on encoded AAC; source speech activity anchored by measured global matches','sampleRateForAnalysis':8000,'maximumStartErrorMs':max(abs(v['errorMilliseconds']) for v in found),'groups':found,'sentenceCount':sum(len(x['sentences']) for x in found),'voiceJoins':joins,'maximumMeasuredJoinGapSeconds':max(j['measuredSpeechGapSeconds'] for j in joins)}
    result['pageTurnSounds']=effects
    target=root/f'verification/audio.{lang}.json';target.parent.mkdir(exist_ok=True);target.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({k:result[k] for k in ['status','maximumStartErrorMs','sentenceCount']}))
    return result

if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('video',type=Path);args=ap.parse_args()
    if os.name=='nt' and not shutil.which('ffmpeg'):
        paths=sorted((Path(os.environ['LOCALAPPDATA'])/'Microsoft/WinGet/Packages').glob('Gyan.FFmpeg_*/ffmpeg-*/bin'))
        os.environ['PATH']=str(paths[-1])+os.pathsep+os.environ['PATH']
    verify(args.video.resolve())
