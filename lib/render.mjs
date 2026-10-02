import { spawn } from 'node:child_process';
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { once } from 'node:events';

const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const esc = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const fmt = seconds => {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
};
const durationOf = scene => Math.max(.01, finite(scene.duration, 1));

export function validateRenderOptions({ project, projectDir, baseUrl, mode = 'render', width = 1280, height = 720, fps = 30 }) {
  if (!project?.id || !Array.isArray(project.scenes) || !project.scenes.length) throw new Error('Render requires a saved project with at least one scene.');
  if (!projectDir || !baseUrl) throw new Error('Render requires projectDir and baseUrl.');
  if (!['render', 'stills'].includes(mode)) throw new Error('mode must be render or stills.');
  for (const [name, value, max] of [['width', width, 3840], ['height', height, 3840], ['fps', fps, 60]]) {
    if (!Number.isInteger(value) || value < (name === 'fps' ? 1 : 64) || value > max) throw new Error(`${name} must be an integer between ${name === 'fps' ? 1 : 64} and ${max}.`);
  }
  if (width % 2 || height % 2) throw new Error('width and height must be even for MP4 output.');
  if (project.scenes.some(scene => !Number.isFinite(Number(scene.duration)) || Number(scene.duration) <= 0)) throw new Error('Every scene requires a positive duration.');
  return project.scenes.reduce((n, scene) => n + durationOf(scene), 0);
}

function projectFile(projectDir, path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\0')) throw new Error('Invalid project media path.');
  const root = resolve(projectDir);
  const file = resolve(root, path);
  if (!file.startsWith(root + sep)) throw new Error('Media path escapes project directory.');
  return file;
}

function srtCues(project) {
  const cues = [];
  let offset = 0;
  for (const scene of project.scenes) {
    const duration = durationOf(scene);
    const words = Array.isArray(scene.words) ? scene.words.filter(w => w?.word && Number.isFinite(Number(w.start)) && Number.isFinite(Number(w.end))) : [];
    if (words.length) {
      for (let i = 0; i < words.length; i += 7) {
        const slice = words.slice(i, i + 7);
        const start = Math.max(0, Math.min(duration, Number(slice[0].start)));
        const end = Math.max(start + .05, Math.min(duration, Number(slice.at(-1).end)));
        cues.push({ start: offset + start, end: offset + end, text: slice.map(w => w.word).join(' ') });
      }
    } else if (scene.narration?.trim()) {
      const sentences = scene.narration.trim().match(/[^.!?]+[.!?]?/g) || [scene.narration.trim()];
      sentences.forEach((text, i) => cues.push({ start: offset + duration * i / sentences.length, end: offset + duration * (i + 1) / sentences.length, text: text.trim() }));
    }
    offset += duration;
  }
  return cues;
}

export function subtitles(project) {
  return srtCues(project).map((cue, i) => `${i + 1}\n${fmt(cue.start)} --> ${fmt(cue.end)}\n${cue.text}\n`).join('\n');
}

function run(command, args, { stdin } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: [stdin ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.on('data', chunk => { error = (error + chunk.toString()).slice(-12000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolveRun() : reject(new Error(`${command} exited ${code}: ${error.slice(-3000)}`)));
    if (stdin) stdin(child.stdin, child).catch(err => { child.stdin.destroy(err); child.kill(); reject(err); });
  });
}

async function browserPage(baseUrl, project, width, height) {
  let chromium;
  try { ({ chromium } = await import('playwright')); }
  catch { throw new Error('Playwright is required for rendering. Install project dependencies first.'); }
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    const url = new URL('/render.html', baseUrl);
    url.searchParams.set('project', project.id);
    url.searchParams.set('width', String(width));
    url.searchParams.set('height', String(height));
    await page.goto(url.href, { waitUntil: 'networkidle', timeout: 120_000 });
    await page.evaluate(() => window.renderReady);
    return { browser, page };
  } catch (error) { await browser.close(); throw error; }
}

async function audioInputs(project, projectDir) {
  const entries = [];
  let offset = 0;
  for (const scene of project.scenes) {
    if (scene.audio) {
      const file = projectFile(projectDir, scene.audio);
      await access(file);
      entries.push({ file, offset, duration: durationOf(scene), volume: 1 });
    }
    offset += durationOf(scene);
  }
  const music = project.music;
  const path = typeof music === 'string' ? music : music?.file || music?.path;
  if (path) {
    const file = projectFile(projectDir, path);
    await access(file);
    entries.push({ file, offset: 0, volume: Math.max(0, Math.min(1, finite(music?.volume, .16))), music: true });
  }
  return entries;
}

