"""Local production fixes. The vendored upstream snapshot stays byte-identical."""
from pathlib import Path
import json, math, os, subprocess, tempfile, wave
import numpy as np
from PIL import Image, ImageDraw, ImageOps, ImageFont
from juya_media import ClipReader, popup_envelope, validate_sequence
from juya_captions import display_text

RATE = 48000
REVISION = '2026-10-21-r5'


def make_page_turn(path):
    """Deterministic short paper rustle, rather than the upstream sine beep."""
    rate=RATE;n=round(.32*rate);t=np.arange(n)/rate
    noise=np.random.default_rng(20261021).normal(size=n)
    soft=np.convolve(noise,np.ones(8)/8,mode='same')
    band=soft-np.convolve(soft,np.ones(128)/128,mode='same')
    envelope=np.exp(-((t-.095)/.047)**2)+.65*np.exp(-((t-.205)/.055)**2)
    mono=band*envelope+.035*np.sin(2*np.pi*175*t)*np.exp(-((t-.055)/.025)**2)
    mono*=.18/max(float(np.abs(mono).max()),1e-9)
    stereo=np.stack([mono,np.concatenate((np.zeros(80),mono[:-80]))*.98],axis=1)
    with wave.open(str(path),'wb') as writer:
        writer.setparams((2,2,rate,0,'NONE',''));writer.writeframes((stereo*32767).astype('<i2').tobytes())


def timeline_for(manifest, fps=30):
    cursor = math.ceil(float(manifest.get('opening_seconds', 5))*fps-1e-8)
    result = []
    for i, theme in enumerate(manifest['themes']):
        frames = math.ceil(float(theme['duration_seconds'])*fps-1e-8)
        result.append((cursor/fps, (cursor+frames)/fps, 'theme', i))
        theme['_timeline_start'], theme['_timeline_end'] = cursor/fps, (cursor+frames)/fps
        cursor += frames
        if i < len(manifest['themes'])-1:
            gap = round(float(manifest.get('theme_gap_seconds', .5))*fps)
            if gap:result.append((cursor/fps, (cursor+gap)/fps, 'gap', i))
            cursor += gap
    if manifest.get('closing_narration'):
        frames=math.ceil(float(manifest['closing_seconds'])*fps-1e-8)
        result.append((cursor/fps,(cursor+frames)/fps,'closing',None))
        cursor+=frames
    return cursor/fps, result


def caption_geometry(r, draw, text, w, h, scale):
    text=display_text(text)
    if '\n' in text:raise r.RenderError('Captions must be a single short phrase')
    font=r._font(max(12,round(40*scale)))
    if not any('\u3400'<=c<='\u9fff' for c in text) and os.name=='nt':
        font=ImageFont.truetype(str(Path(os.environ.get('WINDIR','C:/Windows'))/'Fonts/arial.ttf'),max(12,round(40*scale)))
    if draw.textlength(text,font=font)>round(w*.82):
        raise r.RenderError('Caption is too long for one line; split its semantic phrase: '+text)
    lines=[text]
    boxes = [draw.textbbox((0, 0), line or ' ', font=font) for line in lines]
    gap, pad = 0, max(4,round(7*scale))
    heights = [b[3]-b[1] for b in boxes]
    widths = [b[2]-b[0] for b in boxes]
    bottom = round(1000*scale)
    y = bottom-sum(heights)-gap*(len(lines)-1)-2*pad
    plate = (round((w-max(widths))/2)-pad, y, round((w+max(widths))/2)+pad, bottom)
    placements=[]; cursor=y+pad
    for line, b, height, width in zip(lines, boxes, heights, widths):
        x=round((w-width)/2)
        placements.append((line,(x-b[0],cursor-b[1]),(x,cursor,x+width,cursor+height)))
        cursor+=height+gap
    return font, plate, placements


