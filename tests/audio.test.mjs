import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { audioStatus, inspectAudio, speakProject, transcribeProject } from '../lib/audio.mjs';

const exec = promisify(execFile);

function project(narration = 'Hello world') {
  return { voice: { provider: 'elevenlabs', voiceId: 'voice-1', model: 'eleven_multilingual_v2' }, scenes: [{ id: 'one', title: 'One', narration, duration: 10, audio: null, words: [], timingSource: 'estimated' }] };
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'frame-studio-audio-test-'));
  const mp3 = join(dir, 'fixture.mp3');
  await exec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-codec:a', 'libmp3lame', mp3]);
  return { dir, audio: await readFile(mp3), close: () => rm(dir, { recursive: true, force: true }) };
}

test('ElevenLabs speech saves real audio and word timings, then reuses the per-text cache', async () => {
  const fx = await fixture();
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.ELEVENLABS_API_KEY;
  process.env.ELEVENLABS_API_KEY = 'test-secret';
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.match(url, /\/voice-1\/with-timestamps/);
    assert.equal(options.headers['xi-api-key'], 'test-secret');
    assert.equal(JSON.parse(options.body).text, 'Hello world');
    const alignment = text => ({ characters: [...text], character_start_times_seconds: [...text].map((_, i) => i * 0.06), character_end_times_seconds: [...text].map((_, i) => (i + 1) * 0.06) });
    return { ok: true, json: async () => ({ audio_base64: fx.audio.toString('base64'), alignment: alignment('Hello world'), normalized_alignment: alignment('Hello planet') }) };
  };
  try {
    const initial = project();
    const spoken = await speakProject({ project: initial, projectDir: fx.dir });
    assert.equal(initial.scenes[0].audio, null);
    assert.equal(spoken.scenes[0].timingSource, 'elevenlabs');
    assert.deepEqual(spoken.scenes[0].words.map(item => item.word), ['Hello', 'planet']);
    assert.ok(spoken.scenes[0].duration > 0.9 && spoken.scenes[0].duration < 1.2);
    assert.deepEqual(await readFile(join(fx.dir, spoken.scenes[0].audio)), fx.audio);
    const again = await speakProject({ project: initial, projectDir: fx.dir });
    assert.equal(calls, 1);
    assert.deepEqual(again.scenes[0], spoken.scenes[0]);
    const alternate = await speakProject({ project: initial, projectDir: fx.dir, force: true });
    assert.equal(calls, 2);
    assert.notEqual(alternate.scenes[0].audio, spoken.scenes[0].audio);
    assert.deepEqual(await readFile(join(fx.dir, spoken.scenes[0].audio)), fx.audio);
    assert.deepEqual(await readFile(join(fx.dir, alternate.scenes[0].audio)), fx.audio);
    assert.equal((await speakProject({ project: initial, projectDir: fx.dir })).scenes[0].audio, spoken.scenes[0].audio);
    const changed = project();
    changed.voice.model = 'eleven_turbo_v2_5';
    await speakProject({ project: changed, projectDir: fx.dir });
    assert.equal(calls, 3);
    assert.equal(await inspectAudio(join(fx.dir, spoken.scenes[0].audio)), spoken.scenes[0].duration);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = originalKey;
    await fx.close();
  }
});

test('ElevenLabs retries a temporary error and never includes the API key in its error', async () => {
  const fx = await fixture();
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.ELEVENLABS_API_KEY;
  process.env.ELEVENLABS_API_KEY = 'private-test-key';
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: false, status: 429 }; };
  try {
    await assert.rejects(speakProject({ project: project(), projectDir: fx.dir }), error => {
      assert.match(error.message, /HTTP 429 after 3 attempts/);
      assert.doesNotMatch(error.message, /private-test-key/);
      return true;
    });
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = originalKey;
    await fx.close();
  }
});

