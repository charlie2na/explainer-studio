import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, normalize, sep } from 'node:path';
import { tmpdir } from 'node:os';

const DEFAULT_MODEL = 'eleven_multilingual_v2';
const AUDIO_FORMAT = 'mp3_44100_128';
const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function executable(name, fallback) {
  return process.env[name] || fallback;
}

function run(command, args, { timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${basename(command)} exited with code ${code}${stderr ? `: ${stderr.slice(-600)}` : ''}`));
    });
  });
}

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

function safeMediaPath(projectDir, relative) {
  if (typeof relative !== 'string' || !relative || isAbsolute(relative)) throw new Error('Scene has no valid audio path. Generate or upload its audio first.');
  const clean = normalize(relative);
  if (clean === '..' || clean.startsWith(`..${sep}`) || clean.startsWith(sep)) throw new Error('Scene audio path must stay within the project directory.');
  return join(projectDir, clean);
}

async function durationOf(file) {
  let output;
  try {
    output = await run(executable('FFPROBE_BIN', 'ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file], { timeout: 20_000 });
  } catch (error) {
    throw new Error(`ffprobe could not measure audio duration: ${error.message}`);
  }
  const seconds = Number(JSON.parse(output.stdout)?.format?.duration);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('ffprobe returned no usable audio duration.');
  return Math.round(seconds * 1000) / 1000;
}

export async function inspectAudio(file) {
  return durationOf(file);
}

function estimateWords(text, duration) {
  const matches = [...text.matchAll(/\S+/gu)];
  const total = matches.reduce((sum, match) => sum + match[0].length, 0) || 1;
  let at = 0;
  return matches.map(match => {
    const start = duration * at / total;
    at += match[0].length;
    return { word: match[0], start: +start.toFixed(3), end: +(duration * at / total).toFixed(3) };
  });
}

function wordsFromAlignment(alignment) {
  const { characters, character_start_times_seconds: starts, character_end_times_seconds: ends } = alignment || {};
  if (!Array.isArray(characters) || !Array.isArray(starts) || !Array.isArray(ends) || characters.length !== starts.length || starts.length !== ends.length) {
    throw new Error('ElevenLabs returned audio without valid character timing.');
  }
  const words = [];
  let current = null;
  for (let i = 0; i < characters.length; i++) {
    const char = characters[i];
    const start = Number(starts[i]);
    const end = Number(ends[i]);
    if (typeof char !== 'string' || !Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error('ElevenLabs returned invalid character timing.');
    if (/^\s+$/u.test(char)) {
      if (current) { words.push(current); current = null; }
    } else if (current) {
      current.word += char;
      current.end = end;
    } else {
      current = { word: char, start, end };
    }
  }
  if (current) words.push(current);
  if (!words.length) throw new Error('ElevenLabs returned no spoken word timing.');
  return words;
}

async function elevenLabs(text, voice) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('Set ELEVENLABS_API_KEY to generate ElevenLabs narration.');
  if (!voice?.voiceId) throw new Error('Choose an ElevenLabs voice ID before generating narration.');
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice.voiceId)}/with-timestamps?output_format=${AUDIO_FORMAT}`;
  const body = JSON.stringify({ text, model_id: voice.model || DEFAULT_MODEL, ...(voice.settings ? { voice_settings: voice.settings } : {}) });
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await fetch(url, { method: 'POST', headers: { 'xi-api-key': key, 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(90_000) });
    } catch (error) {
      if (attempt < 2) { await new Promise(resolve => setTimeout(resolve, 400 * 2 ** attempt)); continue; }
      throw new Error(`ElevenLabs connection failed after 3 attempts (${error.name || 'network error'}).`);
    }
    if (!response.ok) {
      if (RETRYABLE.has(response.status) && attempt < 2) { await new Promise(resolve => setTimeout(resolve, 400 * 2 ** attempt)); continue; }
      throw new Error(`ElevenLabs request failed with HTTP ${response.status}${RETRYABLE.has(response.status) ? ' after 3 attempts' : ''}. Check the voice ID, model, API key, and account limits.`);
    }
    let data;
    try { data = await response.json(); } catch { throw new Error('ElevenLabs returned invalid JSON.'); }
    if (typeof data.audio_base64 !== 'string' || !data.audio_base64) throw new Error('ElevenLabs returned no audio.');
    const audio = Buffer.from(data.audio_base64, 'base64');
    if (!audio.length) throw new Error('ElevenLabs returned empty audio.');
    return { audio, words: wordsFromAlignment(data.normalized_alignment || data.alignment) };
  }
  throw new Error('ElevenLabs request failed after 3 attempts.');
}