def caption(r, draw, text, w, h, scale, opacity=1):
    if not text: return
    font, plate, placements=caption_geometry(r,draw,text,w,h,scale)
    # Draw one backing plate FIRST; a second line can never erase earlier ink.
    draw.rounded_rectangle(plate, radius=max(2,round(5*scale)), fill=(62,62,62,round(185*opacity)))
    for line,xy,_ in placements:
        draw.text(xy,line,font=font,fill=(255,255,255,round(255*opacity)))


def _draw_navigation(r, frame, manifest, index, now, w, h, scale):
    draw=ImageDraw.Draw(frame); themes=manifest['themes']
    start=themes[0]['_timeline_start']; end=themes[-1]['_timeline_end']; span=end-start
    active=themes[index]; top=round(54*scale); bottom=h-round(48*scale)
    def xpos(time):return round(w*(time-start)/span)
    groups=[]
    for i,t in enumerate(themes):
        section=t.get('section_id','default')
        stop=themes[i+1]['_timeline_start'] if i+1<len(themes) else end
        if groups and groups[-1][0]==section:groups[-1][2]=stop
        else:groups.append([section,t['_timeline_start'],stop])
    if len({g[0] for g in groups})!=len(groups):
        raise r.RenderError('Sections must be contiguous; order stories within sections')
    titles={s['id']:s['title'] for s in manifest.get('sections',[])}
    for y0,y1,slots,size in [(0,top,[(g[0],g[1],g[2],titles.get(g[0],g[0]),g[0]==active.get('section_id')) for g in groups],27),
                            (bottom,h,[(i,t['_timeline_start'],themes[i+1]['_timeline_start'] if i+1<len(themes) else end,t.get('event_title',t['title']),i==index) for i,t in enumerate(themes)],23)]:
        draw.rectangle((0,y0,w,y1),fill=(*r.PAPER,255))
        for key,a,b,label,selected in slots:
            x0,x1=xpos(a),xpos(b)
            if selected:draw.rectangle((x0,y0,x1-1,y1-1),fill=(245,227,220,255))
            font=r._font(max(9,round(size*scale)))
            while draw.textlength(label,font=font)>x1-x0-10*scale and font.size>max(9,round(12*scale)):
                font=r._font(font.size-1)
            if draw.textlength(label,font=font)>x1-x0-6*scale:raise r.RenderError('Navigation label too long: '+label)
            box=draw.textbbox((0,0),label,font=font)
            draw.text(((x0+x1-(box[2]-box[0]))/2-box[0],(y0+y1-(box[3]-box[1]))/2-box[1]),label,font=font,fill=(*r.CORAL,255) if selected else (100,94,87,255))
            draw.line((x1-1,y0,x1-1,y1),fill=(218,215,208,255),width=max(1,round(scale)))
        # The same global x coordinate advances continuously on both bars.
        pos=xpos(max(start,min(now,end)))
        draw.rectangle((0,y1-max(2,round(3*scale)),pos,y1),fill=(*r.CORAL,255))


_nav_cache={}
_caption_cache={}
_dim_cache={}
def navigation(r,frame,manifest,index,now,w,h,scale):
    key=(id(manifest),index,w,h)
    if key not in _nav_cache:
        layer=Image.new('RGBA',(w,h),(0,0,0,0))
        _draw_navigation(r,layer,manifest,index,manifest['themes'][0]['_timeline_start'],w,h,scale)
        top=round(54*scale);bottom=h-round(48*scale)
        _nav_cache[key]=(manifest,layer.crop((0,0,w,top)),layer.crop((0,bottom,w,h)))
    _,top_image,bottom_image=_nav_cache[key]
    frame.alpha_composite(top_image,(0,0));frame.alpha_composite(bottom_image,(0,h-bottom_image.height))
    start=manifest['themes'][0]['_timeline_start'];end=manifest['themes'][-1]['_timeline_end']
    pos=round(w*(max(start,min(now,end))-start)/(end-start));draw=ImageDraw.Draw(frame)
    for y in [round(54*scale),h]:draw.rectangle((0,y-max(2,round(3*scale)),pos,y),fill=(*r.CORAL,255))


