"""Finite source clips and explicit popup envelopes; never loop or hold EOF."""
import math
import subprocess
from PIL import Image


def binding_windows(items, captions, theme_duration, fps=30, speed=1.3):
    """Resolve authored sentence anchors against real, unaccelerated narration cues."""
    if not items or not captions:
        raise ValueError('Sentence-bound media requires items and real narration captions')
    stop=math.ceil(theme_duration*fps-1e-8)-round(2.5*fps)
    head=round(2.5*fps);groups=[];previous=None
    for item in items:
        binding=item.get('binding',{})
        index=binding.get('sentence')
        if type(index) is not int or not 0<=index<len(captions):
            raise ValueError('Media binding sentence index is missing or out of range')
        cue=captions[index]
        if binding.get('text')!=cue['text']:
            raise ValueError('Media binding text changed; rebind the edited narration')
        offset=float(binding.get('offsetSeconds',0))
        # Offsets are in final playback seconds, bounded by the actual sentence.
        if not math.isfinite(offset) or offset<0 or offset>=(cue['end']-cue['start'])/speed:
            raise ValueError('Media binding offset is outside the spoken sentence')
        key=(index,offset)
        if key==previous:
            groups[-1]['items'].append(item);continue
        if previous is not None and key<=previous:
            raise ValueError('Media bindings must progress through narration')
        anchor=round((cue['start']/speed+offset)*fps)
        if not groups:
            if anchor>head:raise ValueError('First binding leaves the media window uncovered')
            anchor=head
        elif anchor<=groups[-1]['start']:
            raise ValueError('Media binding collides with the opening card or previous anchor')
        if anchor>=stop:raise ValueError('Media binding is inside the closing card')
        groups.append({'start':anchor,'items':[item],'binding':dict(binding)})
        previous=key
    for i,g in enumerate(groups):g['end']=groups[i+1]['start'] if i+1<len(groups) else stop
    return groups


def schedule_bound_media(items, captions, theme_duration, fps=30):
    result=[]
    for item in items:
        seconds=float(item.get('seconds',float(item.get('source_out',0))-float(item.get('source_in',0))))
        if not math.isfinite(seconds) or seconds<=0:raise ValueError('Media length must be positive and finite')
        if item['kind']=='video' and (float(item['source_in'])<0 or seconds>float(item['source_out'])-float(item['source_in'])+1e-6):
            raise ValueError('Media duration exceeds its authored source interval')
    for group in binding_windows(items,captions,theme_duration,fps):
        duration=(group['end']-group['start'])/fps
        try:
            rows=schedule_media(group['items'],duration,fps,head_seconds=0,tail_seconds=0)
        except ValueError as error:
            raise ValueError(f"Sentence {group['binding']['sentence']}: {error}") from error
        for row in rows:
            row['start_seconds']+=group['start']/fps
            row['end_seconds']+=group['start']/fps
            row['binding_window']={'startFrame':group['start'],'endFrame':group['end']}
        result.extend(rows)
    validate_sequence(result,media_window=(2.5,(math.ceil(theme_duration*fps-1e-8)-round(2.5*fps))/fps))
    return result


def validate_bindings(sequence,captions,theme_duration,fps=30):
    for group in binding_windows(sequence,captions,theme_duration,fps):
        rows=group['items']
        if abs(rows[0]['start_seconds']*fps-group['start'])>1e-5 or abs(rows[-1]['end_seconds']*fps-group['end'])>1e-5:
            raise ValueError('Media edit no longer matches its spoken anchor')
        for row in rows:
            if row.get('binding_window')!={'startFrame':group['start'],'endFrame':group['end']}:
                raise ValueError('Media binding window is stale')
            if row['start_seconds']*fps<group['start']-1e-5 or row['end_seconds']*fps>group['end']+1e-5:
                raise ValueError('Media edit crosses its narration binding window')


def popup_envelope(elapsed, duration, continuous=False, last=False):
    if elapsed < 0 or elapsed >= duration:
        return 0., .78
    entering=min(1.,elapsed/.30)
    leaving=min(1.,(duration-elapsed)/.18)
    opacity=1. if continuous else min(1.,entering/.70,leaving)
    # A visible pop from 78%, slight overshoot, then settle at original size.
    c=1.70158
    ease=1+(c+1)*(entering-1)**3+c*(entering-1)**2
    scale=(.78+.22*ease)*(1-.025*(1-leaving))
    return opacity, scale