test('Whisper records actual word timings and a script discrepancy without changing narration', async () => {
  const fx = await fixture();
  const fakePython = join(fx.dir, 'python-shim');
  await writeFile(fakePython, `#!/bin/sh
if [ "$1" = "-c" ]; then exit 0; fi
if [ "$1" = "-m" ]; then
  audio="$3"
  shift 3
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--output_dir" ]; then out="$2"; break; fi
    shift
  done
  name="$(basename "$audio" .mp3)"
  printf '%s' '{"text":"Hello there","segments":[{"words":[{"word":" Hello","start":0.1,"end":0.4},{"word":" there","start":0.4,"end":0.8}]}]}' > "$out/$name.json"
  exit 0
fi
exit 1
`, { mode: 0o755 });
  const oldPython = process.env.WHISPER_PYTHON;
  process.env.WHISPER_PYTHON = fakePython;
  try {
    await mkdir(join(fx.dir, 'audio'));
    await writeFile(join(fx.dir, 'audio', 'scene.mp3'), fx.audio);
    const original = project();
    original.scenes[0].audio = 'audio/scene.mp3';
    const output = await transcribeProject({ project: original, projectDir: fx.dir });
    assert.equal(output.scenes[0].narration, 'Hello world');
    assert.equal(output.scenes[0].timingSource, 'whisper');
    assert.deepEqual(output.scenes[0].words.map(({ word, start, end }) => ({ word, start, end })), [{ word: 'Hello', start: 0.1, end: 0.4 }, { word: 'there', start: 0.4, end: 0.8 }]);
    assert.equal(output.scenes[0].transcription.text, 'Hello there');
    assert.equal(output.scenes[0].transcription.differsFromScript, true);
    assert.ok(output.scenes[0].transcription.differences.some(item => item.type === 'scriptOnly' && item.word === 'world'));
  } finally {
    if (oldPython === undefined) delete process.env.WHISPER_PYTHON;
    else process.env.WHISPER_PYTHON = oldPython;
    await fx.close();
  }
});

test('missing Whisper reports setup guidance and audio status exposes booleans only', async () => {
  const fx = await fixture();
  const oldPython = process.env.WHISPER_PYTHON;
  process.env.WHISPER_PYTHON = join(fx.dir, 'missing-python');
  try {
    await assert.rejects(transcribeProject({ project: project(), projectDir: fx.dir }), /Install openai-whisper|WHISPER_PYTHON/);
    const status = await audioStatus();
    assert.equal(status.whisper, false);
    assert.equal(typeof status.ffmpeg, 'boolean');
    assert.equal(typeof status.demoVoice, 'boolean');
    assert.equal(typeof status.elevenlabs, 'boolean');
  } finally {
    if (oldPython === undefined) delete process.env.WHISPER_PYTHON;
    else process.env.WHISPER_PYTHON = oldPython;
    await fx.close();
  }
});

test('demo narration encodes say output and marks timing as estimated', async () => {
  const fx = await fixture();
  const aiff = join(fx.dir, 'voice.aiff');
  await exec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=1', aiff]);
  const say = join(fx.dir, 'say-shim');
  await writeFile(say, `#!/bin/sh\n[ "$1" = "-v" ] || exit 2\n[ "$2" = "Alex" ] || exit 3\nshift 2\ncp "${aiff}" "$2"\n`, { mode: 0o755 });
  const oldSay = process.env.SAY_BIN;
  process.env.SAY_BIN = say;
  try {
    const input = project('One short sentence.');
    input.voice.voiceId = 'elevenlabs-only-id';
    input.voice.demoVoice = 'Alex';
    const output = await speakProject({ project: input, projectDir: fx.dir, provider: 'demo' });
    assert.equal(output.scenes[0].timingSource, 'estimated');
    assert.ok(output.scenes[0].duration > 0);
    assert.ok(output.scenes[0].words.length > 0);
    assert.ok((await readFile(join(fx.dir, output.scenes[0].audio))).length > 100);
  } finally {
    if (oldSay === undefined) delete process.env.SAY_BIN;
    else process.env.SAY_BIN = oldSay;
    await fx.close();
  }
});
