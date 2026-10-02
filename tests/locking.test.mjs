import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { acquireProjectLock, withProjectLock } from '../lib/lock.mjs';
import { createProject, projectDir, readProject, saveProject } from '../lib/project.mjs';
import { startServer } from '../lib/server.mjs';

const exec = promisify(execFile);

test('project lock is immediate, reentrant by token, and released in finally', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'frame-studio-lock-'));
  try {
    const lock = await acquireProjectLock(directory);
    try {
      await assert.rejects(acquireProjectLock(directory), error => error.status === 409);
      assert.equal(await withProjectLock(directory, lock.token, async () => 'inside'), 'inside');
    } finally { await lock.release(); }
    const second = await acquireProjectLock(directory);
    await second.release();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a live process blocks another process and a dead owner is recovered', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'frame-studio-lock-process-'));
  const moduleUrl = pathToFileURL(fileURLToPath(new URL('../lib/lock.mjs', import.meta.url))).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { acquireProjectLock } from '${moduleUrl}'; await acquireProjectLock(process.argv[1]); console.log('ready'); process.stdin.resume();`, directory], { stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const [chunk] = await once(child.stdout, 'data');
    assert.match(chunk.toString(), /ready/);
    await assert.rejects(acquireProjectLock(directory), error => error.status === 409);
    child.kill('SIGKILL');
    await once(child, 'close');
    const recovered = await acquireProjectLock(directory);
    await recovered.release();
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
});

test('concurrent saves cannot both accept one revision', async () => {
  const created = await createProject({ title: 'Locking test' });
  try {
    const first = structuredClone(created);
    const second = structuredClone(created);
    first.title = 'First edit';
    second.title = 'Second edit';
    const results = await Promise.allSettled([
      saveProject(first, { expectedRevision: created.revision }),
      saveProject(second, { expectedRevision: created.revision }),
    ]);
    assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(results.filter(item => item.status === 'rejected').length, 1);
    const rejected = results.find(item => item.status === 'rejected');
    assert.equal(rejected.reason.status, 409);
    const saved = await readProject(created.id);
    assert.equal(saved.revision, created.revision + 1);
    assert.ok(['First edit', 'Second edit'].includes(saved.title));
  } finally { await rm(projectDir(created.id), { recursive: true, force: true }); }
});

test('music upload validates audio and persists a backing track', async () => {
  const created = await createProject({ title: 'Music upload test' });
  const directory = await mkdtemp(path.join(tmpdir(), 'frame-studio-music-'));
  let app;
  try {
    const audio = path.join(directory, 'tone.wav');
    await exec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', audio]);
    app = await startServer({ port: 0 });
    const response = await fetch(`${app.baseUrl}/api/projects/${created.id}/upload`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'music', name: 'tone.wav', data: (await readFile(audio)).toString('base64') }) });
    assert.equal(response.status, 200);
    const saved = await response.json();
    assert.match(saved.music.file, /^audio\/.+\.wav$/);
    assert.equal(saved.music.volume, 0.12);
    assert.deepEqual(await readFile(path.join(projectDir(created.id), saved.music.file)), await readFile(audio));
    const edited = structuredClone(saved);
    edited.music.volume = 2;
    await assert.rejects(saveProject(edited, { expectedRevision: edited.revision }), /Music volume/);
    assert.equal((await readProject(created.id)).music.volume, 0.12);
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
    await rm(projectDir(created.id), { recursive: true, force: true });
  }
});
