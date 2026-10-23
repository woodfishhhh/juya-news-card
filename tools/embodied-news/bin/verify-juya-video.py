"""Verify an encoded episode, extract its real frames and export sentence SRT."""
from __future__ import annotations
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
from juya_review import video_identity
import subprocess
import sys
import numpy as np
from PIL import Image, ImageStat
from juya_production import timeline_for
from juya_media import validate_sequence,popup_envelope
from juya_captions import display_text
from juya_coverage import verify_coverage


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def execute(args):
    p = subprocess.run([str(a) for a in args], capture_output=True, timeout=300)
    if p.returncode:
        raise RuntimeError(p.stderr.decode("utf-8", errors="replace")[-2000:])
    return p.stdout


def stamp(seconds):
    total = round(seconds * 1000)
    seconds, ms = divmod(total, 1000)
    minutes, seconds = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours:02}:{minutes:02}:{seconds:02},{ms:03}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video", type=Path)
    args = ap.parse_args()
    if os.name == "nt" and not __import__("shutil").which("ffmpeg"):
        binaries = sorted((Path(os.environ["LOCALAPPDATA"]) / "Microsoft/WinGet/Packages").glob("Gyan.FFmpeg_*/ffmpeg-*/bin"))
        os.environ["PATH"] = str(binaries[-1]) + os.pathsep + os.environ["PATH"]
    video = args.video.resolve()
    root = video.parent
    meta = json.loads(video.with_suffix(".manifest.json").read_text(encoding="utf-8"))
    manifest = meta["source_manifest_snapshot"]
    locale = meta["language"]
    output = root / "verification" / locale
    output.mkdir(parents=True, exist_ok=True)
    assert meta["sha256"] == digest(video)
    assert meta["source_manifest_sha256"] == digest(root / f"manifest.{locale}.json")
    probe = json.loads(execute(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", video]))
    picture = next(s for s in probe["streams"] if s["codec_type"] == "video")
    sound = next(s for s in probe["streams"] if s["codec_type"] == "audio")
    assert (picture["width"], picture["height"], picture["r_frame_rate"]) == (1920, 1080, "30/1")
    assert sound["codec_name"] == "aac" and sound["channels"] == 2 and sound["sample_rate"] == '48000'
    assert meta["narration_speed"] == 1.3 and meta["theme_gap_seconds"] == .5
    music = json.loads((root / "music-order.json").read_text(encoding="utf-8"))
    assert meta["music_order"] == [track["name"] for track in music["tracks"]]
    assert meta["music_playback"]["covers_video"] and not meta["music_playback"]["repeat"]
    assert meta["music_playback"]["segments"][0]["name"].casefold().startswith("boring life")

    assert manifest["transition_mode"]=="page-turn" and manifest["media_layout"]=="continuous-bookends"
    fps = 30
    frames, named, gaps, cues, chapter_times, media_checks = {30}, {"overview": 30}, [], [], [], []
    for cue in manifest.get("opening_captions", []):
        cues.append((cue["start"]/1.3, cue["end"]/1.3, cue["text"]))
    _, actual_timeline = timeline_for(manifest, fps)
    starts={i:start for start,end,kind,i in actual_timeline if kind=='theme'}
    ends={i:end for start,end,kind,i in actual_timeline if kind=='theme'}
    used_ranges={};cut_checks=[]
    cursor = float(manifest.get('opening_seconds',5))
    for i, theme in enumerate(manifest["themes"]):
        cursor=starts[i]
        duration = ends[i]-cursor
        end = ends[i]
        offset=float(theme.get('narration_offset_seconds',theme['card_seconds']))
        chapter_times.append({"title": theme["title"], "start": cursor, "end": end,
                              "cardSeconds": theme["card_seconds"], "popupAt": cursor + theme['card_seconds'], 'voiceAt':cursor+offset})
        validate_sequence(theme['media_sequence'],used_ranges,(2.5,duration-2.5))
        for mi,edit in enumerate(theme['media_sequence']):
            start=cursor+edit['start_seconds'];stop=cursor+edit['end_seconds']
            times={'enter':start+1/fps,'growing':start+4/fps,'settled':start+.4,'shown':start+min(.8,(stop-start)*.55),'after':stop+.10}
            if edit['kind']=='video' and stop-start>1.9:times['motion']=start+1.8
            sample={}
            for label,time in times.items():
                number=round(time*fps);name=f'media-{i+1:02d}-{mi+1:02d}-{label}'
                named[name]=number;frames.add(number);sample[label]=name
            media_checks.append({'theme':i,'edit':edit,'samples':sample,'last':mi==len(theme['media_sequence'])-1})
        for label, time in [("card", cursor+1), ("before-popup", cursor+2.4),
                            ("popup", cursor+3.3), ("motion", cursor+4.3),
                            ("last-sentence", end-.55)]:
            frame = math.ceil(time*fps)
            named[f"theme-{i+1:02d}-{label}"] = frame
            frames.add(frame)
        # Sample chapter entry and the exact cut; no white fade is allowed.
        for j, time in enumerate([cursor+.04, cursor+.13, cursor+.25]):
            frame = math.ceil(time*fps)
            named[f"theme-{i+1:02d}-entry-{j}"] = frame
            frames.add(frame)
        for cue in theme["captions"]:
            start, finish = cursor+offset+cue["start"]/1.3, cursor+offset+cue["end"]/1.3
            assert finish <= end+.03
            cues.append((start, finish, cue["text"]))
        cursor = end
        boundary=round(starts[i]*fps)
        for label,number,card in [('right',boundary,theme['card_image']),
                                  ('left',round(ends[i-1]*fps)-1 if i else boundary-1,manifest['themes'][i-1]['card_image'] if i else manifest['opening_card_image'])]:
            name=f'cut-{i+1:02d}-{label}'
            named[name]=number;frames.add(number);cut_checks.append({'name':name,'card':card})
    for start,end,kind,_ in actual_timeline:
        if kind=='closing':
            for cue in manifest['closing_captions']:
                cues.append((start+manifest.get('closing_audio_offset',.25)+cue['start']/1.3,start+manifest.get('closing_audio_offset',.25)+cue['end']/1.3,cue['text']))
            for label,time in [('closing',start+1),('closing-last-phrase',end-1.05)]:
                number=math.ceil(time*fps);named[label]=number;frames.add(number)
    expected_duration = actual_timeline[-1][1]
    assert abs(float(probe["format"]["duration"])-expected_duration) < .05
    ordered = sorted(frames)
    gap_numbers = {number for gap in gaps for number in gap["frames"]}
    terms = [f"eq(n\\,{number})" for number in ordered if number not in gap_numbers]
    terms += [f"between(n\\,{gap['frames'][0]}\\,{gap['frames'][-1]})" for gap in gaps]
    # Hundreds of frame samples exceed libavutil's expression recursion limit
    # when added as one left-deep chain. A balanced sum keeps the same exact
    # selection with logarithmic nesting depth.
    while len(terms)>1:
        terms=[f'({terms[i]}+{terms[i+1]})' if i+1<len(terms) else terms[i] for i in range(0,len(terms),2)]
    expression=terms[0]
    # One full decode checks both streams and exports the selected real frames.
    execute(["ffmpeg", "-v", "error", "-xerror", "-y", "-i", video,
             "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-",
             "-map", "0:v:0", "-vf", f"select={expression}", "-fps_mode", "vfr",
             output / "frame-%04d.png"])
    decoded = sorted(output.glob("frame-*.png"))
    assert len(decoded) == len(ordered), (len(decoded), len(ordered))
    lookup = dict(zip(ordered, decoded))
    cuts=[]
    for check in cut_checks:
        with Image.open(lookup[named[check['name']]]) as picture, Image.open(root/check['card']) as card:
            a=np.asarray(picture.convert('RGB')).astype(float)[67:884,175:1745]
            b=np.asarray(card.convert('RGB')).astype(float)[67:884,175:1745]
            error=float(np.abs(a-b).mean())
            assert error<5,(check['name'],'blank or faded frame at chapter cut',error)
            cuts.append({**check,'frame':named[check['name']],'meanCardError':error})
    for name, frame in named.items():
        (output / f"{name}.png").write_bytes(lookup[frame].read_bytes())
    # Read the actual compressed progress strokes. Fixed chapter labels and
    # both bars must share one monotonically advancing global position.
    progress=[]
    span=chapter_times[-1]['end']-chapter_times[0]['start']
    for name,number in sorted(named.items(),key=lambda pair:pair[1]):
        if not name.startswith('theme-') or not name.endswith(('card','before-popup','popup','motion','last-sentence')):continue
        with Image.open(lookup[number]) as im:a=np.asarray(im.convert('RGB')).astype(float)
        positions=[]
        for rows in [(51,54),(1077,1080)]:
            rgb=a[rows[0]:rows[1]].mean(axis=0)
            mask=(rgb[:,0]>140)&(rgb[:,0]-rgb[:,1]>50)&(rgb[:,1]-rgb[:,2]>0)&(rgb[:,1]-rgb[:,2]<48)
            active=np.where(mask)[0]
            assert len(active)>0,(name,rows,'missing progress stroke')
            positions.append(int(active[-1]))
        expected=round(1920*((number/30)-chapter_times[0]['start'])/span)
        assert abs(positions[0]-positions[1])<=5,(name,'bars disagree',positions)
        assert max(abs(x-expected) for x in positions)<=6,(name,'progress differs from frame time',positions,expected)
        progress.append({'frame':number,'name':name,'topX':positions[0],'bottomX':positions[1],'expectedX':expected})
    assert [p['topX'] for p in progress]==sorted(p['topX'] for p in progress)
    # Check actual encoded popup entry, darkened backdrop and restoration for
    # every finite edit. Compare motion within the SAME source clip.
    motion,edits_proof=[],[]
    for row in media_checks:
        i,edit,samples=row['theme'],row['edit'],row['samples']
        with Image.open(root/manifest['themes'][i]['card_image']) as card:base=np.asarray(card.convert('RGB')).astype(float)
        asset=root/edit['path']
        if edit['kind']=='image':
            with Image.open(asset) as im:source_width,source_height=im.size
        else:
            dimensions=json.loads(execute(['ffprobe','-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','json',asset]))['streams'][0]
            source_width,source_height=dimensions['width'],dimensions['height']
        sizes=[]
        for label,elapsed in [('enter',1/fps),('growing',4/fps),('settled',.4)]:
            with Image.open(output/(samples[label]+'.png')) as im:a=np.asarray(im.convert('RGB')).astype(float)
            opacity,pop_scale=popup_envelope(elapsed,edit['end_seconds']-edit['start_seconds'],continuous=True,last=row['last'])
            bg=base*(1-.18*opacity)
            fit=min(round(1520*pop_scale)/source_width,round(830*pop_scale)/source_height)
            width,height=round(source_width*fit),round(source_height*fit)
            x0,y0=round(960-width/2),round(479-height/2)
            difference=np.mean(np.abs(a-bg),axis=2)
            # H.264 chroma errors around card glyphs make a raw difference
            # bounding box extend past the photo. Check the exterior ring of
            # the independently calculated scaled box instead of using those
            # isolated text-edge pixels as the popup edge.
            ring=np.zeros((1080,1920),dtype=bool);ring[67:910,175:1745]=True
            ring[max(67,y0-5):min(910,y0+height+5),max(175,x0-5):min(1745,x0+width+5)]=False
            outside=float(difference[ring].mean()) if ring.any() else 0
            inside=float(difference[max(67,y0+5):min(910,y0+height-5),max(0,x0+5):min(1920,x0+width-5)].mean())
            assert outside<6,(i,edit['path'],'pixels outside animated popup bounds',label,outside)
            assert inside>.5,(i,edit['path'],'popup absent',label,inside)
            sizes.append({'phase':label,'expectedWidth':width,'expectedHeight':height,'outsideMeanError':outside,'insideMeanDifference':inside})
        assert sizes[1]['expectedWidth']>sizes[0]['expectedWidth']+4
        with Image.open(output/(samples['shown']+'.png')) as im:a=np.asarray(im.convert('RGB')).astype(float)
        ratio=float(a[160:800,45:145].mean()/base[160:800,45:145].mean())
        assert .79<ratio<.85,(i,edit['path'],'background did not darken gently',ratio)
        with Image.open(output/(samples['after']+'.png')) as im:a=np.asarray(im.convert('RGB')).astype(float)
        restored=float(a[160:800,45:145].mean()/base[160:800,45:145].mean())
        assert (.98<restored<1.02) if row['last'] else (.79<restored<.85),(i,edit['path'],'unexpected backdrop at media boundary',restored)
        if 'motion' in samples:
            from PIL import ImageChops
            with Image.open(output/(samples['shown']+'.png')) as first,Image.open(output/(samples['motion']+'.png')) as second:
                diff=ImageChops.difference(first.convert('RGB'),second.convert('RGB')).crop((210,74,1710,884))
                mean=sum(ImageStat.Stat(diff).mean)/3
                assert mean>.1,(i,edit['path'],'frozen source clip',mean)
                motion.append({'theme':i+1,'path':edit['path'],'sourceIn':edit['source_in'],'sourceOut':edit['source_out'],'meanPixelDifferenceOneSecondApart':mean})
        edits_proof.append({'theme':i+1,'path':edit['path'],'kind':edit['kind'],'displaySeconds':edit['end_seconds']-edit['start_seconds'],'complex':edit.get('complex',False),'popupSizes':sizes,'backgroundRatio':ratio,'restoredRatio':restored})
    srt = "\n\n".join(f"{i+1}\n{stamp(start)} --> {stamp(end)}\n{display_text(text)}" for i,(start,end,text) in enumerate(cues)) + "\n"
    (root / f"captions.{locale}.srt").write_text(srt, encoding="utf-8")
    # Actual encoded speech must be in the right place; metadata and a valid
    # audio stream do not establish narration/subtitle synchronization.
    execute([sys.executable,Path(__file__).with_name('verify-juya-audio.py'),video])
    audio_proof=json.loads((root/f'verification/audio.{locale}.json').read_text(encoding='utf-8'))
    import importlib.util
    spec=importlib.util.spec_from_file_location('entry',Path(__file__).with_name('render-juya-video.py'))
    entry=importlib.util.module_from_spec(spec);spec.loader.exec_module(entry)
    coverage=verify_coverage(video,root,manifest,actual_timeline,entry.renderer.PAPER)
    identity=video_identity(video) if meta.get("productionBinding") else None
    receipt = {"status": "technical_checks_passed", "language": locale,
               "video": str(video), "sha256": digest(video), "duration": float(probe["format"]["duration"]),
               "resolution": [1920,1080], "fps": 30, "audio": {"codec": sound["codec_name"], "channels": sound["channels"], "sampleRate": int(sound["sample_rate"])},
               "completeAudioVideoDecode": True, "selectedRealFrames": len(ordered),
               "blankGapCount": len(coverage["gaps"]), "blankFramesPerGap": 15, "gaps": coverage["gaps"], "cardBoundaryChecks":cuts, "fullFrameCoverage":coverage["status"],
               "cutPolicy":"2.5 second card bookends, continuous middle media, half-second page-turn interval",
               "chapters": chapter_times, "movingMedia": motion, "subtitleCues": len(cues),'mediaEdits':edits_proof,
               "sentenceCues": sum(len(t.get('narration_captions',t['captions'])) for t in manifest['themes'])+len(manifest['opening_narration_captions'])+len(manifest['closing_narration_captions']),
               "sourceSpeed": 1.0, "renderSpeed": 1.3, "musicOrder": meta["music_order"],
               "continuousMusicCoversVideo": True, "musicRepeat": False,
               "frameDirectory": str(output), "visualReview": "pending",
               "userAcceptance": "pending", "publicPublicationPerformed": False}
    receipt['productionIdentity']=identity
    receipt['encodedSpeechTiming']=audio_proof['status']
    receipt['pageTurnSoundCount']=len(audio_proof['pageTurnSounds'])
    receipt['maximumSpeechStartErrorMs']=audio_proof['maximumStartErrorMs']
    receipt['encodedProgressMonotonic']=True
    receipt['encodedProgressSamples']=progress
    (root / "verification" / f"video.{locale}.json").write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({key:receipt[key] for key in ["status","language","duration","selectedRealFrames","blankGapCount","sentenceCues"]}))


if __name__ == "__main__":
    main()
