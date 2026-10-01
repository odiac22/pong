import { readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(os.tmpdir());
const entries = await readdir(root, { withFileTypes: true });
const targets = entries.filter(entry =>
  entry.isDirectory() && /^pong-local2-pair-[A-Za-z0-9]+$/.test(entry.name)
);

for (const entry of targets) {
  const target = path.resolve(root, entry.name);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing unsafe benchmark cleanup target: ${target}`);
  }
  await rm(target, { recursive: true, force: true, maxRetries: 3 });
}

const remaining = (await readdir(root, { withFileTypes: true })).filter(entry =>
  entry.isDirectory() && /^pong-local2-pair-[A-Za-z0-9]+$/.test(entry.name)
);
console.log(JSON.stringify({ root, removed: targets.length, remaining: remaining.length }));