async function demoSpeech(text, file, voiceId) {
  const temp = await mkdtemp(join(tmpdir(), 'frame-studio-say-'));
  try {
    const aiff = join(temp, 'speech.aiff');
    try { await run(executable('SAY_BIN', '/usr/bin/say'), [...(voiceId ? ['-v', voiceId] : []), '-o', aiff, text]); }
    catch (error) { throw new Error(`macOS say is unavailable: ${error.message}. Use ElevenLabs or run this on a Mac with say installed.`); }
    try { await run(executable('FFMPEG_BIN', 'ffmpeg'), ['-y', '-v', 'error', '-i', aiff, '-codec:a', 'libmp3lame', '-q:a', '3', file]); }
    catch (error) { throw new Error(`ffmpeg could not encode demo narration: ${error.message}`); }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

function selectScenes(project, sceneId) {
  if (!Array.isArray(project?.scenes)) throw new Error('Project has no scenes.');
  const selected = sceneId ? project.scenes.filter(scene => scene.id === sceneId) : project.scenes;
  if (sceneId && !selected.length) throw new Error(`Scene ${sceneId} was not found.`);
  return selected;
}

export async function speakProject({ project, projectDir, sceneId, provider = 'elevenlabs', force = false, onProgress = () => {} }) {
  if (!['elevenlabs', 'demo'].includes(provider)) throw new Error(`Unsupported narration provider: ${provider}.`);
  const result = structuredClone(project);
  const scenes = selectScenes(result, sceneId);
  const audioDir = join(projectDir, 'audio');
  await mkdir(audioDir, { recursive: true });
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const text = String(scene.narration || '').trim();
    if (!text) {
      scene.audio = null;
      scene.words = [];
      scene.timingSource = 'estimated';
      onProgress((i + 1) / scenes.length, `Skipped empty narration for ${scene.title || scene.id}`);
      continue;
    }
    const voice = result.voice || {};
    const settings = provider === 'elevenlabs'
      ? { provider, text, voiceId: voice.voiceId || '', model: voice.model || DEFAULT_MODEL, voiceSettings: voice.settings || null, outputFormat: AUDIO_FORMAT }
      : { provider, text, demoVoice: voice.demoVoice || '', model: 'macos-say', outputFormat: AUDIO_FORMAT };
    if (force) settings.take = randomUUID();
    const hash = createHash('sha256').update(JSON.stringify(settings)).digest('hex');
    const relative = `audio/${hash}.mp3`;
    const file = join(audioDir, `${hash}.mp3`);
    const metadataFile = join(audioDir, `${hash}.json`);
    let cached = null;
    if (await exists(file) && await exists(metadataFile)) {
      try { cached = JSON.parse(await readFile(metadataFile, 'utf8')); await durationOf(file); } catch { cached = null; }
    }
    if (!cached) {
      let words = null;
      let source = 'estimated';
      if (provider === 'elevenlabs') {
        const generated = await elevenLabs(text, voice);
        await writeFile(file, generated.audio);
        words = generated.words;
        source = 'elevenlabs';
      } else {
        await demoSpeech(text, file, voice.demoVoice);
      }
      const duration = await durationOf(file);
      cached = { words: words || estimateWords(text, duration), timingSource: source, duration };
      await writeFile(metadataFile, JSON.stringify(cached));
    }
    scene.audio = relative;
    scene.duration = cached.duration;
    scene.words = cached.words;
    scene.timingSource = cached.timingSource;
    delete scene.transcription;
    onProgress((i + 1) / scenes.length, `Narration ready for ${scene.title || scene.id}`);
  }
  return result;
}

function normalizeWord(word) {
  return String(word).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function discrepancy(script, transcript) {
  const a = (script.match(/\S+/gu) || []).map(normalizeWord).filter(Boolean);
  const b = (transcript.match(/\S+/gu) || []).map(normalizeWord).filter(Boolean);
  const matrix = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) matrix[i][j] = a[i] === b[j] ? matrix[i + 1][j + 1] + 1 : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
  const differences = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; }
    else if (j < b.length && (i === a.length || matrix[i][j + 1] >= matrix[i + 1][j])) differences.push({ type: 'heardOnly', word: b[j++], transcriptIndex: j - 1 });
    else differences.push({ type: 'scriptOnly', word: a[i++], scriptIndex: i - 1 });
  }
  return differences;
}

