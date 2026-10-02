# Explainer Studio

A local video studio that turns ideas into narrated, animated videos with Codex-guided scripting, AI artwork, voice generation, and MP4 export. The browser workspace is called Frame Studio.

The production flow: brief → script → artwork → voice → timed storyboard → browser animation → MP4. The project includes a review interface, reusable scene layouts, and a Codex production skill. Working films live in the Git-ignored `videos/` folder; a fresh clone starts without your personal projects.

## Install on macOS or Linux

Install **Node.js 22 or later** (with npm) and Git before starting. FFmpeg and
ffprobe must be on your PATH. On macOS with Homebrew:

```sh
brew install node@22 ffmpeg git
```

If Homebrew reports Node is keg-only, follow its printed PATH instructions so
`node --version` reports 22 or later. On Ubuntu/Debian, install FFmpeg and Git:

```sh
sudo apt-get update
sudo apt-get install -y ffmpeg git
```

Install Node 22 or later using your preferred Node installer/version manager;
your distribution's default Node package may be older. Other Linux distributions
need equivalent FFmpeg and Chromium system packages. The automated test matrix
covers macOS and Ubuntu; Windows is not currently a supported setup.

Clone the repository and install its locked dependencies:

```sh
git clone https://github.com/charlie2na/explainer-studio.git
cd explainer-studio
npm ci
```

On Linux, install Chromium's system dependencies (this may request sudo):

```sh
npx playwright install --with-deps chromium
```

Then, on either platform:

```sh
npm run setup
npm start
```