def compose(r, base, manifest, index, popup, text, w,h,scale,alpha,frame_idx,total_frames,show_nav=True,popup_opacity=1.,popup_scale=1.):
    frame=base.convert('RGBA')
    if popup is not None:
        key=id(base)
        if key not in _dim_cache:
            _dim_cache[key]=(base,Image.blend(frame,Image.new('RGBA',frame.size,(0,0,0,255)),.18))
        frame=_dim_cache[key][1].copy() if popup_opacity>=.999 else Image.blend(frame,_dim_cache[key][1],popup_opacity)
        px,py,pw,ph=[round(v*scale) for v in (200,64,1520,830)]
        fitted=ImageOps.contain(popup.convert('RGB'),(round(pw*popup_scale),round(ph*popup_scale)))
        x=px+(pw-fitted.width)//2; y=py+(ph-fitted.height)//2
        if popup_opacity>=.999:frame.paste(fitted,(x,y))
        else:frame.paste(fitted,(x,y),Image.new('L',fitted.size,round(255*popup_opacity)))
    if index is not None and show_nav:
        navigation(r,frame,manifest,index,frame_idx/manifest['fps'],w,h,scale)
    if text:
        key=(text,w,h,scale)
        if key not in _caption_cache:
            layer=Image.new('RGBA',(w,h),(0,0,0,0));caption(r,ImageDraw.Draw(layer),text,w,h,scale)
            box=layer.getbbox();_caption_cache[key]=(box,layer.crop(box))
        box,layer=_caption_cache[key];frame.alpha_composite(layer,(box[0],box[1]))
    frame=frame.convert('RGB')
    if alpha<.999:frame=Image.blend(Image.new('RGB',(w,h),'white'),frame,max(0,alpha))
    return frame


