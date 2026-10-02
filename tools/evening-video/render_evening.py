#!/usr/bin/env python3
"""Offline renderer for Juya embodied-AI evening videos (Python + Pillow + FFmpeg)."""
from __future__ import annotations
import argparse, hashlib, json, math, os, random, re, shutil, subprocess, sys, tempfile, time, unicodedata
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse
from PIL import Image, ImageDraw, ImageFont, ImageOps

VERSION = "1.0.0"
FPS_DEFAULT = 30
FONT_CANDIDATES = [
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]
CORAL = (208, 105, 85)
INK = (58, 55, 52)
PAPER = (250, 249, 246)

class RenderError(Exception):
    pass

def run(cmd: list[str], *, input_bytes: bytes | None = None) -> subprocess.CompletedProcess:
    p = subprocess.run(cmd, input=input_bytes, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode:
        raise RenderError(f"command failed ({p.returncode}): {' '.join(cmd)}\n{p.stderr.decode(errors='replace')[-2500:]}")
    return p

def sha256_file(path: Path) -> str:
    h=hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024), b''): h.update(chunk)
    return h.hexdigest()

def local_card_request_allowed(url:str, root:Path|None=None) -> bool:
    value=str(url).lower()
    if value.startswith(("data:","blob:")): return True
    if not value.startswith("file:"): return False
    if root is None: return True
    parsed=urlparse(url)
    path=Path(unquote(parsed.path)).resolve()
    base=root.resolve()
    return path==base or base in path.parents

def local_path(root: Path, value: str | None, label: str, required=False) -> Path | None:
    if not value:
        if required: raise RenderError(f"missing required {label} path")
        return None
    if value.startswith(("http://", "https://", "file://")):
        raise RenderError(f"{label} must be a local manifest-relative file, not a URL: {value}")
    p=(root / value).resolve()
    if root.resolve() not in p.parents and p != root.resolve():
        raise RenderError(f"{label} escapes the manifest directory: {value}")
    if not p.is_file(): raise RenderError(f"{label} file not found: {p}")
    return p

def license_state(item: dict[str,Any]) -> str:
    if not isinstance(item,dict): return "unknown"
    lic=item.get("license") if isinstance(item.get("license"),dict) else item if "status" in item else None
    if not isinstance(lic,dict): return "unknown"
    status=str(lic.get("status", "unknown")).strip().lower().replace("-", "_")
    return status or "unknown"

def license_evidence(item: dict[str,Any]) -> str:
    if not isinstance(item,dict): return ""
    lic=item.get("license") if isinstance(item.get("license"),dict) else item if "status" in item else None
    return str(lic.get("evidence","")).strip() if isinstance(lic,dict) else ""

ALLOWED_PUBLISH_LICENSES={"licensed","public_domain","cc0","creative_commons"}
def inspect_publication(manifest: dict[str,Any], args: argparse.Namespace, root:Path) -> list[dict[str,str]]:
    assets=[]
    def add(path, kind, name, item):
        resolved=local_path(root,path,f"{kind} asset")
        if resolved: assets.append({"path":str(resolved),"kind":kind,"name":name,"license_status":license_state(item),"license_evidence":license_evidence(item)})
    for ti,t in enumerate(manifest["themes"]):
        lic=t.get("license",{}); specific=t.get("licenses",{})
        add(t.get("card_image") or t.get("card_html"),"card",str(t.get("title",ti+1)),specific.get("card",t.get("card_license",lic)))
        add(t.get("media"),"media",str(t.get("title",ti+1)),specific.get("media",t.get("media_license",lic)))
        add(t.get("media_video"),"video",str(t.get("title",ti+1)),specific.get("media",t.get("media_license",lic)))
        add(t.get("narration"),"narration",str(t.get("title",ti+1)),specific.get("narration",t.get("narration_license",lic)))
    add(manifest.get("opening_narration"),"narration","opening",manifest.get("opening_license",{}))
    for i,m in enumerate(manifest.get("music_tracks",[])): add(m.get("path"),"music",str(m.get("name",i+1)),m)
    if args.publication_ready:
        unknown=[a for a in assets if a["license_status"] not in ALLOWED_PUBLISH_LICENSES or not a["license_evidence"]]
        if unknown:
            listing="; ".join(f"{a['kind']} {a['name']}: {a['license_status']} (evidence {'present' if a['license_evidence'] else 'missing'})" for a in unknown)
            raise RenderError("publication-ready blocked; every included asset needs an approved declared status "+str(sorted(ALLOWED_PUBLISH_LICENSES))+" plus license.evidence. Declarations are recorded, not independently verified. Blocked assets: "+listing)
    return assets

def _font(size:int) -> ImageFont.FreeTypeFont:
    for f in FONT_CANDIDATES:
        if os.path.isfile(f):
            try: return ImageFont.truetype(f,size=size,index=0)
            except Exception: pass
    return ImageFont.load_default()

