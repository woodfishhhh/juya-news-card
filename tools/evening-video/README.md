# Juya evening video renderer (new offline implementation)

This is a new, standalone offline renderer written for the `juya-recovery` work area. It is not recovered source from the vanished Juya project, does not copy the prior renderer, and does not claim compatibility with its internals. It accepts the existing workflow's rendered card PNGs, or local HTML card files captured with the machine's Chromium, and builds the evening-video timeline around those assets. It never contacts the network or uploads/publishes a video.

The original Juya card/video implementation is not included here. This independent tool and its demo assets are new additions requested after the old workspace could not be recovered. It can be transplanted into the repository under `tools/evening-video/` after review. The optional `.mjs` entry point is only a Node ESM wrapper; the renderer is Python and is not part of the Next/React runtime.

## Requirements

- Python 3.10+
- Pillow (`python3 -m pip install Pillow`)
- FFmpeg and FFprobe on `PATH`
- Optional for `card_html`: Python Playwright and `/usr/bin/chromium` (Chromium must be permitted to launch in the execution environment)
- Optional Node 20+ for the `render-evening.mjs` wrapper

No package install, CDN, network request, external font download, TTS service, or video library is used. Font fallback checks local Noto CJK / DejaVu system font locations.

## Run

From this directory, render at production dimensions (1920x1080, 30 fps):

```sh
python3 render_evening.py demo/manifest.zh.json --output-dir output --seed 17
# or, through the repository's Node ESM command surface
node render-evening.mjs demo/manifest.zh.json --output-dir output --seed 17
```

Rerunning a fixed name only replaces existing outputs when you add `--overwrite`. New renders are written and probed under unique staging names first; a failed render preserves the previous MP4 and its completion status.

To exercise English input, use `demo/manifest.en.json`. The two manifests use the same local demo assets and schema. A smaller render is convenient for tests:

```sh
python3 render_evening.py demo/manifest.zh.json --output-dir demo/output --width 320 --height 180 --fps 30 --seed 17
```

The CLI writes an MP4, a generated `<name>.manifest.json` containing the input-manifest snapshot, source asset hashes, resolved timeline, ffprobe details, declared license statuses/evidence, music order and output SHA-256, plus a `<name>.status.json`. Existing fixed-name MP4/sidecar files are never overwritten unless `--overwrite` is passed. The default is a private preview. To test the stricter publication gate:

```sh
python3 render_evening.py demo/manifest.zh.json --output-dir output --publication-ready
```

That command deliberately fails on the demo's `unknown` license entries. Add an evidence-backed `license.status` of `licensed`, `public_domain`, `cc0`, or `creative_commons` and a non-empty `license.evidence` reference for every real included asset before using publication-ready mode. The status and evidence are user declarations; the renderer records them but does not independently verify rights. No license is inferred from a source URL or filename. Publication-ready is a local validation flag, not authorization to publish or upload.

## Timeline and layout

- A 5-second opening overview shows the configured episode title, overview, and the exact host line `大家好，我是小鱼是木鱼，以上是今天具身智能动态`. An optional manifest-relative `opening_card_image` PNG replaces that generated opening layout; opening captions, when supplied, are still drawn over it in the existing bottom subtitle-safe area. Manifests without the new field retain the previous generated opening unchanged.
- Each theme's card is visible for 5 seconds by default and in the supplied preset; a manifest may set a different `card_seconds`. Its local image or looping local video popup appears afterward in the 1520x830 production rectangle at x=200, y=64 (preserving aspect ratio). `duration_seconds` is the full theme duration, including the initial card period.
- Themes are separated by exactly a 0.5-second white transition with navigation hidden. Cards fade in/out over 0.25 seconds, and each theme boundary gets a locally synthesized short page-turn tone.
- Section navigation is 27px and event navigation 23px at 1920x1080. Current section/event highlight, within-section progress, and current-event progress update over time. `card_has_chrome: true` masks the source PNG's existing header, footer, and caption strip before drawing updated navigation and captions.
- Captions are complete sentences using source-narration timings. They are mapped to the requested 1.3x playback rate and rendered in no more than two lines, above the bottom navigation: caption box bottom is at y=1008; the bottom nav starts at y=1024. If a full sentence cannot fit after font reduction, rendering errors instead of truncating it.
- The renderer applies actual FFmpeg `atempo=1.3` to provided opening/theme narration and divides source caption times by the same speed. The demo's WAVs are audible synthetic sine tones only, not Mandarin or English speech. The quoted host line is included as script/caption text; to hear it spoken, provide a real local opening narration recording and its caption timing. No voice is synthesized.
- With no `music_tracks`, output contains no BGM and reports that clearly. When tracks are supplied, mark one `opening: true` or use a unique title/filename whose stem starts with `boring life` (for example `boring life demo.wav`); it is fixed first, other uniquely named local tracks are shuffled deterministically using the seed, and the final order is saved in the metadata. The selected list is assigned across themes in order. The test generator makes three synthetic BGM tones only for an explicit BGM-mix smoke test; they are not in the default demo manifests and are never auto-added by the renderer.
- Output must use a 16:9 width/height ratio. The requested 1920x1080/30fps preset is the CLI default; smaller 16:9 dimensions are supported for fast tests.