def build_video(r, manifest, root, target, w,h,fps,limit_seconds=None):
    manifest['fps']=fps; total,timeline=timeline_for(manifest,fps)
    if limit_seconds is not None:total=min(total,float(limit_seconds))
    frames=round(total*fps);scale=w/1920
    out=subprocess.Popen(['ffmpeg','-y','-hide_banner','-loglevel','error','-f','rawvideo','-pixel_format','rgb24','-video_size',f'{w}x{h}','-framerate',str(fps),'-i','pipe:0','-an','-c:v','libx264','-preset','ultrafast','-crf','23','-pix_fmt','yuv420p','-r',str(fps),'-movflags','+faststart',str(target)],stdin=subprocess.PIPE,stderr=subprocess.PIPE)
    cards=[r.make_card(t,root,w,h,i) for i,t in enumerate(manifest['themes'])]
    opening=r.draw_opening(manifest,w,h,scale,1,root);readers={};phase=None;stills={}
    closing=Image.new('RGB',(w,h),r.PAPER);d=ImageDraw.Draw(closing)
    for label,size,y in [(('感谢收看' if manifest['language']=='zh' else 'Thanks for watching'),86,420),
                         (('早点休息' if manifest['language']=='zh' else 'Get some rest'),42,555)]:
        font=r._font(round(size*scale));box=d.textbbox((0,0),label,font=font)
        d.text(((w-(box[2]-box[0]))/2-box[0],round(y*scale)-box[1]),label,font=font,fill=r.CORAL if size==86 else (93,88,82))
    used_ranges={}
    for idx,t in enumerate(manifest['themes']):
        if not t.get('media_sequence'):raise r.RenderError('Each theme requires an explicit, finite media_sequence')
        window=(2.5,t['_timeline_end']-t['_timeline_start']-2.5) if t.get('media_layout')=='continuous-bookends' else None
        validate_sequence(t.get('media_sequence',[]),used_ranges,window)
        for mi,item in enumerate(t.get('media_sequence',[])):
            if item['kind']=='image':
                with Image.open(r.local_path(root,item['path'],'media',True)) as image:
                    stills[idx,mi]=ImageOps.contain(image.convert('RGB'),(round(1520*scale),round(830*scale)))
    try:
        for fi in range(frames):
            now=fi/fps; selected=next((x for x in timeline if x[0]<=now<x[1]),None)
            idx=None;popup=None;text='';alpha=1.;nav=False;pop_alpha=1.;pop_scale=1.;media_index=None
            if now<float(manifest.get('opening_seconds',5)):
                base=opening
                text=r.caption_for({'captions':manifest.get('opening_captions',[])},now-float(manifest.get('opening_audio_offset',0)),1.3)
            elif selected and selected[2]=='theme':
                start,end,_,idx=selected;t=manifest['themes'][idx];local=(fi-round(start*fps))/fps;base=cards[idx];nav=True
                alpha=1. if manifest.get('transition_mode') in ('cut','page-turn') else min(1,local/.25,(end-now)/.25)
                offset=float(t.get('narration_offset_seconds',t.get('card_seconds',5)))
                text=r.caption_for(t,local-offset,1.3) if local>=offset else ''
                for mi,item in enumerate(t.get('media_sequence',[])):
                    if item['start_seconds']<=local<item['end_seconds']:
                        media_index=mi;key=(idx,mi)
                        if item['kind']=='video':
                            if key not in readers:readers[key]=ClipReader(r.local_path(root,item['path'],'media',True),item,round(1520*scale),round(830*scale),fps)
                            popup=readers[key].next()
                        else:popup=stills[key]
                        pop_alpha,pop_scale=popup_envelope(local-item['start_seconds'],item['end_seconds']-item['start_seconds'],
                            continuous=t.get('media_layout')=='continuous-bookends',last=mi==len(t['media_sequence'])-1)
                        break
                # Dispose finished decoders rather than leaving blocked pipes.
                for key in list(readers):
                    if key!=(idx,media_index):readers.pop(key).close()
            elif selected and selected[2]=='closing':
                start,end,_,_=selected;local=now-start;base=closing
                text=r.caption_for({'captions':manifest.get('closing_captions',[])},local-float(manifest.get('closing_audio_offset',.25)),1.3)
                alpha=1. if manifest.get('transition_mode') in ('cut','page-turn') else min(1,local/.25,(end-now)/.4)
            else:base=Image.new('RGB',(w,h),r.PAPER if manifest.get('transition_mode')=='page-turn' else 'white')
            current=(idx,media_index,selected[2] if selected else 'opening')
            if phase!=current:
                print(json.dumps({'phase':'rendering','language':manifest['language'],'theme':idx,'popup':popup is not None,'frame':fi,'totalFrames':frames}),flush=True);phase=current
                (root/f'verification/render-progress.{manifest["language"]}.json').write_text(json.dumps({'frame':fi,'totalFrames':frames,'videoSeconds':now,'theme':idx,'popup':popup is not None}),encoding='utf-8')
            frame=compose(r,base,manifest,idx,popup,text,w,h,scale,alpha,fi,frames,nav,pop_alpha,pop_scale)
            out.stdin.write(frame.tobytes())
        out.stdin.close();error=out.stderr.read();code=out.wait()
        if code:raise r.RenderError(error.decode(errors='replace')[-2000:])
    finally:
        for reader in readers.values():reader.close()
        if out.poll() is None:out.kill();out.wait()
    return total,timeline


def decode(r,path,speed=False):
    args=['ffmpeg','-v','error','-i',str(path)]
    if speed:args+=['-af','atempo=1.3']
    args+=['-f','f32le','-ar',str(RATE),'-ac','2','pipe:1']
    return np.frombuffer(r.run(args).stdout,dtype='<f4').reshape(-1,2).copy()


