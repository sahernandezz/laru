/** One video for a flow on several screens: the graph puts each at its start, and magenta (a page not opened yet) is drawn black. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { graph } from '../src/video.ts';

test('the graph delays each screen by when its person opened it and puts them side by side', () => {
  const g = graph([0, 432]);
  assert.match(g, /tpad=start_duration=0:/);
  assert.match(g, /tpad=start_duration=0\.432:/);
  assert.match(g, /colorkey=0xFF00FF/);
  assert.match(g, /\[v0\]\[v1\]hstack=inputs=2\[out\]$/);
});

test('a screen is a name inside the flow: what trace.json says cannot reach outside it', async () => {
  const { combineScreens } = await import('../src/video.ts');
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'ks-video-'));
  const ws = { root, app: 'x' } as never;
  const run = join(root, '.laru', 'runs', '1');
  mkdirSync(join(run, 'flows', 'f'), { recursive: true });
  writeFileSync(join(run, 'run.json'), JSON.stringify({ id: '1', results: { f: { status: 'passed', video: '../../../../etc/passwd', trace: 'flows/f/trace.json' } } }));
  await assert.rejects(combineScreens(ws, '1', 'f'), /has no video/);
  writeFileSync(join(run, 'run.json'), JSON.stringify({ id: '1', results: { f: { status: 'passed', video: 'flows/f/video.webm', trace: 'flows/f/trace.json' } } }));
  writeFileSync(join(run, 'flows', 'f', 'trace.json'), JSON.stringify({ screens: [{ name: 'luis', video: '../../../x.webm', startMs: 1 }] }));
  await assert.rejects(combineScreens(ws, '1', 'f'), /one screen|has no video/, 'a screen outside the flow is dropped, not read');
  // a link inside the flow that leads out of it is not followed either
  const { symlinkSync } = await import('node:fs');
  writeFileSync(join(root, 'secret.webm'), 'x');
  symlinkSync(join(root, 'secret.webm'), join(run, 'flows', 'f', 'video-luis.webm'));
  writeFileSync(join(run, 'flows', 'f', 'video.webm'), 'x');
  writeFileSync(join(run, 'flows', 'f', 'trace.json'), JSON.stringify({ screens: [{ name: 'luis', video: 'video-luis.webm', startMs: 1 }] }));
  await assert.rejects(combineScreens(ws, '1', 'f'), /one screen/, 'a link out of the flow is dropped');
});

test('the ffmpeg Laru installs makes what it asks of it: the joint video, and a session video from piped frames', async () => {
  const { execFileSync, spawnSync } = await import('node:child_process');
  const { existsSync, mkdtempSync, mkdirSync, statSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { combineScreens } = await import('../src/video.ts');
  const { FFMPEG } = await import('../src/runs.ts');
  assert.ok(existsSync(FFMPEG), 'ffmpeg-static, not one the machine must have');
  const root = mkdtempSync(join(tmpdir(), 'ks-ffmpeg-'));
  const dir = join(root, '.laru', 'runs', '1', 'flows', 'f');
  mkdirSync(dir, { recursive: true });
  const clip = (file: string, color: string) => execFileSync(FFMPEG, ['-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=320x240:d=1`, '-c:v', 'libvpx', join(dir, file)]);
  clip('video.webm', 'blue'); clip('video-luis.webm', 'magenta');
  writeFileSync(join(dir, 'trace.json'), JSON.stringify({ screens: [{ name: 'luis', video: 'video-luis.webm', startMs: 300 }] }));
  writeFileSync(join(root, '.laru', 'runs', '1', 'run.json'), JSON.stringify({ id: '1', results: { f: { status: 'passed', video: 'flows/f/video.webm', trace: 'flows/f/trace.json' } } }));
  assert.equal(await combineScreens({ root, app: 'x' } as never, '1', 'f'), 'flows/f/video-all.mp4');
  assert.ok(statSync(join(dir, 'video-all.mp4')).size > 0);
  // the session's way: JPEG frames on stdin, VP8 out
  const jpeg = execFileSync(FFMPEG, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=320x240:d=1', '-frames:v', '1', '-f', 'mjpeg', '-']);
  const live = spawnSync(FFMPEG, ['-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', '10', '-c:v', 'mjpeg', '-i', 'pipe:0', '-c:v', 'libvpx', '-deadline', 'realtime', '-pix_fmt', 'yuv420p', join(root, 'session.webm')], { input: Buffer.concat([jpeg, jpeg, jpeg]) });
  assert.equal(live.status, 0, String(live.stderr));
});
