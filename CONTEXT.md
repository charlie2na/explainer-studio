# The production pipeline

| Stage | Inputs | Command / action | Outputs | Review |
|---|---|---|---|---|
| Brief + script | Idea, audience, references | Codex interview; studio brief and scene editor | `project.json`, `brief.md`, `script.md` | Message, tone, factual claims |
| Artwork | Visual prompts and style references | Codex image generation; `asset` | `assets/`, saved image prompts | Style, composition, continuity |
| Voice | Narration, selected voice | `speak` | Cached per-scene MP3s and timing metadata | Delivery and pronunciation |
| Words | Recorded narration | `transcribe` | Scene word timings and script discrepancy report | Names, omissions, timing |
| Storyboard | Scenes, audio durations, words | Save project | `storyboard.json` | Visual beats and pacing |
| Animation | Artwork and storyboard | `stills`; studio playback | Contact sheet, frame PNGs, live preview | Cropping, legibility, motion |
| Export | Saved project and audio | `render` | MP4 and SRT in `exports/` | Actual exported film |

One project JSON is canonical. Human-readable artifacts are regenerated on save. Scene durations form a sequential timeline; word timestamps are local to their scene. Every frame is evaluated at an explicit timestamp, then Playwright captures it and FFmpeg encodes it. No realtime recording or screen-capture timing is used.

Reference images guide Codex's image-generation work; they are not automatically sent to a third party by the studio. Voice generation sends the selected narration to ElevenLabs. Whisper runs locally and downloads its selected model on first use.
