# Embodied Evening Video Production Specification

## Status and boundary

This is a recovered production specification only. This repository currently has no executable video renderer integrated for it. The specification and preset do not restore source code, assets, permissions, or a working render pipeline.

The companion preset is [config/embodied-evening-video.preset.json](../config/embodied-evening-video.preset.json). This document and preset record intended behavior; they do not claim that any of it is implemented.

## Output and editorial flow

- Render target: 1920 × 1080 pixels at 30 frames per second.
- Produce separate Chinese and English scripts. Keep topic order and resolved background-music order identical between language versions.
- Cover broadly relevant embodied-intelligence developments, including robot demonstrations, model and paper releases, companies, open-source projects, autonomous driving, and adjacent topics.
- Open with this exact Chinese narration: “大家好，我是小鱼是木鱼，以上是今天具身智能动态”. Preserve “以上” exactly; do not change it to “以下”.
- Follow with a 5-second episode overview. Sort topics by viewer interest/highlights for the episode.
- Use one topic per page and 3–4 key points on each topic page.
- Show the card for 5 seconds before opening its material popup.
- The material popup is 1520 × 830 pixels, with its top edge at y = 64 pixels. It must stay within the top edge of the frame and is allowed to cover the page title.

## Navigation, page changes, and subtitles

- Top board/section navigation uses 27 px text, highlights the current section, and shows progress within that section.
- Bottom company/event navigation uses 23 px text and highlights the current item.
- During the 0.5-second white-page gap on a page change, hide both navigation bars. At 30 fps the blank white gap is 15 frames.
- Page changes use fade-out and fade-in with a sound effect. Fade durations are not specified here.
- Write subtitles as complete sentences and show no more than two lines at once.
- Keep subtitle bottoms at or above y = 1008 pixels; the bottom navigation is at y = 1024 pixels.
- If a sentence is too long, rewrite or shorten it while preserving meaning. Never mechanically truncate a sentence to force it to fit.

## Audio and typography

- Set narration speed to 1.3×.
- Start background music with “boring life - db,Beteulan,BD DISCOMUSIC.mp3”. Choose later tracks at random, and persist both the random seed and the resolved track order so the Chinese and English versions use the same sequence.
- Use 80 px for topic titles, 42 px for card text, and 34 px for body text.
- The mobile preview must prevent text overflow.

## Source facts and asset rights

- Keep each story’s original publication date separate from its collection time. Do not collapse these into one date; record uncertainty explicitly when either is unknown.
- Treat image, video, and music permissions as unknown unless verified. Do not claim ownership or permission, and do not reuse or publish an asset without rights review.

## Historical sample order only

The following is only the sample topic order for the historical 9.30–10.1 episode. The year is unspecified. It is not an evergreen ordering rule:

1. Figure F02
2. Horizon HSD
3. DoorDash Air
4. HomeBody
5. EgoAlign
6. Reachy Mini
7. AGIBOT IDC
8. Galbot

## Verification boundary

The preset is checked with strict JSON parsing and a consistency check against this document. Those checks cover preset syntax and specification values only. They do not execute or validate a renderer.
