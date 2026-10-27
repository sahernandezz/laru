import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBlobs } from '../src/git.ts';

test('a failing git cat-file says why, not just its exit code', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'laru-git-'));
  writeFileSync(join(bin, 'git'), '#!/bin/sh\necho "You have not agreed to the Xcode license agreements." >&2\nexit 69\n');
  chmodSync(join(bin, 'git'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    await assert.rejects(readBlobs(bin, ['abc']), /exited with 69: You have not agreed to the Xcode license/);
  } finally {
    process.env.PATH = path;
  }
});