Open [the local studio](http://127.0.0.1:4317). Keep the terminal open while using
the app; press Ctrl+C to stop it. `npm run setup` installs Chromium, copies the
included sample into `videos/`, and checks required dependencies. It preserves
an existing sample and never modifies your `.env` file.

## Try your first export

Select **From idea to film**, preview it, and export it from the studio. It includes
artwork and prerecorded narration; no API key, Python, Whisper, or Codex session
is needed to try the sample. For a quicker, lower-resolution command-line export:

```sh
npm run studio -- render from-idea-to-film --width 640 --height 360 --fps 15
```

The command prints the new MP4 and caption paths under
`videos/from-idea-to-film/exports/`. Export runs locally and can take longer than
the film's duration. Back up `videos/` separately; it is intentionally excluded
from Git. To install the example again in a fresh checkout, run `npm run sample`.

## Make your own video

In Codex, say: **“Make a 60-second video about [topic]. Ask me about the audience and visual direction first.”** The root `AGENTS.md` routes video requests to `skills/video-studio/SKILL.md`. That skill is project-local; it does not modify your global Codex setup. You can also invoke it by asking Codex to read that path.

The browser is the production desk: create a brief, upload references, edit scenes, review motion, generate narration, capture contact sheets, and render. Creative interviewing, scripting, and OpenAI image generation happen in your Codex conversation. The browser does not pretend to be a second AI assistant.

## Voice and timing

The demo voice uses local macOS narration and is unavailable on Linux. On Linux, upload your own WAV/MP3/M4A/AIFF narration or configure ElevenLabs; the included prerecorded sample works on both platforms. To use ElevenLabs, copy `.env.example` to `.env`, set `ELEVENLABS_API_KEY`, restart the studio, and choose ElevenLabs plus a voice ID in the studio. Keep secrets out of chat and source control. API usage is billed to your ElevenLabs account. Each scene's take is cached, so unchanged narration is reused.

For local Whisper, install a compatible Python environment (Python 3.11 is a practical choice):

```sh
python3.11 -m venv .venv
.venv/bin/pip install openai-whisper
```

The CLI automatically uses `.venv/bin/python` if present. For another environment, set `WHISPER_PYTHON` in `.env` to its absolute Python path. Optionally set `WHISPER_MODEL=base` or `WHISPER_THREADS=4`. The first transcription downloads model weights. Whisper produces estimated word boundaries and flags recognized words that differ from the script; a difference may be a recognition error rather than a narration error. The demo provider's proportional timings are labeled `estimated` until you transcribe.

## OpenAI artwork

Ask Codex to generate each image-led scene using its built-in image-generation tool, inspect the results, and import them into the video. This route does not need an OpenAI API key. Each scene retains its `visualPrompt`; references stay in the project. Generate assets independently where motion needs separate layers, then extend the deterministic renderer to compose them. The initial scene kit supports one main raster image per scene, plus coded typography and diagrams.

## Short animation reels with Kling

[Kling AI](https://kling.ai/feature/image-to-video) is one example of an external image-to-video tool for turning scene artwork into short animated clips. For a seven-second animation reel, upload your artwork, describe one focused action and camera movement, and choose a suitable clip duration. If the selected model does not offer seven seconds, generate a longer clip and trim it to seven seconds in a video editor.

Example motion prompt: “Slow camera push toward the paper-cut microphone; sound-wave shapes gently pulse; preserve the ivory and orange palette; keep the composition stable; no text.”

This is an optional external workflow with a separate account and any applicable provider charges. The studio currently accepts still-image scene assets, not arbitrary MP4 scene uploads, and has no Kling integration. Assemble Kling clips with studio exports in an external video editor.

## Local use and sharing

The studio is intended for one trusted user on their own machine. It has no login or multi-user authorization; do not expose it through a public tunnel, reverse proxy, or network binding. Other software running on your machine can access the local API.

Keep credentials in `.env`, which Git ignores. `videos/` is also ignored because briefs, source references, audio, and exports may be private. Review any curated sample before deliberately sharing it. Ignored working files are not backed up by Git.

ElevenLabs receives narration when you request its voice generation. Whisper runs locally and downloads model weights on first use. Artwork or references you upload to external services such as Kling are handled by those services.

## Commands

```sh
npm run studio -- list
npm run studio -- create "My first film"
npm run studio -- show <project-id>
npm run studio -- save <project-id> <edited-json-file>
npm run studio -- asset <project-id> <scene-id> /absolute/path/image.png
npm run studio -- reference <project-id> /absolute/path/reference.png
npm run studio -- speak <project-id> --provider demo
npm run studio -- speak <project-id> --provider elevenlabs --scene <scene-id>
npm run studio -- speak <project-id> --provider elevenlabs --scene <scene-id> --force
npm run studio -- transcribe <project-id>
npm run studio -- cues <project-id>
npm run studio -- stills <project-id>
npm run studio -- render <project-id> --width 1280 --height 720 --fps 30
npm test
```

Commands that render launch their own temporary loopback server; they do not require the studio to be running. The review UI renders the same deterministic scene code as export. Portrait and square layouts are supported; inspect their contact sheets before final export.

For a fresh alternate narration take, add `--force`; earlier takes remain on disk. To anchor step reveals to speech, give a scene `cuePhrases` (one phrase per displayed step) and run `cues`. It resolves phrases against the scene's word timings and rejects missing or ambiguous matches. An optional `{ "phrase": "your phrase", "occurrence": 2 }` selects a repeated phrase. Regenerating audio clears resolved cues; run `cues` again afterward.

## Files and revision behavior

- `videos/<id>/project.json`: editable source of truth, including brief, scenes, word timings, references, reviews, and export history.
- `brief.md`, `script.md`, `storyboard.json`: generated reading copies.
- `assets/`, `references/`, `audio/`: versioned artwork, supplied references, and cached takes.
- `exports/`: MP4, SRT, contact sheets, and scene PNGs.
- `public/renderer.js`: reusable, time-driven scene kit. Add custom layouts here.

Save through the studio or CLI so revisions and stale outputs are tracked. Changing narration or voice detaches obsolete audio; changing visuals preserves it. Existing exports remain available with their source revision. Jobs run one at a time per project and block concurrent edits. The server binds only to localhost, rejects cross-origin writes, serves only approved media folders, and never exposes `.env`.

This version exports locally. It does not publish to social accounts. Image generation and live ElevenLabs calls depend on available tools/account access; local preview, contact sheets, and rendering work with supplied assets. macOS `say` is an optional demo voice, not an ElevenLabs imitation.

## Troubleshooting

- **A dependency is missing:** run `npm run check`. Missing required dependencies
  return a failing exit code with installation guidance; voice providers and
  Whisper are optional.
- **Chromium cannot start:** run `npx playwright install chromium`; on Linux use
  `npx playwright install --with-deps chromium` to install system libraries too.
- **Port 4317 is busy:** run `PORT=4318 npm start` and open the address it prints.
- **No free demo voice on Linux:** upload narration or use ElevenLabs. You do not
  need to regenerate the included sample's audio.
- **A sample already exists:** `npm run sample` leaves it untouched. Preserve or
  rename your working folder before installing a fresh copy.

## Development and license

Run `npm test` after installing FFmpeg and Chromium. GitHub Actions runs the tests
on macOS and Ubuntu using Node 22. Provider tests use local fixtures and mocks,
so CI does not need API credentials or make paid generation calls.

Code is released under the [MIT license](LICENSE). See [example provenance](examples/README.md)
for the supplied artwork and narration. Third-party dependencies and services
retain their own licenses and terms.

## Sources

- [Playwright screenshots](https://playwright.dev/docs/screenshots)
- [FFmpeg documentation](https://ffmpeg.org/ffmpeg.html)
- [Whisper](https://github.com/openai/whisper)
- [ElevenLabs speech with timestamps](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps)