def fit_lines(text:str, font_path_size:int, max_width:int, max_lines:int=2, min_size:int=16):
    text=str(text or "")
    # Wrap by measured glyph width. Keep every character; never ellipsize/truncate.
    for size in range(font_path_size, min_size-1, -1):
        font=_font(size); out=[]; overflow=False
        for para in text.split("\n"):
            line=""
            for char in para:
                candidate=line+char
                if line and font.getlength(candidate)>max_width:
                    out.append(line); line=char
                else:
                    line=candidate
            out.append(line)
            if len(out)>max_lines:
                overflow=True; break
        if not overflow and len(out)<=max_lines and all(font.getlength(x)<=max_width for x in out):
            return out,font
    raise RenderError(f"caption/title is too long to show complete in {max_lines} lines (maximum font shrink reached): {text}")

def draw_centered_text(draw, text, box, *, size, color, max_lines=2, min_size=16, align="center", stroke_width=0, stroke_fill=None):
    x0,y0,x1,y1=box
    lines,font=fit_lines(text,size,x1-x0,max_lines,min_size)
    spacing=max(2,int(font.size*.18)); heights=[font.getbbox(s or " ")[3]-font.getbbox(s or " ")[1] for s in lines]
    total=sum(heights)+spacing*max(0,len(lines)-1); y=y0+(y1-y0-total)/2
    for line,h in zip(lines,heights):
        text_width=font.getlength(line)
        x=x0 if align=="left" else (x1-text_width if align=="right" else x0+(x1-x0-text_width)/2)
        draw.text((int(x),int(y)),line,font=font,fill=color,stroke_width=stroke_width,stroke_fill=stroke_fill)
        y+=h+spacing

def cover_resize(img:Image.Image,w:int,h:int,mode:str="cover") -> Image.Image:
    img=img.convert("RGB")
    if mode=="contain": return ImageOps.contain(img,(w,h))
    return ImageOps.fit(img,(w,h),method=Image.Resampling.LANCZOS,centering=(0.5,0.5))

def make_card(theme:dict[str,Any], root:Path, w:int,h:int, idx:int) -> Image.Image:
    p=local_path(root,theme.get("card_image"),f"theme[{idx}].card_image")
    if p:
        with Image.open(p) as im: return cover_resize(im,w,h,"cover")
    htmlp=local_path(root,theme.get("card_html"),f"theme[{idx}].card_html")
    if htmlp:
        try:
            from playwright.sync_api import sync_playwright
        except Exception as e: raise RenderError("card_html requires installed Python Playwright and local Chromium") from e
        out=root/".juya-render-cache"/f"card-{idx}-{w}x{h}.png"; out.parent.mkdir(exist_ok=True)
        try:
            with sync_playwright() as pw:
                browser=pw.chromium.launch(headless=True,executable_path="/usr/bin/chromium",args=["--no-sandbox","--allow-file-access-from-files","--disable-background-networking","--disable-sync","--host-resolver-rules=MAP * ~NOTFOUND"])
                page=browser.new_page(viewport={"width":w,"height":h},device_scale_factor=1)
                page.route("**/*", lambda route: route.continue_() if local_card_request_allowed(route.request.url,root) else route.abort())
                page.goto(htmlp.as_uri(),wait_until="networkidle"); page.screenshot(path=str(out),full_page=False); browser.close()
        except Exception as e:
            detail=str(e)
            if "Operation not permitted" in detail or "socket() failed" in detail:
                detail="sandbox denied Chromium's local IPC socket (Operation not permitted)"
            else:
                detail=detail.splitlines()[0] if detail else "unknown launch error"
            raise RenderError(f"local Chromium could not capture card_html in this environment: {detail}") from e
        with Image.open(out) as im: return cover_resize(im,w,h,"cover")
    # Useful offline default when no pre-rendered source card is supplied.
    image=Image.new("RGB",(w,h),PAPER); d=ImageDraw.Draw(image)
    title=str(theme.get("title","未命名主题")); sub=str(theme.get("source_line", "本地素材 / 资料来源以 manifest 为准"))
    d.rectangle((int(w*.105),int(h*.18),int(w*.895),int(h*.81)),fill=(255,255,255),outline=(226,222,216),width=max(1,int(w/960)))
    draw_centered_text(d,title,(int(w*.13),int(h*.26),int(w*.87),int(h*.43)),size=max(24,int(w*.055)),color=CORAL,max_lines=2,min_size=18)
    draw_centered_text(d,sub,(int(w*.15),int(h*.45),int(w*.85),int(h*.67)),size=max(16,int(w*.024)),color=INK,max_lines=2,min_size=14)
    return image

