---
name: video-studio
description: Create and revise narrated informational videos in this Frame Studio project, using a guided brief, OpenAI artwork, ElevenLabs or local narration, timed storyboards, browser animation, and local video exports.
---

# Video studio

Use this skill from the Frame Studio project root. The human directs the film through conversation; you operate the files and commands. Read `CONTEXT.md` for stage handoffs and `README.md` for commands. Run `npm run check` once if dependencies or provider availability are uncertain.

## Start with a useful brief

Inspect existing projects with `npm run studio -- list`. For a new film, ask a small batch of questions: subject and main takeaway, intended audience, approximate length and destination. Next ask for visual references and voice preferences only if not already supplied. Accept images attached to chat or existing local paths. Offer sensible options and reuse established preferences. Do not ask the user to operate the terminal or hand-edit JSON.

If the user asks you to proceed autonomously, choose and state reasonable creative defaults; don't manufacture required questions. Create a project with `npm run studio -- create "Title"`, then fill its brief and scenes. For edits, read `project.json`, write an edited copy to `tmp/`, and run `npm run studio -- save <id> <edited-file>`. A stale revision is a real conflict: reload and merge the intended changes.

## Make the film

1. Write a spoken script with one scene per distinct idea. Keep narration separate from visible titles and labels. Set visual direction in `visualPrompt`; use `items` for visible lists and `subtitle` for optional visible supporting copy. Estimate durations only until audio exists. For factual topics preserve source links in the brief or an adjacent sources file.
2. Establish the visual language from reference images and representative artwork. Use Codex's built-in OpenAI image generation for requested raster illustrations and backgrounds; an API key is not required for that built-in tool. Generate a separate asset for each distinct image-led beat. Use references to maintain palette, materials, and character identity. Inspect every result. Copy outputs into this project and attach them with `npm run studio -- asset <id> <scene-id> <absolute-image-path>`. Preserve originals. Never silently replace requested artwork with a generic geometric placeholder. Code-drawn diagrams and text are appropriate for diagram scenes.
3. Generate narration with `npm run studio -- speak <id> --provider elevenlabs` after a voice ID and local API key are configured, or use explicitly identified local demo narration (`--provider demo`). A missing key does not justify changing provider without telling the user. Generate only an affected scene with `--scene <scene-id>`; unchanged takes are cached. If a fresh alternate take is requested, use the force option documented in README. Review pronunciation and delivery; don't claim to have listened if you only inspected file metadata.
4. ElevenLabs provides timing with generated audio. Use `npm run studio -- transcribe <id>` for Whisper word timing and independent script discrepancy checks, especially uploaded narration. Inspect each scene's `transcription.differences`; timestamps are estimates, not guarantees. Local demo timings are explicitly estimated until transcription. Keep narration unchanged when correcting a recognition error.
5. For speech-anchored steps, set `cuePhrases` to phrases from the narration (one per step), then run `npm run studio -- cues <id>`. Re-resolve cues after generating or transcribing audio. Review the timed storyboard and `npm run studio -- stills <id>` contact sheet. Inspect every scene for readability, cropping, and continuity. Open the studio preview and check motion and audio. Fix the scene or renderer, then repeat affected checks. The supplied layouts are a starting kit; extend `public/renderer.js` for bespoke motion rather than forcing every concept into a stock layout.
6. Render with `npm run studio -- render <id>` and inspect the actual MP4. Confirm duration, dimensions, audio presence, caption timing, and transitions. Return an absolute file link to the video and captions, and a studio link if it is running. Label demo voices and estimated timing honestly.

## Creative reviews and revisions

Default review points are brief/script, generated artwork plus narration, timed storyboard, and moving preview. Present concrete outputs before requesting a creative decision. When the user has authorized autonomous production, do the checks yourself and don't stop for routine approvals. Review records in the studio mean someone explicitly marked that stage reviewed; don't claim user approval they didn't give.

Revision rules: narration or voice edits invalidate attached narration and word timings. Visual edits preserve audio. Saves invalidate review freshness; exports retain their source revision. Rerunning narration updates scene duration, which shifts subsequent scenes automatically. Never edit the source project while a render or audio job is running. Avoid reusing an older export as if it reflects a newer revision.

Import a local reference with `npm run studio -- reference <id> <absolute-image-path>`. Uploaded references are stored with the project; inspect them in Codex before generating imagery. The browser does not itself run an AI chat or image model. If artwork generation tools are unavailable, tell the user and keep the project resumable with its saved prompts. API image generation is optional future plumbing, not a requirement for this Codex-native workflow.
