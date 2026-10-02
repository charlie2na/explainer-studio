import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OWNER_FILE = 'owner.json';
const OWNER_GRACE_MS = 10_000;

function busy() {
  const error = new Error('This project has a running job or edit. Wait for it to finish before editing.');
  error.status = 409;
  return error;
}

async function ownerOf(lockDir) {
  try {
    const owner = JSON.parse(await readFile(path.join(lockDir, OWNER_FILE), 'utf8'));
    return Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.token === 'string' ? owner : null;
  } catch { return null; }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

async function stale(lockDir) {
  let info;
  try { info = await stat(lockDir); } catch (error) { return error.code === 'ENOENT'; }
  const owner = await ownerOf(lockDir);
  return owner ? !isAlive(owner.pid) : Date.now() - info.mtimeMs > OWNER_GRACE_MS;
}

async function clearStale(lockDir) {
  if (!await stale(lockDir)) return false;
  const reapDir = `${lockDir}.reap`;
  try { await mkdir(reapDir); } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
  try {
    if (!await stale(lockDir)) return false;
    await rm(lockDir, { recursive: true, force: true });
    return true;
  } finally {
    await rm(reapDir, { recursive: true, force: true });
  }
}

export async function assertProjectLock(projectDirectory, token) {
  const owner = await ownerOf(path.join(projectDirectory, '.lock'));
  if (!token || owner?.token !== token || owner.pid !== process.pid) throw busy();
}

export async function acquireProjectLock(projectDirectory) {
  await mkdir(projectDirectory, { recursive: true });
  const lockDir = path.join(projectDirectory, '.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(lockDir);
      const token = randomUUID();
      try { await writeFile(path.join(lockDir, OWNER_FILE), JSON.stringify({ pid: process.pid, token, at: Date.now() })); }
      catch (error) { await rm(lockDir, { recursive: true, force: true }); throw error; }
      let released = false;
      return {
        token,
        async release() {
          if (released) return;
          released = true;
          const owner = await ownerOf(lockDir);
          if (owner?.token === token && owner.pid === process.pid) await rm(lockDir, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (attempt === 0 && await clearStale(lockDir)) continue;
      throw busy();
    }
  }
  throw busy();
}

export async function withProjectLock(projectDirectory, lockToken, action) {
  if (lockToken) {
    await assertProjectLock(projectDirectory, lockToken);
    return action(lockToken);
  }
  const lock = await acquireProjectLock(projectDirectory);
  try { return await action(lock.token); }
  finally { await lock.release(); }
}
