import { strict as assert } from 'node:assert';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { inspectEnv } from '../src/docker.ts';

test('a container removed between the listing and the inspect (compose recreating it) is listed again, not an error', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'ks-fake-docker-'));
  // ps lists a container that is gone on the first inspect; the second listing has its replacement.
  writeFileSync(join(bin, 'docker'), `#!/bin/sh
n=$(cat "${bin}/n" 2>/dev/null || echo 0); echo $((n+1)) > "${bin}/n"
case "$1" in
  ps) if [ "$n" -lt 2 ]; then echo old111111111; else echo new222222222; fi ;;
  inspect) if [ "$2" = old111111111 ]; then echo "Error: No such object: old111111111" >&2; exit 1; fi
    echo '[{"Id":"new222222222xx","Name":"/ks-a-local-api-1","Config":{"Image":"api","Labels":{"keelson.service":"api"}},"State":{"Status":"running"},"NetworkSettings":{}}]' ;;
esac
`);
  chmodSync(join(bin, 'docker'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const cs = await inspectEnv({ root: '/ws' }, 'local');
    assert.deepEqual(cs.map((c) => [c.id, c.service]), [['new222222222', 'api']]);
  } finally { process.env.PATH = path; }
});
