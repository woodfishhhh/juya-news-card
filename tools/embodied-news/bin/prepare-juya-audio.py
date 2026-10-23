"""Direct whole-paragraph TTS and build continuous, provider-aligned manifests."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import random
import shutil
import subprocess
import wave
import time
from juya_captions import provider_captions
from minimax_directing import paragraph
from juya_media import schedule_bound_media
from juya_production import make_page_turn

RATE = 32000
PARAMS = {"model": "speech-2.8-turbo", "voice": "Podcast_girl", "region": "cn",
          "speed": 1.0, "pitch": 0, "sampleRate": RATE, "bitrate": 128000, "channels": 1}


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_json(path, obj):
    Path(path).write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def command(args):
    result = subprocess.run([str(x) for x in args], capture_output=True, check=False, timeout=195)
    if result.returncode:
        # Do not echo command-line configuration or credential files.
        raise RuntimeError(f"{Path(str(args[0])).name} exited {result.returncode}: "
                           + result.stderr.decode("utf-8", errors="replace")[-1500:])
    return result.stdout


def pcm(path):
    return command(["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(RATE),
                    "-f", "s16le", "pipe:1"])


def render_duration(path):
    # Measure the exact single-tempo output length used by the final mixer.
    data=command(['ffmpeg','-v','error','-i',path,'-af','atempo=1.3',
                  '-ar','48000','-ac','2','-f','f32le','pipe:1'])
    return len(data)/8/48000


def music(root, source, seed, needed):
    existing = root / "music-order.json"
    if existing.exists():
        saved = json.loads(existing.read_text(encoding="utf-8"))
        for item in saved["tracks"]:
            if digest(root / item["path"]) != item["sha256"]:
                raise RuntimeError("Saved music track hash mismatch")
        if sum(item["duration"] for item in saved["tracks"]) >= needed + 2:
            return saved["tracks"]
    files = sorted(source.glob("*.mp3"), key=lambda path: path.name.casefold())
    first = [path for path in files if path.stem.casefold().startswith("boring life")]
    if len(first) != 1:
        raise RuntimeError("Expected one fixed boring life opening track")
    later = [path for path in files if path != first[0]]
    random.Random(seed).shuffle(later)
    tracks, total = [], 0.0
    for index, path in enumerate(first + later):
        target = root / "assets/music" / path.name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
        probe = json.loads(command(["ffprobe", "-v", "error", "-show_format", "-of", "json", target]))
        duration = float(probe["format"]["duration"])
        tracks.append({"path": str(target.relative_to(root)).replace("\\", "/"), "name": path.stem,
                       "opening": index == 0, "sha256": digest(target), "duration": duration,
                       "license": {"status": "unknown", "evidence": "User-specified repository BGM; no independent public redistribution license asserted."}})
        total += duration
        if total >= needed + 2:
            break
    write_json(existing, {"seed": seed, "tracks": tracks, "duration": total, "needed": needed})
    return tracks


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("content", type=Path)
    parser.add_argument("--music-root", type=Path, required=True)
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument('--locale',choices=['zh','en','all'],default='all')
    args = parser.parse_args()
    if os.name == "nt" and not shutil.which("ffmpeg"):
        packages = Path(os.environ["LOCALAPPDATA"]) / "Microsoft/WinGet/Packages"
        candidates = sorted(packages.glob("Gyan.FFmpeg_*/ffmpeg-*/bin/ffmpeg.exe"))
        if not candidates:
            raise RuntimeError("FFmpeg runtime is missing")
        os.environ["PATH"] = str(candidates[-1].parent) + os.pathsep + os.environ["PATH"]
    root = args.content.resolve().parent
    content = json.loads(args.content.read_text(encoding="utf-8"))
    # Fail before paid TTS if media has no explicit, text-checked narration bindings.
    for theme in content['themes']:
        for locale,script in theme['versions'].items():
            if args.locale!='all' and locale!=args.locale:continue
            items=theme.get('mediaSequences',{}).get(locale,theme.get('mediaSequence',[]))
            if not items:raise ValueError('Author sentence-bound media before preparing audio')
            for item in items:
                b=item.get('binding',{});i=b.get('sentence')
                if type(i) is not int or not 0<=i<len(script['sentences']) or b.get('text')!=script['sentences'][i]:
                    raise ValueError('Missing or stale media binding: '+theme['id']+'/'+locale)
    make_page_turn(root/'audio/page-turn.wav')
    node = Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "nodejs/node.exe"
    mmx = Path(os.environ["APPDATA"]) / "npm/node_modules/mmx-cli/dist/mmx.mjs"
    if not node.is_file() or not mmx.is_file():
        raise RuntimeError("Existing Node/mmx-cli runtime is missing")
    manifests, durations = [], []
    for locale, version in content["versions"].items():
        if args.locale != 'all' and locale != args.locale:
            continue
        language = "Chinese" if locale == "zh" else "English"
        opening, opening_cues, opening_duration, opening_words = paragraph(root, f"{locale}-opening",
            [version["hostLine"]], language, node)
        opening_seconds=max(opening_duration/1.3,render_duration(root/opening))
        opening_phrases, opening_alignment = provider_captions(opening_cues, opening_words, locale)
        closing, closing_cues, closing_duration, closing_words = paragraph(root, f"{locale}-closing",
            [version["closingLine"]], language, node)
        closing_phrases, closing_alignment = provider_captions(closing_cues, closing_words, locale)
        closing_seconds=max(closing_duration/1.3,render_duration(root/closing))+.12
        alignment={'opening':opening_alignment,'closing':closing_alignment,'themes':[]}
        themes = []
        for index, theme in enumerate(content["themes"]):
            script = theme["versions"][locale]
            name = f"{locale}-{index + 1:02d}-{theme['id']}"
            narration, cues, duration, words = paragraph(root, name, script["sentences"], language, node)
            phrases, phrase_alignment = provider_captions(cues,words,locale)
            alignment['themes'].append({'id':theme['id'],**phrase_alignment})
            item = {"title": script["title"], "event_title": script["nav"],
                    "section_id": theme["section"], "card_image": f"cards/{locale}/card-{index + 2:02d}.png",
                    "card_has_chrome": False, "card_seconds": 2.5,
                    "closing_card_seconds":2.5,"media_layout":"continuous-bookends",
                    "narration_offset_seconds": 0,
                    "duration_seconds": max(duration / 1.3,render_duration(root/narration)),
                    "narration": narration, "narration_captions": cues, "captions": phrases,
                    "source": theme["sourceName"], "source_url": theme["url"],
                    "license": {"status": "unknown", "evidence": "Private review; asset rights recorded in evidence/."}}
            item[theme.get("mediaKind", "media")] = theme["media"]
            item['media_sequence']=schedule_bound_media(theme.get('mediaSequences',{}).get(locale,theme.get('mediaSequence',[])),cues,item['duration_seconds'])
            themes.append(item)
        duration = opening_seconds + sum(item["duration_seconds"] for item in themes) + .5*max(0,len(themes)-1) + closing_seconds
        durations.append(duration)
        manifests.append((locale, {"schema_version": 1, "language": locale, "media_binding_policy": "sentence-v1",
            "episode_title": version["episodeTitle"], "overview": version["overview"],
            "host_line": version["hostLine"], "opening_seconds": opening_seconds,
            "opening_narration": opening, "opening_captions": opening_phrases,
            "opening_narration_captions": opening_cues,
            "closing_line": version['closingLine'], "closing_seconds":closing_seconds,
            "closing_narration":closing, "closing_audio_offset":0,
            "closing_captions":closing_phrases, "closing_narration_captions":closing_cues,
            "opening_card_image": f"cards/{locale}/card-01.png",
            "opening_card_license": {"status": "licensed", "evidence": "Original editorial card generated for this episode"},
            "opening_license": {"status": "unknown", "evidence": "User-authorized MiniMax voice generation"},
            "narration_speed": 1.3, "theme_gap_seconds": .5, "transition_mode":"page-turn",
            "media_layout":"continuous-bookends",
            "transition_sound":"audio/page-turn.wav",
            "sections": version["sections"], "themes": themes, "music_tracks": []}))
        write_json(root/f'audio/phrase-alignment.{locale}.json',alignment)
    tracks = music(root, args.music_root, args.seed, max(durations))
    for index, track in enumerate(tracks):
        track['resolved_index'] = index
    for locale, manifest in manifests:
        manifest["music_tracks"] = tracks
        write_json(root / f"manifest.{locale}.json", manifest)
    write_json(root / "audio/preparation.json",
               {"status": "audio_ready", "parameters": PARAMS, "renderSpeed": 1.3,
                "estimatedVideoDurationsFromDecodedAudio": dict(zip([locale for locale,_ in manifests], durations)),
                "contentSha256": digest(args.content), "musicSeed": args.seed})
    print(json.dumps({"status": "audio_ready", "durations": durations}, ensure_ascii=False))


if __name__ == "__main__":
    main()
