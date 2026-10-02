#!/usr/bin/env python3
"""Create deterministic, original offline-only test inputs; no downloaded assets."""
from pathlib import Path
import os, subprocess, sys
from PIL import Image, ImageDraw, ImageFont
ROOT=Path(__file__).resolve().parent; A=ROOT/'assets'; A.mkdir(parents=True,exist_ok=True)
FONT='/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'
def temporary_path(dest):
    return dest.with_name(f'.{dest.stem}.{os.getpid()}.tmp{dest.suffix}')

def atomic_save_image(image,dest):
    tmp=temporary_path(dest)
    try: image.save(tmp); os.replace(tmp,dest)
    finally: tmp.unlink(missing_ok=True)

def atomic_ffmpeg(dest,args):
    tmp=temporary_path(dest)
    try:
        command=[str(tmp) if arg==str(dest) else arg for arg in args]
        subprocess.run(command,check=True); os.replace(tmp,dest)
    finally: tmp.unlink(missing_ok=True)
def font(n):
    try:return ImageFont.truetype(FONT,n)
    except:return ImageFont.load_default()
for name, bg, accent, title, body in [
    ('theme-robot',(245,242,237),(187,91,69),'机器人研究','本地合成演示卡片'),
    ('theme-open',(241,246,244),(60,139,128),'开源项目','仅用于验证分段、导航与字幕')]:
    im=Image.new('RGB',(1920,1080),bg); d=ImageDraw.Draw(im)
    d.rounded_rectangle((205,210,1715,875),radius=32,fill=(255,255,255),outline=(224,219,212),width=3)
    d.text((300,310),title,font=font(86),fill=accent)
    d.text((305,460),body,font=font(48),fill=(55,55,55))
    d.text((305,760),'JUYA OFFLINE RENDER TEST',font=font(28),fill=(130,125,118))
    atomic_save_image(im,A/f'{name}.png')
for name, color, label in [('media-robot',(51,130,170),'本地测试画面 A'),('media-open',(211,115,61),'本地测试画面 B')]:
    im=Image.new('RGB',(1280,700),color); d=ImageDraw.Draw(im)
    d.ellipse((440,130,840,530),outline=(255,255,255),width=14)
    d.text((430,570),label,font=font(52),fill='white')
    atomic_save_image(im,A/f'{name}.png')
# A tiny generated video keeps the first popup on the actual local-video decoder path;
# the second theme remains a still image so both supported media forms are exercised.
atomic_ffmpeg(A/'media-robot-demo.mp4',['ffmpeg','-y','-hide_banner','-loglevel','error','-loop','1','-framerate','30','-i',str(A/'media-robot.png'),'-t','3','-an','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',str(A/'media-robot-demo.mp4')])
# Audible synthetic tones verify actual narration speed without pretending to be Mandarin speech.
for name, freq in [('narration-robot',440),('narration-open',620)]:
    atomic_ffmpeg(A/f'{name}.wav',['ffmpeg','-y','-hide_banner','-loglevel','error','-f','lavfi','-i',f'sine=frequency={freq}:duration=2.6','-af','volume=0.65','-ar','48000','-ac','1',str(A/f'{name}.wav')])
atomic_ffmpeg(A/'opening-tone.wav',['ffmpeg','-y','-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=330:duration=2.6','-af','volume=0.55','-ar','48000','-ac','1',str(A/'opening-tone.wav')])
# Optional local BGM smoke-test inputs. They are synthetic, private test files and are
# deliberately absent from both runnable sample manifests' music_tracks arrays.
for name, freq in [('boring life demo.wav',110),('wind chime demo.wav',183),('soft pulse demo.wav',247)]:
    atomic_ffmpeg(A/name,['ffmpeg','-y','-hide_banner','-loglevel','error','-f','lavfi','-i',f'sine=frequency={freq}:duration=4','-af','volume=0.3','-ar','48000','-ac','2',str(A/name)])
print('created original synthetic demo assets in',A)