class MediaStream:
    def __init__(self,path:Path,w:int,h:int,fps:int):
        vf=f"fps={fps},scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1"
        self.p=subprocess.Popen(["ffmpeg","-hide_banner","-loglevel","error","-stream_loop","-1","-i",str(path),"-an","-vf",vf,"-f","rawvideo","-pix_fmt","rgb24","pipe:1"],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        self.w,self.h=w,h; self.size=w*h*3
    def next(self):
        data=self.p.stdout.read(self.size)
        if len(data)!=self.size:
            if self.p.poll() is None: self.p.terminate()
            try: self.p.wait(timeout=2)
            except subprocess.TimeoutExpired: self.p.kill()
            err=self.p.stderr.read() if self.p.stderr else b""
            raise RenderError("local popup video could not be decoded: "+err.decode(errors="replace")[-1200:])
        return Image.frombytes("RGB",(self.w,self.h),data)
    def close(self):
        if self.p.poll() is None: self.p.terminate()
        try: self.p.wait(timeout=2)
        except subprocess.TimeoutExpired: self.p.kill()

def title_nav(draw, manifest, theme, w, h, scale, opacity=1.0):
    sections=manifest.get("sections",[])
    if not sections: sections=[{"id":"default","title":"概览"}]
    active=theme.get("section_id",sections[0].get("id"))
    nav_h=max(1,int(64*scale)); bg=(250,249,246,int(247*opacity)); draw.rectangle((0,0,w,nav_h),fill=bg)
    width=w/len(sections)
    for i,s in enumerate(sections):
        x0=int(i*width); x1=int((i+1)*width)
        label=str(s.get("title",s.get("id","")))
        selected=(s.get("id")==active)
        if selected: draw.rectangle((x0+2,3,x1-2,nav_h-3),fill=(245,227,220,int(255*opacity)))
        f=_font(max(8,int(27*scale))); tw=draw.textlength(label,font=f); th=f.getbbox(label)[3]-f.getbbox(label)[1]
        color=CORAL if selected else (86,82,78)
        draw.text((x0+(x1-x0-tw)/2,(nav_h-th)/2-1),label,font=f,fill=(*color,int(255*opacity)))
        if selected:
            bar_x0=x0+5; bar_x1=max(bar_x0+1,bar_x0+int((x1-x0-10)*theme.get("_section_progress",1.0)))
            draw.rectangle((bar_x0,nav_h-max(3,int(4*scale)),min(x1-5,bar_x1),nav_h),fill=(*CORAL,int(255*opacity)))

def event_nav(draw, manifest, theme_idx, w,h, scale, opacity=1.0):
    themes=manifest["themes"]; nav_h=max(1,int(56*scale)); y0=h-nav_h
    draw.rectangle((0,y0,w,h),fill=(250,249,246,int(248*opacity)))
    # Use fixed equal slots and measured 2-line text if many headlines are present.
    step=w/len(themes)
    for i,t in enumerate(themes):
        x0=int(i*step); x1=int((i+1)*step); label=f"{i+1:02d} {t.get('event_title',t.get('title',''))}"
        selected=(i==theme_idx)
        if selected: draw.rectangle((x0,y0,x1,y0+nav_h-1),fill=(245,227,220,int(255*opacity)))
        f=_font(max(8,int(23*scale))); lines,_=fit_lines(label,f.size,max(6,int(step-10)),1,max(7,int(12*scale)))
        line=lines[0] if lines else label
        # If the item cannot fit even at the small size, shrink horizontal scale while preserving content.
        txt=Image.new("RGBA",(max(4,int(step)),nav_h),(0,0,0,0)); td=ImageDraw.Draw(txt); tw=td.textlength(line,font=f)
        if tw>txt.width-8:
            f2=_font(max(9,int(f.size*(txt.width-8)/max(tw,1))))
            if td.textlength(line,font=f2)>txt.width-8: raise RenderError(f"event navigation item too long for single line: {label}")
            f=f2; tw=td.textlength(line,font=f)
        color=CORAL if selected else (135,128,120); th=f.getbbox(line)[3]-f.getbbox(line)[1]
        draw.text((x0+(step-tw)/2,y0+(nav_h-th)/2),line,font=f,fill=(*color,int(255*opacity)))
        if selected: draw.rectangle((x0+2,h-3,x1-2,h),fill=(*CORAL,int(255*opacity)))

def draw_caption(draw,text,w,h,scale,opacity=1.0):
    if not text: return
    bottom=int(1008*scale); maxw=int(w*.86); desired=max(12,int(42*scale))
    lines,font=fit_lines(text,desired,maxw,2,max(9,int(16*scale)))
    heights=[font.getbbox(line or " ")[3]-font.getbbox(line or " ")[1] for line in lines]
    pad=max(5,int(11*scale)); gap=max(2,int(4*scale)); block_h=sum(heights)+gap*max(0,len(lines)-1)+2*pad
    y=bottom-block_h; d=draw
    # Gray caption plates match the reference footage, with enough width for full sentence.
    cursor=y+pad
    for line,lh in zip(lines,heights):
        tw=d.textlength(line,font=font); x=(w-tw)/2
        x0=int(max(0,x-pad)); x1=int(min(w,x+tw+pad)); y0=int(cursor-2*scale); y1=int(cursor+lh+2*scale)
        d.rectangle((x0,y0,x1,y1),fill=(71,70,67,int(225*opacity)))
        d.text((int(x),int(cursor)),line,font=font,fill=(255,255,255,int(255*opacity)))
        cursor+=lh+gap

def draw_opening(manifest,w,h,scale,alpha):
    im=Image.new("RGB",(w,h),PAPER).convert("RGBA"); lay=Image.new("RGBA",(w,h),(250,249,246,0)); d=ImageDraw.Draw(lay)
    d.rectangle((int(w*.105),int(h*.15),int(w*.895),int(h*.84)),fill=(255,255,255,255),outline=(225,220,214,255),width=max(1,int(2*scale)))
    draw_centered_text(d,"本期概览",(int(w*.16),int(h*.21),int(w*.84),int(h*.31)),size=max(12,int(38*scale)),color=INK,max_lines=1,min_size=max(9,int(17*scale)))
    draw_centered_text(d,str(manifest.get("episode_title","具身智能动态")),(int(w*.14),int(h*.32),int(w*.86),int(h*.47)),size=max(14,int(54*scale)),color=CORAL,max_lines=2,min_size=max(10,int(18*scale)))
    overview=str(manifest.get("overview",""))
    if overview: draw_centered_text(d,overview,(int(w*.19),int(h*.49),int(w*.81),int(h*.64)),size=max(12,int(28*scale)),color=INK,max_lines=2,min_size=max(9,int(14*scale)))
    host=str(manifest.get("host_line","大家好，我是小鱼是木鱼，以上是今天具身智能动态"))
    draw_centered_text(d,host,(int(w*.12),int(h*.66),int(w*.88),int(h*.77)),size=max(12,int(26*scale)),color=(96,90,84),max_lines=2,min_size=max(9,int(13*scale)))
    out=Image.alpha_composite(im,lay); return out.convert("RGB")

def caption_for(theme:dict[str,Any],popup_elapsed:float,speed:float):
    source_t=popup_elapsed*speed
    for c in theme.get("captions",[]):
        if float(c.get("start",0)) <= source_t < float(c.get("end",0)):
            return str(c.get("text",""))
    return ""

def compose_frame(base:Image.Image, manifest:dict[str,Any], theme_idx:int|None, popup:Image.Image|None,
                  caption:str, w:int,h:int,scale:float,alpha:float, frame_idx:int, total_frames:int,
                  show_nav=True) -> Image.Image:
    frame=base.convert("RGBA")
    # If original card already has its own static navigation/caption chrome, paint over only those strips.
    if theme_idx is not None and manifest["themes"][theme_idx].get("card_has_chrome",False):
        d0=ImageDraw.Draw(frame); bg=manifest["themes"][theme_idx].get("chrome_fill",list(PAPER))
        if len(bg)==3: bg=tuple(bg)+(255,)
        d0.rectangle((0,0,w,int(65*scale)),fill=tuple(bg))
        d0.rectangle((0,int(890*scale),w,int(1024*scale)),fill=tuple(bg))
        d0.rectangle((0,int(1024*scale),w,h),fill=tuple(bg))
    # Fade through white, preserving the visible reference style at the media card.
    if alpha<0.999:
        white=Image.new("RGBA",(w,h),(255,255,255,int((1-alpha)*255))); frame=Image.alpha_composite(white,frame)
    if popup:
        px=round(w*200/1920); py=round(h*64/1080); pw=round(w*1520/1920); ph=round(h*830/1080)
        d=ImageDraw.Draw(frame)
        d.rectangle((px,py,px+pw-1,py+ph-1),fill=(255,255,255,255))
        margin=max(1,round(8*scale)); inner=(px+margin,py+margin,px+pw-margin,py+ph-margin)
        fitted=ImageOps.contain(popup.convert("RGB"),(inner[2]-inner[0],inner[3]-inner[1]))
        ix=inner[0]+(inner[2]-inner[0]-fitted.width)//2; iy=inner[1]+(inner[3]-inner[1]-fitted.height)//2
        frame.alpha_composite(fitted.convert("RGBA"),(ix,iy))
    if theme_idx is not None and show_nav:
        d=ImageDraw.Draw(frame); theme=manifest["themes"][theme_idx]
        default_section=manifest.get("sections",[{"id":"default"}])[0].get("id")
        active_section=theme.get("section_id",default_section)
        section_total=sum(float(t["duration_seconds"]) for t in manifest["themes"] if t.get("section_id",default_section)==active_section)
        section_elapsed=0.0
        for index,t in enumerate(manifest["themes"]):
            if t.get("section_id",default_section)!=active_section: continue
            if index==theme_idx:
                section_elapsed+=max(0,min(float(t["duration_seconds"]),(frame_idx/manifest["fps"])-t.get("_timeline_start",0)))
                break
            if index<theme_idx: section_elapsed+=float(t["duration_seconds"])
        theme["_section_progress"]=min(1.0,section_elapsed/section_total) if section_total else 0.0
        title_nav(d,manifest,theme,w,h,scale,alpha)
        event_nav(d,manifest,theme_idx,w,h,scale,alpha)
        draw_caption(ImageDraw.Draw(frame),caption,w,h,scale,alpha)
        # Subtle progress stroke under current event navigation item.
        theme=manifest["themes"][theme_idx]; duration=float(theme["duration_seconds"])
        elapsed=max(0,min(duration, (frame_idx/manifest["fps"])-theme.get("_timeline_start",0)))
        slot=w/len(manifest["themes"]); x0=int(theme_idx*slot)
        p=x0+int(slot*(elapsed/duration)); y=h-int(56*scale)
        d.rectangle((x0,y,p,y+max(1,int(2*scale))),fill=(*CORAL,255))
    return frame.convert("RGB")

def media_reader_for(theme,root,w,h,fps):
    p=local_path(root,theme.get("media_video"),"media_video")
    return MediaStream(p,w,h,fps) if p else None

def build_silent_video(manifest, root, output_video, width,height,fps):
    scale=width/1920; intro=float(manifest.get("opening_seconds",5)); gap=float(manifest.get("theme_gap_seconds",0.5)); themes=manifest["themes"]
    timeline=[]; cursor=intro
    for i,t in enumerate(themes):
        t["_timeline_start"]=cursor
        dur=float(t["duration_seconds"])
        if dur < float(t.get("card_seconds",5)): raise RenderError(f"theme {i+1} duration_seconds must be >= card_seconds")
        timeline.append((cursor,cursor+dur,"theme",i)); cursor+=dur
        if i != len(themes)-1:
            timeline.append((cursor,cursor+gap,"gap",i)); cursor+=gap
    total=cursor; total_frames=math.ceil(total*fps)
    out=subprocess.Popen(["ffmpeg","-y","-hide_banner","-loglevel","error","-f","rawvideo","-pixel_format","rgb24","-video_size",f"{width}x{height}","-framerate",str(fps),"-i","pipe:0","-an","-c:v","libx264","-preset","ultrafast","-crf","23","-pix_fmt","yuv420p","-r",str(fps),"-movflags","+faststart",str(output_video)],stdin=subprocess.PIPE,stderr=subprocess.PIPE)
    cards=[make_card(t,root,width,height,i) for i,t in enumerate(themes)]
    readers={}; opened_base=draw_opening(manifest,width,height,scale,1.0)
    try:
        for fi in range(total_frames):
            now=fi/fps; chosen=None
            for start,end,kind,idx in timeline:
                if start <= now < end: chosen=(start,end,kind,idx); break
            alpha=1.0; theme_idx=None; popup=None; caption=""; show_nav=True
            if chosen is None or now < intro:
                base=opened_base; theme_idx=None; show_nav=False
                open_caption=""
                source_t=max(0,(now-float(manifest.get("opening_audio_offset",0)))*float(manifest.get("narration_speed",1.3)))
                for c in manifest.get("opening_captions",[]):
                    if float(c.get("start",0))<=source_t<float(c.get("end",0)):
                        open_caption=str(c.get("text","")); break
                if open_caption:
                    opening_frame=base.convert("RGBA")
                    draw_caption(ImageDraw.Draw(opening_frame),open_caption,width,height,scale,1.0)
                    base=opening_frame.convert("RGB")
            elif chosen[2]=="gap":
                # Exactly the requested white half-second between topics; navigation is hidden.
                base=Image.new("RGB",(width,height),(255,255,255)); theme_idx=None; show_nav=False
            else:
                start,end,_,idx=chosen; theme=themes[idx]; theme_idx=idx; local=now-start
                base=cards[idx]
                card_seconds=float(theme.get("card_seconds",5))
                # Fade in at the start and fade out just before the next white gap.
                fade=min(0.35, max(0.01, (end-start)/4))
                alpha=min(1.0,local/fade,(end-now)/fade)
                media_start= start+card_seconds
                if now>=media_start:
                    mp=local_path(root,theme.get("media"),f"theme[{idx}].media")
                    vp=local_path(root,theme.get("media_video"),f"theme[{idx}].media_video")
                    margin=max(1,round(8*scale))
                    media_w=max(2,round(width*1520/1920)-2*margin); media_h=max(2,round(height*830/1080)-2*margin)
                    if vp:
                        if idx not in readers: readers[idx]=media_reader_for(theme,root,media_w,media_h,fps)
                        popup=readers[idx].next()
                    elif mp:
                        with Image.open(mp) as m: popup=cover_resize(m,media_w,media_h,"contain")
                    popup_elapsed=now-media_start
                    caption=caption_for(theme,popup_elapsed,float(manifest.get("narration_speed",1.3)))
                # Do not show popup before five seconds; the base theme card remains visible.
            frame=compose_frame(base,manifest,theme_idx,popup,caption,width,height,scale,alpha,fi,total_frames,show_nav)
            out.stdin.write(frame.tobytes())
        out.stdin.close(); err=out.stderr.read() if out.stderr else b""; code=out.wait()
        if code: raise RenderError(f"ffmpeg video encode failed: {err.decode(errors='replace')[-2500:]}")
    finally:
        for reader in readers.values(): reader.close()
        if out.poll() is None:
            try: out.stdin.close()
            except Exception: pass
            out.kill()
    return total, timeline

def make_sfx(path:Path):
    run(["ffmpeg","-y","-hide_banner","-loglevel","error","-f","lavfi","-i","sine=frequency=980:duration=0.18","-af","afade=t=out:st=0.02:d=0.16,volume=0.15","-ar","48000","-ac","2",str(path)])

def mix_audio(manifest,root,output_video,output_final,total,timeline,seed,order):
    fps=int(manifest["fps"]); total_frames=math.ceil(total*fps); actual_duration=total_frames/fps
    command=["ffmpeg","-y","-hide_banner","-loglevel","error","-i",str(output_video)]
    layers=[]; idx=2; filters=[]
    # Always include a full-length silent base; only local authored audio is added.
    command += ["-f","lavfi","-t",f"{actual_duration:.5f}","-i","anullsrc=channel_layout=stereo:sample_rate=48000"]
    filters.append(f"[1:a]atrim=duration={actual_duration:.5f},asetpts=PTS-STARTPTS[base]"); layers.append("[base]")
    theme_start={i:start for start,end,kind,i in timeline if kind=="theme"}
    opening=local_path(root,manifest.get("opening_narration"),"opening_narration")
    if opening:
        command += ["-i",str(opening)]
        delay=int(float(manifest.get("opening_audio_offset",0))*1000)
        gain=float(manifest.get("opening_narration_volume",1.0)); label="opening"
        filters.append(f"[{idx}:a]atempo=1.3,volume={gain},adelay={delay}|{delay},atrim=duration={actual_duration:.5f},asetpts=PTS-STARTPTS[{label}]")
        layers.append(f"[{label}]"); idx+=1
    for i,t in enumerate(manifest["themes"]):
        narration=local_path(root,t.get("narration"),f"theme[{i}].narration")
        if narration:
            command += ["-i",str(narration)]
            start=theme_start[i]+float(t.get("card_seconds",5)); delay=max(0,int(start*1000))
            gain=float(t.get("narration_volume",1.0)); label=f"n{i}"
            filters.append(f"[{idx}:a]atempo=1.3,volume={gain},adelay={delay}|{delay},atrim=duration={actual_duration:.5f},asetpts=PTS-STARTPTS[{label}]")
            layers.append(f"[{label}]"); idx+=1
    tracks=manifest.get("music_tracks",[])
    for i,t in enumerate(manifest["themes"]):
        if not tracks: break
        track=order[i%len(order)]; chosen=str(track.get("name"))
        music=local_path(root,track["path"],f"music track {chosen}")
        command += ["-stream_loop","-1","-i",str(music)]
        start=theme_start[i]; end=start+float(t["duration_seconds"]); delay=int(start*1000)
        volume=float(track.get("volume",0.14)); label=f"m{i}"
        filters.append(f"[{idx}:a]atrim=duration={end-start:.5f},volume={volume},adelay={delay}|{delay},atrim=duration={actual_duration:.5f},asetpts=PTS-STARTPTS[{label}]")
        layers.append(f"[{label}]"); idx+=1
    gaps=[(s,e) for s,e,k,i in timeline if k=="gap"]
    if gaps:
        with tempfile.TemporaryDirectory(prefix="juya-sfx-") as td:
            sfx=Path(td)/"page-turn.wav"; make_sfx(sfx)
            for gi,(start,end) in enumerate(gaps):
                command += ["-i",str(sfx)]; delay=int(((start+end)/2)*1000); label=f"s{gi}"
                filters.append(f"[{idx}:a]volume=1,adelay={delay}|{delay},atrim=duration={actual_duration:.5f},asetpts=PTS-STARTPTS[{label}]")
                layers.append(f"[{label}]"); idx+=1
            filters.append("".join(layers)+f"amix=inputs={len(layers)}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.96[aout]")
            command += ["-filter_complex",";".join(f for f in filters if f),"-map","0:v:0","-map","[aout]","-c:v","copy","-c:a","aac","-b:a","192k","-t",f"{actual_duration:.5f}","-movflags","+faststart",str(output_final)]
            if os.environ.get("JUYA_DEBUG_AUDIO"):
                print("AUDIO_FILTER="+";".join(f for f in filters if f), file=sys.stderr)
                print("AUDIO_COMMAND="+" ".join(command), file=sys.stderr)
            run(command)
        return
    filters.append("".join(layers)+f"amix=inputs={len(layers)}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.96[aout]")
    command += ["-filter_complex",";".join(f for f in filters if f),"-map","0:v:0","-map","[aout]","-c:v","copy","-c:a","aac","-b:a","192k","-t",f"{actual_duration:.5f}","-movflags","+faststart",str(output_final)]
    if os.environ.get("JUYA_DEBUG_AUDIO"):
        print("AUDIO_FILTER="+";".join(f for f in filters if f), file=sys.stderr)
        print("AUDIO_COMMAND="+" ".join(command), file=sys.stderr)
    run(command)

def choose_music(tracks, seed:int):
    if not tracks: return []
    names=[str(t.get("name","")).strip().casefold() for t in tracks]
    if any(not n for n in names): raise RenderError("every music track requires a name")
    if len(set(names))!=len(names): raise RenderError("music track names must be unique")
    ids=[str(t.get("id","")).strip().casefold() for t in tracks if t.get("id")]
    if len(set(ids))!=len(ids): raise RenderError("music track ids must be unique")
    def norm(value):
        value=unicodedata.normalize("NFKC",str(value)).casefold()
        value=Path(value).stem
        return re.sub(r"[^a-z0-9]+"," ",value).strip()
    explicitly_marked=[t for t in tracks if t.get("opening") is True or str(t.get("role","")).casefold()=="opening" or norm(t.get("id",""))=="boring life"]
    if len(explicitly_marked)>1: raise RenderError("exactly one BGM may be marked opening")
    matches=[]
    for t in tracks:
        candidates=[norm(t.get("name","")),norm(t.get("path","")),norm(t.get("id",""))]
        if any(value=="boring life" or value.startswith("boring life ") for value in candidates): matches.append(t)
    if explicitly_marked:
        first=explicitly_marked[0]
        if matches and any(t is not first for t in matches): raise RenderError("music opening marker conflicts with another boring life track candidate")
    else:
        if len(matches)!=1: raise RenderError("music_tracks must have exactly one first track named with a 'boring life' filename/title (or mark one with opening:true)")
        first=matches[0]
    rest=[t for t in tracks if t is not first]
    random.Random(seed).shuffle(rest)
    return [first]+rest

def validate(manifest,root, args):
    if manifest.get("schema_version") not in (1,"1"): raise RenderError("schema_version must be 1")
    if manifest.get("language") not in ("zh","en","zh-CN","en-US"): raise RenderError("language must be zh / en (or zh-CN / en-US)")
    if not isinstance(manifest.get("themes"),list) or len(manifest["themes"])<1: raise RenderError("themes must be a non-empty list")
    if args.fps != 30: raise RenderError("fps is fixed at 30 for the requested cut")
    section_ids={str(s.get("id")) for s in manifest.get("sections",[]) if s.get("id")}
    manifest["fps"]=args.fps
    if float(manifest.get("opening_seconds",5)) != 5.0: raise RenderError("opening_seconds is fixed to 5 for this requested layout")
    if float(manifest.get("theme_gap_seconds",.5)) != .5: raise RenderError("theme_gap_seconds is fixed to 0.5 for this requested layout")
    if float(manifest.get("narration_speed",1.3)) != 1.3:
        raise RenderError("narration_speed is fixed at 1.3 for the requested cut; update the manifest value to 1.3")
    local_path(root,manifest.get("opening_narration"),"opening_narration")
    for i,t in enumerate(manifest["themes"]):
        if not t.get("title"): raise RenderError(f"theme[{i}] requires title")
        if t.get("section_id") and section_ids and str(t["section_id"]) not in section_ids:
            raise RenderError(f"theme[{i}].section_id {t['section_id']!r} is not present in sections")
        if not t.get("duration_seconds"): t["duration_seconds"]=7
        t["duration_seconds"]=float(t["duration_seconds"]); t["card_seconds"]=float(t.get("card_seconds",5))
        if t["card_seconds"]<=0 or t["duration_seconds"]<t["card_seconds"]:
            raise RenderError(f"theme[{i}] duration_seconds must be at least its positive card_seconds")
        for k in ("card_image","card_html","media","media_video","narration"): local_path(root,t.get(k),f"theme[{i}].{k}")
        if bool(t.get("media")) == bool(t.get("media_video")): raise RenderError(f"theme[{i}] requires exactly one of media or media_video (local image/video popup)")
        for ci,c in enumerate(t.get("captions",[])):
            if not c.get("text"): raise RenderError(f"theme[{i}].captions[{ci}] requires complete sentence text")
            if float(c.get("end",0))<=float(c.get("start",0)): raise RenderError(f"theme[{i}].captions[{ci}] end must exceed start")
            if ci and float(c.get("start",0))<float(t["captions"][ci-1].get("end",0)):
                raise RenderError(f"theme[{i}].captions must be ordered and non-overlapping")
    for ci,c in enumerate(manifest.get("opening_captions",[])):
        if not c.get("text") or float(c.get("end",0))<=float(c.get("start",0)):
            raise RenderError(f"opening_captions[{ci}] needs full text and an increasing start/end interval")
    for i,m in enumerate(manifest.get("music_tracks",[])):
        local_path(root,m.get("path"),f"music_tracks[{i}].path",True)
        if not m.get("name"): raise RenderError(f"music_tracks[{i}].name is required")
    if manifest.get("music_tracks"):
        names=[str(m.get("name","")).strip().casefold() for m in manifest["music_tracks"]]
        if len(set(names))!=len(names): raise RenderError("music track names must be unique")
        ids=[str(m.get("id","")).strip().casefold() for m in manifest["music_tracks"] if m.get("id")]
        if len(set(ids))!=len(ids): raise RenderError("music track ids must be unique")
    assets=inspect_publication(manifest,args,root)
    return assets

def render(manifest_path:Path, outdir:Path, args):
    manifest_path=manifest_path.resolve(); root=manifest_path.parent
    try: manifest=json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception as e: raise RenderError(f"could not read JSON manifest: {e}") from e
    assets=validate(manifest,root,args); seed=args.seed if args.seed is not None else int(manifest.get("music_seed",0))
    order=choose_music(manifest.get("music_tracks",[]),seed); order_names=[str(t.get("name")) for t in order]
    width,height=args.width,args.height; fps=args.fps
    if width%2 or height%2: raise RenderError("width and height must be even for H.264 yuv420p")
    if width<160 or height<90: raise RenderError("render size must be at least 160x90")
    if width*9 != height*16: raise RenderError("width and height must preserve 16:9 layout proportions")
    outdir.mkdir(parents=True,exist_ok=True)
    name=args.name or manifest.get("output_name") or f"{manifest.get('episode_id','juya-evening')}-{manifest.get('language','zh')}"
    name="".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in name).strip("-") or "juya-evening"
    final=outdir/f"{name}.mp4"; sidecar=outdir/f"{name}.manifest.json"; status_path=outdir/f"{name}.status.json"
    run_tag=f"{os.getpid()}-{int(time.time()*1000)}"
    staged=outdir/f".{name}.{run_tag}.staging.mp4"; silent=outdir/f".{name}.{run_tag}.silent.mp4"
    staged_manifest=outdir/f".{name}.{run_tag}.manifest.tmp"; staged_status=outdir/f".{name}.{run_tag}.status.tmp"
    failed_tmp=outdir/f".{name}.{run_tag}.failed.tmp"
    related=[final,sidecar,status_path]
    existing=[str(p) for p in related if p.exists()]
    if existing and not args.overwrite:
        raise RenderError("refusing to overwrite existing output; pass --overwrite explicitly: "+", ".join(existing))
    started=time.time(); final_replaced=False
    try:
        total,timeline=build_silent_video(manifest,root,silent,width,height,fps)
        mix_audio(manifest,root,silent,staged,total,timeline,seed,order)
        silent.unlink(missing_ok=True)
        probe=json.loads(run(["ffprobe","-v","error","-show_streams","-show_format","-of","json",str(staged)]).stdout)
        snapshot=json.loads(json.dumps(manifest))
        for theme in snapshot.get("themes",[]):
            theme.pop("_timeline_start",None); theme.pop("_section_progress",None)
        for asset in assets:
            asset["sha256"]=sha256_file(Path(asset["path"]))
        metadata={
            "schema_version":1,"renderer":"juya-evening-video","renderer_version":VERSION,
            "source_manifest_path":str(manifest_path),"source_manifest_sha256":sha256_file(manifest_path),
            "source_manifest_snapshot":snapshot,"output":str(final),"language":manifest["language"],
            "resolution":{"width":width,"height":height},"fps":fps,
            "duration_seconds":float(probe["format"]["duration"]),
            "opening_seconds":float(manifest.get("opening_seconds",5)),"theme_gap_seconds":float(manifest.get("theme_gap_seconds",.5)),
            "narration_speed":1.3,"host_line":manifest.get("host_line","大家好，我是小鱼是木鱼，以上是今天具身智能动态"),
            "music_seed":seed,"music_order":order_names,
            "music":("enabled" if order else "none; no BGM was supplied"),
            "sfx":"locally synthesized page-turn tones between themes",
            "publication_ready":bool(args.publication_ready),"license_declarations_independently_verified":False,
            "asset_licenses":assets,
            "timeline":[{"kind":k,"index":i,"start_seconds":round(s,3),"end_seconds":round(e,3)} for s,e,k,i in timeline],
            "sha256":sha256_file(staged),"ffprobe":probe,
            "render_elapsed_seconds":round(time.time()-started,2),
        }
        status={"status":"complete","output":str(final),"sha256":metadata["sha256"],"publication_ready":bool(args.publication_ready),"audio":{"narration_speed":1.3,"music":metadata["music"],"music_order":order_names}}
        staged_manifest.write_text(json.dumps(metadata,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
        staged_status.write_text(json.dumps(status,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
        os.replace(staged,final); final_replaced=True
        os.replace(staged_manifest,sidecar)
        os.replace(staged_status,status_path)
        return metadata
    except Exception as e:
        # A render/encode failure before commit keeps the old MP4+sidecars intact.
        # If the MP4 swap succeeded but a sidecar swap failed, never leave a stale "complete" marker.
        if final_replaced:
            failed={"status":"failed","output":str(final),"reason":str(e),"previous_complete_marker_invalidated":True}
            try:
                failed_tmp.write_text(json.dumps(failed,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
                os.replace(failed_tmp,status_path)
            except Exception:
                pass
        raise
    finally:
        silent.unlink(missing_ok=True); staged.unlink(missing_ok=True)
        staged_manifest.unlink(missing_ok=True); staged_status.unlink(missing_ok=True); failed_tmp.unlink(missing_ok=True)

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument("manifest",type=Path,help="path to input JSON manifest (assets are local/relative)")
    ap.add_argument("--output-dir",type=Path,default=Path("output"))
    ap.add_argument("--name")
    ap.add_argument("--seed",type=int)
    ap.add_argument("--overwrite",action="store_true",help="replace existing MP4 and sidecar files with the same output name")
    ap.add_argument("--publication-ready",action="store_true",help="fail closed unless all included assets have an approved license status")
    ap.add_argument("--width",type=int,default=1920); ap.add_argument("--height",type=int,default=1080)
    ap.add_argument("--fps",type=int,default=FPS_DEFAULT)
    args=ap.parse_args()
    try:
        meta=render(args.manifest,args.output_dir,args)
        print(json.dumps({"status":"complete","output":meta["output"],"sha256":meta["sha256"],"duration_seconds":meta["duration_seconds"],"resolution":meta["resolution"],"fps":meta["fps"],"music_order":meta["music_order"],"manifest":str(args.output_dir/f"{Path(meta['output']).stem}.manifest.json")},ensure_ascii=False,indent=2))
    except RenderError as e:
        print(f"render error: {e}",file=sys.stderr); return 2
    return 0

if __name__=="__main__": raise SystemExit(main())
