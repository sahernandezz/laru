/**
 * A video made from a story's rrweb recording, on demand: Chrome (the machine's own, as the session browser) replays
 * the recording at its own size and speed while the session's screencast films it (Laru's ffmpeg, not Playwright's,
 * which it would download), kept as replay.mp4 beside the recording: H.264, which QuickTime and every player open. One
 * at a time per flow of a run.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Workspace } from '@laru/core';
import { FFMPEG, runDir } from './runs.ts';
import { screencast } from './sessions.ts';

type RrEvent = { type: number; timestamp: number; data?: { width?: number; height?: number } };
export type ReplayVideoState = { state: 'none' | 'running' | 'done' | 'failed'; error?: string };

const jobs = new Map<string, ReplayVideoState>();
const flowDir = (ws: Workspace, run: string, slug: string) => {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error(`no flow ${JSON.stringify(slug)}`);
  return join(runDir(ws, run), 'flows', slug);
};
/** a video's side must be even for its encoder */
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export function replayVideoState(ws: Workspace, run: string, slug: string): ReplayVideoState {
  const dir = flowDir(ws, run, slug);
  return jobs.get(dir) ?? { state: existsSync(join(dir, 'replay.mp4')) ? 'done' : 'none' };
}

/** Starts making the video (when it is not already being made) and answers at once. */
export function startReplayVideo(ws: Workspace, run: string, slug: string): ReplayVideoState {
  const dir = flowDir(ws, run, slug);
  if (!existsSync(join(dir, 'replay.json'))) throw new Error('este flujo no tiene grabación de la pantalla (replay.json)');
  if (jobs.get(dir)?.state === 'running') return jobs.get(dir)!;
  jobs.set(dir, { state: 'running' });
  film(dir).then(() => jobs.set(dir, { state: 'done' }), (e: Error) => jobs.set(dir, { state: 'failed', error: e.message }));
  return jobs.get(dir)!;
}

async function film(dir: string): Promise<void> {
  const events = JSON.parse(readFileSync(join(dir, 'replay.json'), 'utf8')) as RrEvent[];
  if (events.length < 2) throw new Error('la grabación está vacía');
  // type 4 is rrweb's Meta: the window's size when the recording began
  const meta = events.find((e) => e.type === 4)?.data;
  const size = { width: even(meta?.width ?? 1280), height: even(meta?.height ?? 720) };
  const ms = events.at(-1)!.timestamp - events[0].timestamp;
  const lib = dirname(createRequire(import.meta.url).resolve('@rrweb/replay'));
  const { chromium } = await import('playwright-core');
  // the screencast films Chrome's window, not the emulated viewport: the window takes the recording's size
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-first-run', '--no-default-browser-check', `--window-size=${size.width},${size.height}`] });
  const part = join(dir, '.replay.part.webm'), mp4 = join(dir, '.replay.part.mp4');
  try {
    const page = await (await browser.newContext({ viewport: size })).newPage();
    await page.setContent('<!doctype html><style>html,body{margin:0;overflow:hidden;background:#fff}.replayer-wrapper{position:relative}</style>');
    await page.addStyleTag({ path: join(lib, 'style.css') });
    await page.addScriptTag({ path: join(lib, 'replay.umd.min.cjs') });
    const film = await screencast(page, part, size);
    // the replay plays at 1× from its first event: the film lasts what the story lasted
    await Promise.race([
      page.evaluate((evs) => new Promise<void>((done) => {
        const r = new (window as unknown as { rrwebReplay: { Replayer: new (e: unknown[], o: object) => { on(n: string, f: () => void): void; play(): void } } }).rrwebReplay.Replayer(evs, { root: document.body, mouseTail: false, skipInactive: false, triggerFocus: false });
        r.on('finish', () => done());
        r.play();
      }), events),
      new Promise((_, no) => setTimeout(() => no(new Error('la réplica no terminó a tiempo')), ms + 60_000)),
    ]);
    if (!(await film.stop())) throw new Error('ffmpeg no dejó vídeo');
    await new Promise<void>((done, fail) => {
      const p = spawn(FFMPEG, ['-loglevel', 'error', '-y', '-i', part, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (c) => (err += c));
      p.on('error', () => fail(new Error('no ffmpeg: reinstall Laru (pnpm install) or install ffmpeg')));
      p.on('close', (code) => (code === 0 ? done() : fail(new Error(`ffmpeg failed: ${err.trim().split('\n').pop()}`))));
    });
    renameSync(mp4, join(dir, 'replay.mp4'));
  } finally {
    await browser.close().catch(() => undefined);
    rmSync(part, { force: true });
    rmSync(mp4, { force: true });
  }
}
