# Embodied Evening Video Production Specification

## Implementation status and boundary

The production specification has been recovered as written requirements, and a new independent offline renderer now exists under tools/evening-video. That renderer is standalone Python/Pillow/FFmpeg software with an optional Node ESM launcher. It is not recovered source from the vanished Juya renderer and is not integrated into the Next/React application.

The renderer consumes supplied card PNGs or local HTML cards, popup still/video assets, and optional local narration and music. It does not gather news, rank stories, generate the editorial script or original news cards, synthesize speech, or upload/publish. No pixel-level comparison against the prior final videos was performed, so pixel equivalence is not established or claimed.

The companion [preset](../config/embodied-evening-video.preset.json) records the intended production values and known implementation limits.

## Output and editorial flow

- Production target: 1920 × 1080 pixels at 30 frames per second, with a 16:9 aspect ratio.
- Prepare separate Chinese and English scripts. Supply both manifests in the same topic order and use the same resolved background-music order in both language renders.
- Cover broadly relevant embodied-intelligence developments, including robot demonstrations, model and paper releases, companies, open-source projects, autonomous driving, and adjacent topics.
- Order themes by viewer interest/highlights before rendering; the renderer preserves manifest order rather than sorting stories.
- Open with this exact Chinese narration: “大家好，我是小鱼是木鱼，以上是今天具身智能动态”. Preserve “以上” exactly; do not change it to “以下”.
- Follow with a 5-second episode overview.
- Use one topic per page with 3–4 key points. The renderer uses provided card artwork; it does not create or validate the story points.
- The renderer defaults to showing each card for 5 seconds before its material popup. A theme manifest can override card_seconds; set it to 5 for this preset.
- The popup is 1520 × 830 pixels with its top edge at y = 64 pixels. It stays within the top edge of the frame and may cover the page title.

## Navigation, page changes, and subtitles

- Top board/section navigation uses 27 px text, highlights the current section, and shows progress within that section.
- Bottom company/event navigation uses 23 px text, highlights the current item, and shows item progress.
- During the 0.5-second white-page gap on page changes, hide both navigation bars. At 30 fps, the blank white gap is 15 frames.
- Page changes use fade-out and fade-in with a sound effect. Fade durations are not specified by this production brief.
- Write subtitles as complete sentences and show no more than two lines at once.
- Keep subtitle bottoms at or above y = 1008 pixels; the bottom navigation begins at y = 1024 pixels.
- If a sentence is too long, rewrite or shorten it while preserving meaning. Never mechanically truncate it. The renderer preserves all caption characters and fails if the full sentence cannot fit; semantic editing must happen before rendering.

## Audio and typography

- Set narration speed to 1.3×. The renderer applies FFmpeg atempo=1.3 to supplied narration and maps source-time captions to that rate.
- Start background music with “boring life - db,Beteulan,BD DISCOMUSIC.mp3”. Choose later tracks at random with a saved seed and resolved order, then use that same order for the Chinese and English versions. The requested track is not included in the repository or demo; synthetic tracks are used only to exercise the mix path.
- Use 80 px for topic titles, 42 px for card text, and 34 px for body text in authored card art. The independent renderer uses supplied PNG/HTML card art; its convenience fallback is a simple title card and does not reproduce the former renderer's typography.
- Keep text from overflowing in a mobile preview. This standalone renderer has no mobile-preview UI or viewport QA; fitting/error checks during 16:9 video rendering do not establish mobile-preview behavior.

## Source facts and asset rights

- Keep each story’s original publication date separate from its collection time. Record uncertainty explicitly when either is unknown. The renderer does not extract or validate those story dates; editors must preserve this distinction in the source briefing.
- Treat image, video, narration, and music permissions as unknown unless verified. Do not claim ownership or permission, and do not reuse or publish an asset without rights review.
- The renderer requires a declared license status and non-empty evidence reference for publication-ready validation, but it only records user declarations and does not independently verify rights. Passing this local validation flag does not authorize publishing or uploading.

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

The final renderer suite has 14 test cases: 13 pass and 1 is skipped because this sandbox denied Chromium's IPC socket, so the optional local HTML capture path remains unverified. Bilingual caption-geometry regressions cover Chinese and English in both one-line and two-line layouts, including actual glyph and backing-plate bounds.

The automated integration tests render synthetic two-topic demos at 320 × 180 and 30 fps. In addition, a 21.5-second synthetic demo was rendered at 1920 × 1080 and 30 fps; FFprobe and a complete decode passed, and opening/popup subtitle frames were visually checked. This is a short full-resolution smoke test, not a complete roughly four-minute production episode or a performance/stress test.

The original renderer source and private media were not recovered, and no frame-by-frame pixel comparison with the old final videos was performed. These checks do not prove production-length throughput, HTML-capture operation in other environments, rights ownership, or visual identity with prior videos.
