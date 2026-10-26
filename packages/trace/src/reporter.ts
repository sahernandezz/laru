/**
 * The runner's reporter: one line per moment that matters, appended to /ks/out/events.jsonl as it happens, so the
 * host can follow a run live and assemble its traces afterwards. Only top-level `step()`s count as flow steps; the
 * person's actions (Playwright's clicks, fills, navigations…) are marks inside them.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FullResult, Reporter, Suite, TestCase, TestError, TestResult, TestStep } from '@playwright/test/reporter';
import type { ActionKind, RunnerEvent } from './trace.ts';

const FILE = process.env.KS_EVENTS ?? '/ks/out/events.jsonl';
const write = (e: RunnerEvent) => { mkdirSync(dirname(FILE), { recursive: true }); appendFileSync(FILE, JSON.stringify(e) + '\n'); };
/** The message of an assertion with what it expected and received, on one line. */
const firstLine = (s?: string) => {
  if (!s) return undefined;
  const lines = s.replace(/\u001b\[[0-9;]*m/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  const head = lines[0] ?? '';
  const detail = lines.filter((l) => /^(Expected|Received|Locator|Call log|Timeout)\b/.test(l) && !/^Call log/.test(l)).slice(0, 3);
  return [head, ...detail].join(' · ').slice(0, 600);
};

/** Playwright's API step titles a person's action has, by their prefix. The rest of a title is never kept: it holds the typed value. */
const ACTION = /^(Click|Double click|Tap|Fill|Type|Insert|Press|Check|Uncheck|Select option|Set input files|Navigate|Go back|Reload|Drag and drop|Hover)\b/;
const KIND: Record<string, ActionKind> = {
  Click: 'click', 'Double click': 'dblclick', Tap: 'tap', Fill: 'fill', Type: 'type', Insert: 'type', Press: 'press', Check: 'check', Uncheck: 'uncheck',
  'Select option': 'select', 'Set input files': 'files', Navigate: 'navigate', 'Go back': 'back', Reload: 'reload', 'Drag and drop': 'drag', Hover: 'hover',
};
/** A key worth naming; a letter is what was typed, so it is dropped. */
const NAMED_KEY = /^(?:(?:Control|Shift|Alt|Meta|ControlOrMeta)\+)*(?:Enter|Tab|Escape|Backspace|Delete|Arrow\w+|Home|End|PageUp|PageDown|Space|F\d{1,2})$/;
/** A navigation's path, without its query: the url may be absolute, scheme-less (`example.com/a`) or a path. */
const pathOf = (u: string) => { try { return new URL(/^[a-z][\w+.-]*:\/\//i.test(u) || u.startsWith('/') ? u : `http://${u}`, 'http://x').pathname; } catch { return undefined; } };

/** Whether a failure sits on a line the spec marks `// app:`: on the line itself, or under the comment lines just above it. */
export function onKnownDeviation(e: Pick<TestError, 'location'>, read: (file: string) => string = (f) => readFileSync(f, 'utf8')): boolean {
  const at = e.location;
  if (!at) return false;
  let lines: string[];
  try { lines = read(at.file).split('\n'); } catch { return false; }
  if (/\/\/\s*app:/.test(lines[at.line - 1] ?? '')) return true;
  for (let i = at.line - 2; i >= 0 && /^\s*\/\//.test(lines[i] ?? ''); i--) if (/^\s*\/\/\s*app:/.test(lines[i])) return true;
  return false;
}

/** A person's action as its mark, or nothing for any other API call (an evaluate, a screenshot, a wait). */
export function actionOf(test: string, step: Pick<TestStep, 'category' | 'title' | 'subtitle' | 'params' | 'startTime' | 'duration'>): RunnerEvent | undefined {
  const k = step.category === 'pw:api' ? ACTION.exec(step.title)?.[1] : undefined;
  if (!k) return;
  const kind = KIND[k];
  const key = kind === 'press' ? String(step.params?.key ?? /^Press "(.*)"$/.exec(step.title)?.[1] ?? '') : '';
  const path = kind === 'navigate' && step.subtitle ? pathOf(step.subtitle) : undefined;
  return {
    e: 'action', t: Date.now(), test, t0: step.startTime.getTime(), ms: step.duration, kind,
    ...(step.subtitle && kind !== 'navigate' ? { target: step.subtitle } : {}), ...(path ? { path } : {}), ...(NAMED_KEY.test(key) ? { key } : {}),
  };
}

export default class LaruReporter implements Reporter {
  onTestBegin(test: TestCase) {
    // The spec file, not where test() was called: a story() is declared inside @laru/flow.
    let suite: Suite | undefined = test.parent;
    while (suite && suite.type !== 'file') suite = suite.parent;
    write({ e: 'test-begin', t: Date.now(), test: test.id, title: test.title, file: suite?.location?.file ?? test.location.file, story: test.tags.includes('@story') });
  }

  onStepBegin(test: TestCase, _r: TestResult, step: TestStep) {
    if (step.category === 'test.step' && !step.parent) write({ e: 'step-begin', t: Date.now(), test: test.id, title: step.title });
  }

  onStepEnd(test: TestCase, _r: TestResult, step: TestStep) {
    const action = actionOf(test.id, step);
    if (action) return write(action);
    if (step.category !== 'test.step' || step.parent) return;
    write({ e: 'step-end', t: Date.now(), test: test.id, title: step.title, t0: step.startTime.getTime(), status: step.error ? 'failed' : 'passed', error: firstLine(step.error?.message) });
  }

  /** Why a test was cut, in the words the interface shows: the limit it ran under, and where that comes from. */
  private cut(test: TestCase): string {
    const slug = test.location.file.split('/').pop()?.replace(/\.spec\.ts$/, '') ?? '';
    const own = (JSON.parse(process.env.KS_FLOW_TIMEOUTS_JSON ?? '{}') as Record<string, number>)[slug];
    const ms = own ?? test.timeout;
    const secs = ms >= 1000 ? `${Number((ms / 1000).toFixed(1))} s` : `${ms} ms`;
    return own ? `Cortado a los ${secs} por el límite del flujo (timeout de su flow.md)` : `Cortado a los ${secs}: el límite del runner; cada flujo puede fijar el suyo con timeout en su flow.md`;
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const v0 = result.annotations.find((a) => a.type === 'videoT0')?.description ?? test.annotations.find((a) => a.type === 'videoT0')?.description;
    if (v0) write({ e: 'video-t0', t: Number(v0), test: test.id });
    const marker = result.annotations.find((a) => a.type === 'marker')?.description;
    if (marker) write({ e: 'marker', t: Number(marker), test: test.id });
    const video = result.attachments.find((a) => a.name === 'video')?.path;
    const pwTrace = result.attachments.find((a) => a.name === 'trace')?.path;
    // the test's other screens: each with the instant its video began, the marker it drew and the video it left
    const screens = [...new Map([...result.annotations, ...test.annotations].filter((a) => a.type === 'screen').flatMap((a) => { try { const s = JSON.parse(a.description ?? '') as { name: string; t0?: number; marker?: number }; return [[s.name, { ...s, video: result.attachments.find((x) => x.name === `video:${s.name}`)?.path }] as const]; } catch { return []; } })).values()];
    const errors = result.errors.map((e) => firstLine(e.message)).filter((x): x is string => Boolean(x));
    // a cut test (timeout, interrupted) is never a deviation, whatever line it was cut on
    const cut = result.status === 'timedOut' || result.status === 'interrupted';
    const known = cut ? 0 : result.errors.filter((e) => onKnownDeviation(e)).length;
    write({ e: 'test-end', t: Date.now(), test: test.id, status: result.status, error: result.status === 'timedOut' ? this.cut(test) : firstLine(result.error?.message), errors: errors.length > 1 ? errors : undefined, ...(screens.length ? { screens } : {}), ...(result.status === 'passed' ? {} : { known, unexpected: Math.max(cut ? 1 : 0, result.errors.length - known) }), video, pwTrace, durationMs: result.duration });
  }

  onEnd(result: FullResult) {
    write({ e: 'end', t: Date.now(), status: result.status });
  }

  printsToStdio() { return false; }
}
