import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sceneAt, projectDuration, mediaUrl } from '../public/renderer.js';
import { subtitles, validateRenderOptions } from '../lib/render.mjs';

const project = {
  id: 'story 1', title: 'A story', scenes: [
    { title: 'Opening', duration: 2, narration: 'We begin here.', words: [{ word: 'We', start: 0, end: .4 }, { word: 'begin', start: .4, end: .9 }, { word: 'here.', start: .9, end: 1.3 }] },
    { title: 'Second', duration: 3, narration: 'And then this. One last thing.' }
  ]
};

test('absolute time selects scene and clamps end', () => {
  assert.equal(projectDuration(project), 5);
  assert.deepEqual([sceneAt(project, 1.5).index, sceneAt(project, 2).index, sceneAt(project, 99).local], [0, 1, 3]);
  assert.equal(sceneAt(project, 2.5).local, .5);
});

test('media URLs encode path segments', () => {
  assert.equal(mediaUrl(project, 'assets/a b.png'), '/media/story%201/assets/a%20b.png');
});

test('subtitles include scene offsets and local word timing', () => {
  const result = subtitles(project);
  assert.match(result, /00:00:00,000 --> 00:00:01,300/);
  assert.match(result, /00:00:02,000 --> 00:00:03,500/);
  assert.match(result, /00:00:03,500 --> 00:00:05,000/);
});

test('render options reject bad dimensions and duration', () => {
  const args = { project, projectDir: '/tmp/project', baseUrl: 'http://localhost:3000' };
  assert.equal(validateRenderOptions(args), 5);
  assert.throws(() => validateRenderOptions({ ...args, width: 641 }), /even/);
  assert.throws(() => validateRenderOptions({ ...args, project: { ...project, scenes: [{ duration: 0 }] } }), /positive duration/);
});

test('browser screenshots keep titles and captions inside landscape and portrait frames', async () => {
  const { chromium } = await import('playwright');
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
  const sample = {
    ...project,
    scenes: [
      { ...project.scenes[0], layout: 'title', title: 'A clear idea becomes a memorable film' },
      { ...project.scenes[1], layout: 'image', title: 'Bring the story into focus' },
      { title: 'Three steps to make it real', layout: 'steps', duration: 3, narration: 'Write the script. Plan the scenes. Refine the result.', items: ['Write the script', 'Plan the scenes', 'Refine the result'] },
      { title: 'A good story stays with you.', layout: 'quote', duration: 2, narration: 'A good story stays with you.' }
    ]
  };
  const server = createServer(async (req, res) => {
    if (req.url.startsWith('/api/projects/')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(sample)); return; }
    const file = req.url.startsWith('/renderer.js') ? 'renderer.js' : 'render.html';
    res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : 'text/html');
    res.end(await readFile(join(publicDir, file)));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const [width, height] of [[1280, 720], [720, 1280]]) {
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
      await page.goto(`${base}/render.html?project=story%201&width=${width}&height=${height}`);
      await page.evaluate(() => window.renderReady);
      let offset = 0;
      for (const scene of sample.scenes) {
        await page.evaluate(time => window.renderFrame(time), offset + scene.duration * .55);
        const png = await page.screenshot({ type: 'png' });
        assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
        const overflow = await page.evaluate(() => {
          const svg = document.querySelector('#frame svg');
          const { width, height } = svg.viewBox.baseVal;
          return [...svg.querySelectorAll('text[data-role]')].map(node => {
            const box = node.getBBox();
            return { role: node.dataset.role, text: node.textContent, x: box.x, y: box.y, right: box.x + box.width, bottom: box.y + box.height, width, height };
          }).filter(box => box.x < -1 || box.y < -1 || box.right > box.width + 1 || box.bottom > box.height + 1);
        });
        assert.deepEqual(overflow, [], `${width}x${height} ${scene.layout} text overflow`);
        offset += scene.duration;
      }
      await page.close();
    }
    sample.scenes[1].asset = 'assets/missing-artwork.png';
    const missingPage = await browser.newPage();
    await missingPage.goto(`${base}/render.html?project=story%201`);
    await assert.rejects(missingPage.evaluate(() => window.renderReady), /Artwork could not be loaded/);
    await missingPage.close();
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