def mix_audio(r, manifest, root, video, target, total, timeline, seed, order):
    # Place decoded samples at integer positions. No independent timestamp reset
    # or multi-input delay filters can collapse stems into the opening.
    count=math.ceil(total*manifest['fps'])/manifest['fps'];size=round(count*RATE)
    mixed=np.zeros((size,2),dtype=np.float32);schedule=[];voice_end=0
    def place(data,start,gain=1):
        offset=round(start*RATE)
        if offset<0:raise r.RenderError('Negative audio start')
        n=min(len(data),size-offset)
        if n>0:mixed[offset:offset+n]+=data[:n]*gain
    entries=[]
    if manifest.get('opening_narration'):
        entries.append(('opening',manifest['opening_narration'],float(manifest.get('opening_audio_offset',0)),float(manifest.get('opening_narration_volume',1))))
    starts={i:s for s,e,k,i in timeline if k=='theme'}
    for i,t in enumerate(manifest['themes']):
        if t.get('narration'):
            entries.append((str(i),t['narration'],starts[i]+float(t.get('narration_offset_seconds',t.get('card_seconds',5))),float(t.get('narration_volume',1))))
    for start,end,kind,_ in timeline:
        if kind=='closing':entries.append(('closing',manifest['closing_narration'],start+float(manifest.get('closing_audio_offset',.25)),1.))
    for name,path,start,gain in entries:
        data=decode(r,r.local_path(root,path,'narration',True),True)
        if start<voice_end-.015:raise r.RenderError('Narration overlap: '+name)
        place(data,start,gain);voice_end=start+len(data)/RATE
        schedule.append({'kind':'voice','name':name,'path':path,'startSample':round(start*RATE),'endSample':round(start*RATE)+len(data),'startSeconds':start,'endSeconds':voice_end})
    playback=None
    if order:
        cursor=0;segments=[];music=np.zeros_like(mixed)
        for track in order:
            data=decode(r,r.local_path(root,track['path'],'music',True));n=min(len(data),size-cursor)
            if n<=0:break
            gain=float(track.get('volume',.10));music[cursor:cursor+n]+=data[:n]*gain
            segments.append({'name':track['name'],'path':track['path'],'source_duration_seconds':len(data)/RATE,'scheduled_duration_seconds':n/RATE,'volume':gain})
            cursor+=len(data)
        coverage=min(cursor,size);fade=min(2*RATE,coverage)
        music[coverage-fade:coverage]*=np.linspace(1,0,fade,dtype=np.float32)[:,None]
        mixed+=music
        playback={'policy':'continuous_once_from_video_start','playlist_duration_seconds':cursor/RATE,'playback_duration_seconds':coverage/RATE,'video_duration_seconds':count,'covers_video':cursor>=size,'fade_out_duration_seconds':fade/RATE,'repeat':False,'segments':segments}
        if cursor<size:raise r.RenderError('Saved one-pass music playlist is shorter than the video')
    effects=[]
    with tempfile.TemporaryDirectory(prefix='juya-production-') as td:
        if manifest.get('transition_sound'):tone=r.local_path(root,manifest['transition_sound'],'transition sound',True)
        else:tone=Path(td)/'turn.wav';r.make_sfx(tone)
        sfx=decode(r,tone)
        for start,end,kind,_ in timeline:
            if kind=='gap':
                at=(start+end)/2-len(sfx)/RATE/2
                if at<start or at+len(sfx)/RATE>end:raise r.RenderError('Page turn sound exceeds its half-second interval')
                place(sfx,at,.55);effects.append({'path':str(tone),'startSeconds':at,'durationSeconds':len(sfx)/RATE,'gain':.55})
        peak=float(np.abs(mixed).max());gain=min(1,.94/max(peak,1e-6));mixed*=gain
        wav=Path(td)/'timeline.wav'
        with wave.open(str(wav),'wb') as writer:
            writer.setparams((2,2,RATE,0,'NONE',''));writer.writeframes((np.clip(mixed,-1,1)*32767).astype('<i2').tobytes())
        r.run(['ffmpeg','-y','-v','error','-i',str(video),'-i',str(wav),'-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-ar',str(RATE),'-ac','2','-b:a','192k','-t',f'{count:.8f}','-movflags','+faststart',str(target)])
    proof={'revision':REVISION,'method':'decoded_pcm_integer_sample_placement','sampleRate':RATE,'channels':2,'sampleCount':size,'mixPeakBeforeGain':peak,'masterGain':gain,'narrationSpeed':1.3,'voiceSchedule':schedule,'pageTurnSounds':effects,'music':playback}
    (root/'audio').mkdir(exist_ok=True)
    (root/f'audio/mix.{manifest["language"]}.json').write_text(json.dumps(proof,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    return playback


def install(renderer):
    r=renderer
    r.VERSION += '-local-'+REVISION
    upstream_validate=r.validate
    def validate(manifest,root,args):
        if manifest.get('media_binding_policy')=='sentence-v1':
            from juya_media import validate_bindings
            for theme in manifest['themes']:
                validate_bindings(theme['media_sequence'],theme['narration_captions'],theme['duration_seconds'],args.fps)
        mode=manifest.get('transition_mode')
        if mode not in ('cut','page-turn'):return upstream_validate(manifest,root,args)
        gap=float(manifest.get('theme_gap_seconds',0))
        if gap!=(.5 if mode=='page-turn' else 0):raise r.RenderError('Chapter gap does not match the chosen transition')
        if float(manifest.get('opening_seconds',0))<=0:raise r.RenderError('Opening duration must follow decoded speech')
        # The frozen upstream validates the former 5/.5 second layout. Run all
        # its content/asset checks on a compatibility copy, then keep the new
        # timing in the real manifest. Vendor files remain untouched.
        import copy
        compatible=copy.deepcopy(manifest)
        compatible['opening_seconds']=5;compatible['theme_gap_seconds']=.5
        assets=upstream_validate(compatible,root,args)
        manifest['fps']=args.fps
        for t in manifest['themes']:
            if float(t.get('narration_offset_seconds',-1))!=0:raise r.RenderError('Continuous narration must start with the card')
        return assets
    r.validate=validate
    upstream_choose=r.choose_music
    def choose_music(tracks,seed):
        validated=upstream_choose(tracks,seed)
        # Preparation already selected and saved the episode playlist once.
        # Validate its opening/unique names, then preserve that resolved order.
        if tracks and all(t.get('resolved_index')==i for i,t in enumerate(tracks)):
            if validated[0] is not tracks[0]:raise r.RenderError('Resolved music order must start with boring life')
            return list(tracks)
        return validated
    r.choose_music=choose_music
    upstream_inspect=r.inspect_publication
    def inspect(manifest,args,root):
        assets=upstream_inspect(manifest,args,root)
        additions=[(manifest.get('closing_narration'),'narration','closing',manifest.get('opening_license',{}))]
        for theme in manifest['themes']:
            for item in theme.get('media_sequence',[]):
                additions.append((item['path'],item['kind'],theme['title'],item.get('license',theme.get('license',{}))))
        known={a['path'] for a in assets}
        for path,kind,name,license in additions:
            if not path:continue
            resolved=str(r.local_path(root,path,kind,True))
            if resolved in known:continue
            status=r.license_state(license);evidence=r.license_evidence(license)
            if args.publication_ready and (status not in r.ALLOWED_PUBLISH_LICENSES or not evidence):
                raise r.RenderError('Publication license missing for '+path)
            assets.append({'path':resolved,'kind':kind,'name':name,'license_status':status,'license_evidence':evidence})
            known.add(resolved)
        return assets
    r.inspect_publication=inspect
    r.draw_caption=lambda draw,text,w,h,scale,opacity=1:caption(r,draw,text,w,h,scale,opacity)
    r.compose_frame=lambda *args,**kwargs:compose(r,*args,**kwargs)
    r.build_silent_video=lambda *args,**kwargs:build_video(r,*args,**kwargs)
    r.mix_audio=lambda *args,**kwargs:mix_audio(r,*args,**kwargs)
