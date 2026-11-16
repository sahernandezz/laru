/**
 * One video for a flow that was played on several screens (Ana's browser beside Luis's, or the front of one app beside
 * the front of another): every screen's own video side by side on the clock of the main one, each starting when its
 * person opened it. A page nobody had opened yet records a magenta placeholder; it is drawn black here. Made on the
 * first request with ffmpeg and kept beside the others (`video-all.mp4`).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { Trace } from '@laru/trace';
import type { Workspace } from '@laru/core';
import { FFMPEG, flowDir, readRun, runDir } from './runs.ts';

/** The exported video is at most this wide and this tall: side by side, the screens share one height. */
const MAX = { w: 3840, h: 1080 };
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
/** what the runner wrote in trace.json and run.json is a name or a path inside the run, never a way out of it */
const INSIDE = /^(?:[\w-]+\/)*[\w.-]+$/;
const inside = (p: string) => INSIDE.test(p) && !p.split('/').includes('..');
/** the real file of `rel` under `base`, or nothing when it is missing or a link leads out of `base` */
function real(base: string, rel: string): string | undefined {
  if (!inside(rel)) return undefined;
  try { const f = realpathSync(join(base, rel)); return f.startsWith(realpathSync(base) + sep) ? f : undefined; } catch { return undefined; }
}
/** one encode at a time per video: a second request waits for the first instead of writing the same file */
const making = new Map<string, Promise<string>>();

/**
 * Each screen's tile: all of one height, each as wide as its own shape asks (a phone narrow and tall, a pc wide), so none
 * is shrunk into another's frame between bands. The height is the tallest screen's, up to 1080, lowered until the row
 * fits 3840 wide.
 */
export function tiles(sizes: Array<{ width: number; height: number }>): Array<{ w: number; h: number }> {
  const aspect = sizes.map((s) => s.width / s.height);
  let h = Math.min(MAX.h, Math.max(...sizes.map((s) => s.height)));
  const sum = aspect.reduce((a, b) => a + b, 0);
  if (h * sum > MAX.w) h = MAX.w / sum;
  h = Math.max(2, Math.floor(h / 2) * 2); // even, and never above what fits
  return aspect.map((a) => ({ w: even(h * a), h }));
}

/** ffmpeg's graph: each input scaled to its tile, its magenta turned black, delayed by when it opened; then side by side. */
export function graph(screens: Array<{ w: number; h: number; start: number }>): string {
  const tile = ({ w, h, start }: (typeof screens)[number], i: number) =>
    `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=25,format=rgba,colorkey=0xFF00FF:0.35:0.1[k${i}];` +
    `color=c=black:s=${w}x${h}:r=25[b${i}];[b${i}][k${i}]overlay=shortest=1,format=yuv420p,tpad=start_duration=${Math.max(0, start) / 1000}:color=black[v${i}]`;
  return `${screens.map(tile).join(';')};${screens.map((_, i) => `[v${i}]`).join('')}hstack=inputs=${screens.length}[out]`;
}

/** A file's content, as a SHA-256: what says a recorded video is this very one. */
function hashOf(file: string): Promise<string> {
  return new Promise((done, fail) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (c) => h.update(c)).on('error', fail).on('end', () => done(h.digest('hex')));
  });
}

/** A video's frame size, as ffmpeg reads it (ffmpeg-static comes without ffprobe). */
function sizeOf(file: string): Promise<{ width: number; height: number }> {
  return new Promise((done) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (c) => (err += c));
    p.on('error', () => done({ width: 1280, height: 720 }));
    p.on('close', () => { const m = /Video:.*?\b(\d{2,5})x(\d{2,5})\b/.exec(err); done(m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 1280, height: 720 }); });
  });
}

/** The flow's single video, relative to the run folder (`flows/<slug>/video-all.mp4`); throws when the flow had one screen. */
export function combineScreens(ws: Workspace, id: string, slug: string): Promise<string> {
  const key = `${runDir(ws, id)}/${slug}`;
  const going = making.get(key) ?? make(ws, id, slug).finally(() => making.delete(key));
  making.set(key, going);
  return going;
}

async function make(ws: Workspace, id: string, slug: string): Promise<string> {
  const r = readRun(ws, id)?.results[slug];
  const dir = flowDir(ws, id, slug), run = runDir(ws, id);
  const main = r?.video && r.trace ? real(run, r.video) : undefined, traceFile = r?.trace ? real(run, r.trace) : undefined;
  if (!main || !traceFile) throw new Error(`flow ${slug} of run ${id} has no video`);
  const trace = JSON.parse(readFileSync(traceFile, 'utf8')) as Trace;
  const screens = (trace.screens ?? []).flatMap((s) => { const f = s.video && Number.isFinite(s.startMs) ? real(dir, s.video) : undefined; return f ? [{ startMs: s.startMs!, file: f }] : []; });
  if (!screens.length) throw new Error(`flow ${slug} has one screen: its own video is the only one`);
  const inputs = [main, ...screens.map((s) => s.file)];
  const layout = tiles(await Promise.all(inputs.map(sizeOf)));
  const starts = [0, ...screens.map((s) => s.startMs)];
  const out = join(dir, 'video-all.mp4'), tmp = `${out}.part.mp4`, rel = `flows/${slug}/video-all.mp4`;
  // kept while it is newer than its screens and was made by this very layout (each tile and each start, written beside it):
  // one exported before (960x540 tiles, or with no record of how) is made again
  const made = JSON.stringify({ tiles: layout, starts }), record = join(dir, 'video-all.json');
  if (existsSync(out) && inputs.every((f) => statSync(f).mtimeMs <= statSync(out).mtimeMs)) {
    let had = ''; try { had = readFileSync(record, 'utf8'); } catch { /* none: made before records were kept */ }
    // the record is of this very file (its content's hash): a video put there another way is not taken for it
    if (had === `${made}\n${await hashOf(out)}`) return rel;
  }
  rmSync(tmp, { force: true });
  try {
    await new Promise<void>((done, fail) => {
      const p = spawn(FFMPEG, ['-loglevel', 'error', '-y', ...inputs.flatMap((f) => ['-i', f]), '-filter_complex', graph(layout.map((t, i) => ({ ...t, start: starts[i] }))), '-map', '[out]',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', tmp], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (c) => (err += c));
      p.on('error', () => fail(new Error('no ffmpeg: reinstall Laru (pnpm install) or install ffmpeg')));
      p.on('close', (code) => (code === 0 ? done() : fail(new Error(`ffmpeg failed: ${err.trim().split('\n').pop()}`))));
    });
    renameSync(tmp, out);
    writeFileSync(record, `${made}\n${await hashOf(out)}`);
  } finally { rmSync(tmp, { force: true }); }
  return rel;
}
