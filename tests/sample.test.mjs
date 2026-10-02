import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { root } from '../lib/project.mjs';

const exec = promisify(execFile);

test('sample installs with its media and never overwrites an existing working copy', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'explainer-sample-test-'));
  try {
    for (const name of ['lib', 'examples']) await cp(path.join(root, name), path.join(directory, name), { recursive: true });
    await mkdir(path.join(directory, 'scripts'));
    await cp(path.join(root, 'scripts/sample.mjs'), path.join(directory, 'scripts/sample.mjs'));
    const run = () => exec(process.execPath, ['scripts/sample.mjs'], { cwd: directory });
    await run();
    const installed = path.join(directory, 'videos/from-idea-to-film');
    const project = JSON.parse(await readFile(path.join(installed, 'project.json'), 'utf8'));
    assert.equal(project.scenes.length, 6);
    assert.deepEqual(project.exports, []);
    for (const scene of project.scenes) {
      for (const key of ['asset', 'audio']) if (scene[key]) {
        assert.deepEqual(await readFile(path.join(installed, scene[key])), await readFile(path.join(directory, 'examples/from-idea-to-film', scene[key])));
      }
    }
    assert.match(await readFile(path.join(installed, 'script.md'), 'utf8'), /Every film starts with an idea/);
    const marker = path.join(installed, 'my-notes.txt');
    await writeFile(marker, 'Keep my changes');
    const original = await readFile(path.join(installed, 'project.json'));
    assert.match((await run()).stdout, /Your work was preserved/);
    assert.deepEqual(await readFile(path.join(installed, 'project.json')), original);
    assert.equal(await readFile(marker, 'utf8'), 'Keep my changes');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
