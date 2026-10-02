import { cp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { root, videosRoot, projectDir, writeProject, validateProject } from '../lib/project.mjs';

// Install an editable copy without ever overwriting an existing film.
const id = 'from-idea-to-film';
const source = path.join(root, 'examples', id);
const project = validateProject(JSON.parse(await readFile(path.join(source, 'project.json'), 'utf8')));
const destination = projectDir(id);
await mkdir(videosRoot, { recursive: true });
let created = false;
try {
  await mkdir(destination);
  created = true;
  for (const name of await readdir(source)) {
    await cp(path.join(source, name), path.join(destination, name), { recursive: true, force: false, errorOnExist: true });
  }
  await writeProject(project);
  console.log(`Sample ready: videos/${id}. Start the studio with npm start.`);
} catch (error) {
  if (!created && error.code === 'EEXIST') {
    console.log(`Sample already exists: videos/${id}. Your work was preserved.`);
  } else {
    if (created) await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
