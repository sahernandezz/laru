/** One video for a flow on several screens: the graph puts each at its start, and magenta (a page not opened yet) is drawn black. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { graph, tiles } from '../src/video.ts';

test('each screen keeps its own shape at one shared height: a phone beside a pc is narrow, two pcs are alike, a big screen is not shrunk', () => {
  assert.deepEqual(tiles([{ width: 1920, height: 1080 }, { width: 1920, height: 1080 }]), [{ w: 1920, h: 1080 }, { w: 1920, h: 1080 }]);
  assert.deepEqual(tiles([{ width: 1280, height: 720 }, { width: 390, height: 844 }]), [{ w: 1500, h: 844 }, { w: 390, h: 844 }], 'the phone tall and narrow, the pc as tall, wide');
  const three = tiles([{ width: 1920, height: 1080 }, { width: 1920, height: 1080 }, { width: 1920, height: 1080 }]);
  assert.ok(three.reduce((n, t) => n + t.w, 0) <= 3840 && three.every((t) => t.w === three[0].w && t.h % 2 === 0 && t.w % 2 === 0), JSON.stringify(three));
});

test('the graph delays each screen by when its person opened it and puts them side by side', () => {
  const g = graph([{ w: 1280, h: 720, start: 0 }, { w: 1280, h: 720, start: 432 }]);
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
  const { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } = await import('node:fs');
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
  const frame = (f: string) => /Video:.*?\b(\d{2,5}x\d{2,5})\b/.exec(spawnSync(FFMPEG, ['-hide_banner', '-i', f], { encoding: 'utf8' }).stderr)?.[1];
  assert.equal(frame(join(dir, 'video-all.mp4')), '640x240', 'two 320x240 screens at their own size, side by side');
  // one exported the old way (960x540 tiles), newer than its screens: made again, not handed out
  execFileSync(FFMPEG, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=1920x540:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, 'video-all.mp4')]);
  assert.equal(await combineScreens({ root, app: 'x' } as never, '1', 'f'), 'flows/f/video-all.mp4');
  assert.equal(frame(join(dir, 'video-all.mp4')), '640x240');
  // the same frame size, made by another layout (or with no record of it): made again too, not told apart by its size
  const { writeFileSync: write } = await import('node:fs');
  const before = statSync(join(dir, 'video-all.mp4')).mtimeMs;
  const record = readFileSync(join(dir, 'video-all.json'), 'utf8');
  write(join(dir, 'video-all.json'), `${JSON.stringify({ tiles: [{ w: 400, h: 240 }, { w: 240, h: 240 }], starts: [0, 300] })}\n${record.split('\n')[1]}`);
  await new Promise((r) => setTimeout(r, 20));
  await combineScreens({ root, app: 'x' } as never, '1', 'f');
  assert.ok(statSync(join(dir, 'video-all.mp4')).mtimeMs > before, 'remade');
  const again = statSync(join(dir, 'video-all.mp4')).mtimeMs;
  await combineScreens({ root, app: 'x' } as never, '1', 'f');
  assert.equal(statSync(join(dir, 'video-all.mp4')).mtimeMs, again, 'made by this layout: kept');
  // the same layout and the same number of bytes, another content: made again
  const bytes = readFileSync(join(dir, 'video-all.mp4'));
  write(join(dir, 'video-all.mp4'), Buffer.alloc(bytes.length, 7));
  await combineScreens({ root, app: 'x' } as never, '1', 'f');
  assert.equal(frame(join(dir, 'video-all.mp4')), '640x240', 'a file of the same size but other bytes is not taken for it');
  // the session's way: JPEG frames on stdin, VP8 out
  const jpeg = execFileSync(FFMPEG, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=320x240:d=1', '-frames:v', '1', '-f', 'mjpeg', '-']);
  const live = spawnSync(FFMPEG, ['-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', '10', '-c:v', 'mjpeg', '-i', 'pipe:0', '-c:v', 'libvpx', '-deadline', 'realtime', '-pix_fmt', 'yuv420p', join(root, 'session.webm')], { input: Buffer.concat([jpeg, jpeg, jpeg]) });
  assert.equal(live.status, 0, String(live.stderr));
});