def schedule_media(items, theme_duration, fps=30, head_seconds=2.5, tail_seconds=2.5):
    if not items:
        return []
    first=round(head_seconds*fps)
    stop=math.ceil(theme_duration*fps-1e-8)-round(tail_seconds*fps)
    needed=stop-first
    if needed<=0:raise ValueError('Chapter is too short for its card bookends')
    result=[];lengths=[]
    for item in items:
        seconds=float(item.get('seconds',float(item.get('source_out',0))-float(item.get('source_in',0))))
        if item['kind']=='image' and not item.get('complex'):seconds=min(seconds,3)
        lengths.append(math.floor(seconds*fps+1e-8))
    if sum(lengths)<needed:
        raise ValueError(f'Need {(needed-sum(lengths))/fps:.2f}s more related media; refusing to insert a card in the media window')
    cursor=first
    for item,frames in zip(items,lengths):
        if cursor>=stop:break
        row=dict(item)
        count=min(frames,stop-cursor)
        # Avoid a tiny final flash by sharing its time with the preceding edit.
        # All edits remain finite; this never extends a source interval.
        if count<round(1.2*fps) and result:
            take=round(1.2*fps)-count
            prior=result[-1]
            if prior['frame_count']-take<round(1.2*fps):raise ValueError('Final media edit is too short; revise its authored source range')
            prior['frame_count']-=take;prior['end_seconds']-=take/fps
            if prior['kind']=='video':prior['source_out']-=take/fps
            cursor-=take;count+=take
        row.update(start_seconds=cursor/fps,end_seconds=(cursor+count)/fps,frame_count=count)
        if row['kind']=='video':row['source_out']=float(row.get('source_in',0))+count/fps
        result.append(row)
        cursor+=count
    return result


def validate_sequence(sequence, source_ranges=None, media_window=None):
    ranges={} if source_ranges is None else source_ranges
    previous=media_window[0] if media_window else 0
    for item in sequence:
        start,end=float(item['start_seconds']),float(item['end_seconds'])
        if start<previous-1e-6 or end<=start:
            raise ValueError('Overlapping or empty media edit')
        if media_window and abs(start-previous)>1e-6:raise ValueError('Uncovered middle interval would return to a card')
        previous=end
        if item['kind']=='image':
            if end-start>3.00001 and not (item.get('complex') and item.get('reason')):
                raise ValueError('An ordinary image exceeds three seconds')
        elif item['kind']=='video':
            a,b=float(item['source_in']),float(item['source_out'])
            if a<0 or abs((b-a)-(end-start))>1e-5:
                raise ValueError('Video source range must equal its one-pass display time')
            for lo,hi in ranges.get(item['path'],[]):
                if min(b,hi)-max(a,lo)>1e-5:
                    raise ValueError('Repeated video source range: '+item['path'])
            ranges.setdefault(item['path'],[]).append((a,b))
        else:raise ValueError('Unknown media type')
    if media_window and (not sequence or abs(previous-media_window[1])>1e-6):
        raise ValueError('Media must cover the complete middle window')
    return ranges


class ClipReader:
    def __init__(self,path,item,w,h,fps):
        # Probe the real dimensions once; preserve aspect ratio with no padding.
        import json
        info=json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','json',str(path)]))['streams'][0]
        ratio=min(w/info['width'],h/info['height'])
        self.w,self.h=max(2,round(info['width']*ratio)),max(2,round(info['height']*ratio))
        self.size=self.w*self.h*3
        self.remaining=int(item['frame_count'])
        # The target frame count is the sole output limit. Combining -t with
        # fps resampling can drop the final frame of a 25 -> 30 fps cut (a
        # 6.5s slice produced 194 frames instead of 195). The finite -frames:v
        # cap still stops this clip once; source EOF remains a hard error.
        self.p=subprocess.Popen(['ffmpeg','-v','error','-ss',str(item['source_in']),'-i',str(path),
             '-an','-vf',f'fps={fps},scale={self.w}:{self.h},setsar=1',
             '-frames:v',str(self.remaining),'-f','rawvideo','-pix_fmt','rgb24','pipe:1'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)

    def next(self):
        if self.remaining<=0:
            raise RuntimeError('Attempted to replay a finished video clip')
        data=self.p.stdout.read(self.size)
        if len(data)!=self.size:
            raise RuntimeError('Source clip reached EOF; refusing to loop or freeze its final frame')
        self.remaining-=1
        return Image.frombytes('RGB',(self.w,self.h),data)

    def close(self):
        if self.p.poll() is None:self.p.terminate()
        try:self.p.wait(timeout=2)
        except subprocess.TimeoutExpired:self.p.kill();self.p.wait()
        self.p.stdout.close();self.p.stderr.close()