async function mixAudio(videoFile, finalFile, project, projectDir, duration) {
  const inputs = await audioInputs(project, projectDir);
  if (!inputs.length) { await rename(videoFile, finalFile); return; }
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoFile];
  for (const entry of inputs) {
    if (entry.music) args.push('-stream_loop', '-1');
    args.push('-i', entry.file);
  }
  const parts = [];
  inputs.forEach((entry, i) => {
    const delay = Math.max(0, Math.round(entry.offset * 1000));
    const sceneTrim = entry.music ? '' : `atrim=duration=${entry.duration.toFixed(3)},asetpts=PTS-STARTPTS,`;
    parts.push(`[${i + 1}:a]${sceneTrim}volume=${entry.volume},adelay=${delay}:all=1,apad,atrim=duration=${duration.toFixed(3)}[a${i}]`);
  });
  const labels = inputs.map((_, i) => `[a${i}]`).join('');
  parts.push(inputs.length === 1 ? `[a0]anull[aout]` : `${labels}amix=inputs=${inputs.length}:duration=longest:normalize=0[aout]`);
  args.push('-filter_complex', parts.join(';'), '-map', '0:v:0', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', duration.toFixed(3), '-movflags', '+faststart', finalFile);
  await run('ffmpeg', args);
  await rm(videoFile, { force: true });
}

export async function renderProject({ project, projectDir, baseUrl, mode = 'render', width = 1280, height = 720, fps = 30, onProgress = () => {} }) {
  const duration = validateRenderOptions({ project, projectDir, baseUrl, mode, width, height, fps });
  const outputDir = join(projectDir, 'exports');
  await mkdir(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '') + '-' + Math.random().toString(36).slice(2, 7);
  const stem = mode === 'stills' ? `stills-${stamp}` : `video-${stamp}`;
  const { browser, page } = await browserPage(baseUrl, project, width, height);
  let tempFile;
  try {
    if (mode === 'stills') {
      const files = [];
      const cards = [];
      let offset = 0, count = 0;
      for (let i = 0; i < project.scenes.length; i++) {
        const scene = project.scenes[i];
        const beatTimes = [0.2, 0.7].map(f => offset + durationOf(scene) * f);
        for (let beat = 0; beat < beatTimes.length; beat++) {
          await page.evaluate(time => window.renderFrame(time), beatTimes[beat]);
          const filename = `${stem}-scene-${String(i + 1).padStart(2, '0')}-beat-${beat + 1}.png`;
          await page.screenshot({ path: join(outputDir, filename), type: 'png', animations: 'disabled' });
          files.push(`exports/${filename}`);
          cards.push(`<figure><img src="${esc(filename)}" alt="Scene ${i + 1}, beat ${beat + 1}"><figcaption><strong>${String(i + 1).padStart(2, '0')} · ${esc(scene.title || 'Untitled')}</strong><span>${beatTimes[beat].toFixed(1)}s</span></figcaption></figure>`);
          onProgress(++count / (project.scenes.length * 2), `Captured beat ${count}`);
        }
        offset += durationOf(scene);
      }
      const htmlName = `${stem}.html`;
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(project.title)} — beat stills</title><style>body{margin:0;padding:48px;background:#f5f0e6;color:#202b29;font:16px Arial,sans-serif}h1{font:48px Georgia,serif;margin:0 0 8px}p{color:#65716c;margin:0 0 38px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(390px,1fr));gap:28px}figure{margin:0}img{display:block;width:100%;aspect-ratio:${width}/${height};object-fit:contain;background:#ddd}figcaption{display:flex;justify-content:space-between;gap:15px;padding:12px 0;border-bottom:1px solid #bcc3b7}span{color:#65716c}</style></head><body><h1>${esc(project.title)}</h1><p>Storyboard beats · revision ${Number(project.revision) || 1} · ${duration.toFixed(1)} seconds</p><main>${cards.join('')}</main></body></html>`;
      await writeFile(join(outputDir, htmlName), html);
      return { file: `exports/${htmlName}`, files, width, height, fps };
    }
    const frameCount = Math.max(1, Math.ceil(duration * fps));
    tempFile = join(outputDir, `${stem}.silent.mp4`);
    const finalFile = join(outputDir, `${stem}.mp4`);
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-vcodec', 'png', '-i', 'pipe:0', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', tempFile], {
      stdin: async stream => {
        for (let i = 0; i < frameCount; i++) {
          await page.evaluate(time => window.renderFrame(time), i / fps);
          const frame = await page.screenshot({ type: 'png', animations: 'disabled' });
          if (!stream.write(frame)) await once(stream, 'drain');
          if (i % Math.max(1, Math.floor(fps / 2)) === 0 || i === frameCount - 1) onProgress(.86 * (i + 1) / frameCount, `Rendered ${i + 1}/${frameCount} frames`);
        }
        stream.end();
      }
    });
    onProgress(.9, 'Mixing scene audio');
    try { await mixAudio(tempFile, finalFile, project, projectDir, duration); }
    catch (error) { await rm(tempFile, { force: true }); throw error; }
    const srtName = `${stem}.srt`;
    await writeFile(join(outputDir, srtName), subtitles(project));
    onProgress(1, 'Video ready');
    return { file: `exports/${basename(finalFile)}`, files: [`exports/${srtName}`], width, height, fps };
  } finally {
    await browser.close();
    if (tempFile) await rm(tempFile, { force: true });
  }
}