## Manifest shape

All asset paths are local paths relative to the input manifest. URLs and paths escaping the manifest directory are rejected. Example fields (the complete runnable sample is in `demo/manifest.zh.json`):

```json
{
  "schema_version": 1,
  "language": "zh",
  "episode_title": "具身智能动态",
  "overview": "本期概览文字",
  "host_line": "大家好，我是小鱼是木鱼，以上是今天具身智能动态",
  "opening_seconds": 5,
  "theme_gap_seconds": 0.5,
    "narration_speed": 1.3,
    "opening_card_image": "assets/overview.png",
    "opening_card_license": {"status":"unknown", "evidence":"source/license reference"},
  "sections": [{"id":"news", "title":"要闻"}],
  "themes": [{
    "title":"示例主题", "event_title":"示例事件", "section_id":"news",
    "card_image":"assets/card.png", "card_has_chrome":false,
    "media":"assets/popup.png", "card_seconds":5, "duration_seconds":8,
    "narration":"assets/voice.wav",
    "captions":[{"start":0,"end":2.6,"text":"一整句字幕。"}],
    "license":{"status":"unknown", "evidence":"source/license reference"}
  }],
  "music_tracks": []
}
```

Each theme must specify exactly one of `media` (local still image) or `media_video` (local video). `card_image` is an existing generated PNG. If omitted, a simple card is generated from title/source fields. Alternatively, `card_html` names a local HTML file and is captured using Playwright plus local Chromium. HTML navigation is restricted to `file:` files under the manifest directory plus `data:`/`blob:` requests; other resources are aborted, and Chromium gets DNS/network-blocking flags. Some sandboxes prohibit Chromium launch; PNG input does not depend on Chromium. Optional `opening_card_image` is a manifest-relative local PNG for the 5-second overview; its `opening_card_license` is recorded as a card asset. Optional `opening_narration`, `opening_captions`, and `opening_license` accept the opening voice track and source-time sentence captions. A theme-level `license` applies to its card/media/narration by default; `licenses.card` / `card_license`, `licenses.media` / `media_license`, and `licenses.narration` / `narration_license` can declare separate asset rights. Each used local card/media/narration/music asset is recorded separately in output metadata. The renderer is intentionally fail-closed on external asset URLs.

## Test

```sh
python3 demo/make_demo.py
python3 -m unittest discover -s tests -v
ffprobe -v error -show_streams -show_format demo/output/juya-evening-demo-zh.mp4
```

The test generator creates original cards, popup images, synthetic voice-tone WAVs, and separate synthetic BGM mix-test WAVs under `demo/assets/`; these are ignored build products and are not committed. The tests render the default no-BGM demo and a separate supplied-BGM variant in both zh/en at 320x180/30fps; they check the card window, popup onset, 0.5-second white gap, section/event navigation state, full sentence wrapping, actual 1.3x audio shortening, BGM fixed-first seeded order and mixing, FFprobe metadata, complete decode, output collision protection, and the private-preview/publication-ready license gate. The optional local HTML card test is skipped if the host sandbox denies Chromium launch; this does not affect PNG-based renders. Demo input licenses are intentionally `unknown`; they're locally self-created test inputs, not publication assets.