export async function transcribeProject({ project, projectDir, sceneId, onProgress = () => {} }) {
  const result = structuredClone(project);
  const scenes = selectScenes(result, sceneId);
  const python = executable('WHISPER_PYTHON', 'python3');
  try { await run(python, ['-c', "import importlib.util,sys;sys.exit(0 if importlib.util.find_spec('whisper') else 1)"], { timeout: 20_000 }); }
  catch { throw new Error(`Whisper is unavailable for ${python}. Install openai-whisper for that Python, or set WHISPER_PYTHON to a Python executable that has it.`); }
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const audio = safeMediaPath(projectDir, scene.audio);
    if (!await exists(audio)) throw new Error(`Audio for ${scene.title || scene.id} is missing. Generate narration or upload audio first.`);
    const temp = await mkdtemp(join(tmpdir(), 'frame-studio-whisper-'));
    try {
      const model = process.env.WHISPER_MODEL || 'base';
      try { await run(python, ['-m', 'whisper', audio, '--model', model, '--word_timestamps', 'True', '--output_format', 'json', '--output_dir', temp, '--verbose', 'False', '--fp16', 'False', '--threads', process.env.WHISPER_THREADS || '4'], { timeout: 15 * 60_000 }); }
      catch (error) { throw new Error(`Whisper transcription failed: ${error.message}`); }
      const output = join(temp, `${basename(audio, extname(audio))}.json`);
      let data;
      try { data = JSON.parse(await readFile(output, 'utf8')); }
      catch { throw new Error('Whisper produced no readable JSON transcript.'); }
      const words = (data.segments || []).flatMap(segment => segment.words || []).map(item => ({ word: String(item.word || '').trim(), start: Number(item.start), end: Number(item.end) })).filter(item => item.word && Number.isFinite(item.start) && Number.isFinite(item.end) && item.end >= item.start);
      if (!words.length) throw new Error('Whisper produced no word timestamps. Check that the audio contains intelligible speech.');
      const transcript = String(data.text || words.map(item => item.word).join(' ')).trim();
      const differences = discrepancy(String(scene.narration || ''), transcript);
      scene.words = words;
      scene.timingSource = 'whisper';
      scene.transcription = { text: transcript, differsFromScript: differences.length > 0, differences };
      scene.duration = await durationOf(audio);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
    onProgress((i + 1) / scenes.length, `Transcribed ${scene.title || scene.id}`);
  }
  return result;
}

export async function audioStatus() {
  const [ffmpeg, ffprobe, demoVoice, whisper] = await Promise.all([
    run(executable('FFMPEG_BIN', 'ffmpeg'), ['-version'], { timeout: 5000 }).then(() => true, () => false),
    run(executable('FFPROBE_BIN', 'ffprobe'), ['-version'], { timeout: 5000 }).then(() => true, () => false),
    run(executable('SAY_BIN', '/usr/bin/say'), ['-v', '?'], { timeout: 5000 }).then(() => true, () => false),
    run(executable('WHISPER_PYTHON', 'python3'), ['-c', "import importlib.util,sys;sys.exit(0 if importlib.util.find_spec('whisper') else 1)"], { timeout: 10_000 }).then(() => true, () => false),
  ]);
  return { ffmpeg: ffmpeg && ffprobe, whisper, elevenlabs: Boolean(process.env.ELEVENLABS_API_KEY), demoVoice };
}
