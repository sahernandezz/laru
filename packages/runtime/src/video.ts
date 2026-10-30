/**
 * One video for a flow that was played on several screens (Ana's browser beside Luis's, or the front of one app beside
 * the front of another): every screen's own video side by side on the clock of the main one, each starting when its
 * person opened it. A page nobody had opened yet records a magenta placeholder; it is drawn black here. Made on the
 * first request with ffmpeg and kept beside the others (`video-all.mp4`).
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { Trace } from '@laru/trace';
import type { Workspace } from '@laru/core';
import { FFMPEG, flowDir, readRun, runDir } from './runs.ts';

const TILE = { w: 960, h: 540 };
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

/** ffmpeg's graph: each input scaled to a tile, its magenta turned black, delayed by when it opened; then side by side. */
export function graph(starts: number[]): string {
  const tile = (i: number, start: number) =>
    `[${i}:v]scale=${TILE.w}:${TILE.h}:force_original_aspect_ratio=decrease,pad=${TILE.w}:${TILE.h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=25,format=rgba,colorkey=0xFF00FF:0.35:0.1[k${i}];` +
    `color=c=black:s=${TILE.w}x${TILE.h}:r=25[b${i}];[b${i}][k${i}]overlay=shortest=1,format=yuv420p,tpad=start_duration=${Math.max(0, start) / 1000}:color=black[v${i}]`;
  return `${starts.map((s, i) => tile(i, s)).join(';')};${starts.map((_, i) => `[v${i}]`).join('')}hstack=inputs=${starts.length}[out]`;
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
  const out = join(dir, 'video-all.mp4'), tmp = `${out}.part.mp4`, rel = `flows/${slug}/video-all.mp4`;
  if (existsSync(out) && inputs.every((f) => statSync(f).mtimeMs <= statSync(out).mtimeMs)) return rel;
  rmSync(tmp, { force: true });
  try {
    await new Promise<void>((done, fail) => {
      const p = spawn(FFMPEG, ['-loglevel', 'error', '-y', ...inputs.flatMap((f) => ['-i', f]), '-filter_complex', graph([0, ...screens.map((s) => s.startMs)]), '-map', '[out]',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', tmp], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (c) => (err += c));
      p.on('error', () => fail(new Error('no ffmpeg: reinstall Laru (pnpm install) or install ffmpeg')));
      p.on('close', (code) => (code === 0 ? done() : fail(new Error(`ffmpeg failed: ${err.trim().split('\n').pop()}`))));
    });
    renameSync(tmp, out);
  } finally { rmSync(tmp, { force: true }); }
  return rel;
}
