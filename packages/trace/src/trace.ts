/**
 * Trace v1: one test of one run, as the Run screen draws it and the AI reads it. Times are milliseconds from the
 * first frame of the test's video, so the video is the clock. Everything here is already masked.
 */

/** The page the person (or the test) drives, or one of its other screens: `browser`, `browser:luis`. */
export const isBrowser = (id: string) => id === 'browser' || id.startsWith('browser:');
/** The screen a browser actor names (`luis`), or none for the main page. */
export const screenOfActor = (id: string) => (id.startsWith('browser:') ? id.slice(8) : undefined);

export type ParticipantType = 'browser' | 'runner' | 'host' | 'service' | 'datastore' | 'external' | 'tap';

export interface Participant {
  id: string;
  name: string;
  type: ParticipantType;
  /** the map node it is (svc:…, ds:…, ext:…) */
  node?: string;
  /** what it is: spring, postgres, kafka, nginx, chromium… */
  kind?: string;
  /** where it ran: in a container, or on the host (hybrid) */
  where?: 'container' | 'host';
  /** the project it belongs to, when the workspace has more than one */
  project?: string;
}

export type StepStatus = 'passed' | 'failed' | 'skipped' | 'todo';

export interface Step {
  n: number;
  title: string;
  t0: number;
  t1: number;
  status: StepStatus;
  /** masked error message of a failed step */
  error?: string;
  /** what flow.md says should happen in this step */
  expected?: string;
  screenshot?: string;
}

export type ExchangeKind = 'http' | 'sse' | 'sql' | 'kafka' | 'tcp' | 'ws';

export interface Body { bytes: number; text?: string; note?: string }

export interface Exchange {
  id: string;
  kind: ExchangeKind;
  from: string;
  to: string;
  t0: number;
  t1?: number;
  step?: number;
  /**
   * what caused this one, as `causes()` in chain.ts links it (a forward, a delivered message, a relayed notice, the
   * request or consumed message it ran inside); readers recompute `causes()` for how sure the link is
   */
  parent?: string;
  /** GET /api/files, SELECT file_service.files, file.uploaded, stream: OK */
  label: string;
  status?: number;
  ok: boolean;
  /** observed by the tap or a log; derived when inferred (a Kafka consumer, a publisher from the map) */
  origin: 'observed' | 'derived';
  /** collapsed static assets: how many requests this row stands for */
  asset?: number;
  /** map endpoint id matched by method and normalized path */
  endpoint?: string;
  table?: string;
  topic?: string;
  method?: string;
  path?: string;
  query?: string;
  reqHeaders?: Record<string, string>;
  resHeaders?: Record<string, string>;
  req?: Body;
  res?: Body;
  fault?: string;
  mock?: string;
  /** a mail or SMS a sink kept (`cb`: this is the status call it made about it afterwards) */
  msg?: { id: string; kind: 'mail' | 'sms'; to: string; subject?: string; cb?: string };
  drift?: string[];
  error?: string;
  /** ms the tap added to this hop (forwarded http only) */
  tap?: number;
  /** the store's connection that ran a statement (`postgres#123`, the backend's pid) */
  conn?: string;
  /** what a statement returned, as it passed through the tap: its columns, the first rows (masked), how many more, its tag */
  result?: { cols: string[]; rows: string[][]; more: number; tag?: string };
}

/** What the person did on screen, from Playwright's API calls. Never the typed value: only what was acted on. */
export type ActionKind = 'click' | 'dblclick' | 'tap' | 'fill' | 'type' | 'press' | 'check' | 'uncheck' | 'select' | 'files' | 'navigate' | 'back' | 'reload' | 'drag' | 'hover';
export interface Action {
  t0: number;
  t1: number;
  kind: ActionKind;
  /** the locator acted on (`getByRole('button', { name: 'Subir' })`); none for `page.mouse.click` */
  target?: string;
  /** a named key (Enter, Tab, Escape…) */
  key?: string;
  /** where a navigation went, without its query */
  path?: string;
  step?: number;
}

export interface LogLine { id: string; t: number; service: string; level: 'error' | 'warn' | 'info' | 'debug'; line: string }

export interface Failure {
  step: number; message: string; exchange?: string;
  /** every failure of the test, soft ones included */
  all?: string[];
  /** failures on a line with `// app:` (or under its comment): the deviations the app is known to have */
  known?: number;
  /** every other failure: a timeout, a hard assertion, a check nobody documented */
  unexpected?: number;
}

export interface Trace {
  v: 1;
  run: string;
  flow: string;
  test: string;
  env: string;
  /** epoch ms of video frame 0 (videoT0 plus the calibrated offset) */
  t0: number;
  durationMs: number;
  status: 'passed' | 'failed' | 'skipped';
  /** the recorded journey; the others are the flow's short cases */
  story?: boolean;
  /** the number of rows in flow.md's Pasos */
  stepsTotal?: number;
  participants: Participant[];
  steps: Step[];
  exchanges: Exchange[];
  logs: LogLine[];
  failure?: Failure;
  /** host traffic inside the window of a persistent env: someone else used it during the run */
  foreign?: number;
  /** the other screens this test drove (Luis's browser beside Ana's), each with its own video and where its clock stands against the trace's */
  screens?: Array<{ name: string; video?: string; offsetMs?: number; /** the instant of the trace's clock at which the screen's video is at 0 */ startMs?: number }>;
  /** several runners played at once: a hop is this test's only when its chain leads back to one of its own requests */
  concurrent?: boolean;
  video?: string;
  /** Playwright's own trace of this test (a zip, kept beside the video), when the run asked for it: it holds the page and the network UNMASKED */
  pwTrace?: string;
  /** the person's actions, when the reporter recorded them */
  actions?: Action[];
}

/** What the reporter writes to out/events.jsonl while the runner works. */
export type RunnerEvent =
  | { e: 'test-begin'; t: number; test: string; title: string; file: string; story: boolean }
  | { e: 'video-t0'; t: number; test: string }
  | { e: 'marker'; t: number; test: string }
  | { e: 'step-begin'; t: number; test: string; title: string }
  | { e: 'step-end'; t: number; test: string; title: string; t0: number; status: StepStatus; error?: string }
  | { e: 'action'; t: number; test: string; t0: number; ms: number; kind: ActionKind; target?: string; key?: string; path?: string }
  | { e: 'test-end'; t: number; test: string; /** the other screens of the test, each with its own video */ screens?: Array<{ name: string; t0?: number; marker?: number; video?: string }>; status: 'passed' | 'failed' | 'skipped' | 'timedOut' | 'interrupted'; error?: string; errors?: string[]; /** how many of the errors sit on a line the app is known to deviate on (`// app:`), and how many do not */ known?: number; unexpected?: number; video?: string; /** Playwright's trace.zip of this test, when the run asked for it */ pwTrace?: string; durationMs: number }
  | { e: 'end'; t: number; status: string };

export interface RunInfo {
  id: string;
  /** a person using the app with the trace live: no runner, its steps are their marks */
  kind?: 'session';
  /** a session's own name */
  title?: string;
  /** a session: the app's entrance address, to open it in the person's own browser */
  entrance?: string;
  /** a session: which front it opened on (a service of the env) and whether it shows it as a phone */
  front?: string;
  device?: 'phone';
  /** a session: the scenario applied before it began */
  scenario?: string;
  /** a session: the flow (slug) it was opened from, to show it in that flow's sheet */
  flow?: string;
  /** a run that waits for the session recording on its env (its id), until it saves */
  waiting?: string;
  /** what the person should know about where or when it runs (it waits, or went to the flow's own env) */
  note?: string;
  env: string;
  ephemeral: boolean;
  flows: string[];
  phase: 'queued' | 'build' | 'up' | 'tests' | 'evidence' | 'destroy' | 'done';
  status: 'running' | 'passed' | 'failed' | 'error' | 'cancelled' | 'interrupted';
  startedAt: string;
  endedAt?: string;
  pid: number;
  error?: string;
  /** flow slug → its result in this run */
  results: Record<string, { status: 'passed' | 'failed' | 'skipped' | 'cached' | 'error'; ms?: number; steps?: number; failedStep?: number; trace?: string; video?: string; cachedFrom?: string; /** hops that differ from the flow's approved behavior */ drift?: number; /** known deviations it passed with (`// app:`): green, not clean */ known?: number; /** steps and cases whose known deviation stopped failing since the run before */ fixed?: string[] }>;
  /** the commits (or folder trees) the env ran, `vaultflow@cb83e92` */
  sources?: string[];
  clockSkewMs?: number;
  videoOffsetMs?: number;
  /** test → offset measured from its own marker frame */
  videoOffsets?: Record<string, number>;
  /** retention removed its video and screenshots (`media`); the trace and the masked slices stay */
  pruned?: { at: string; what: 'media' | 'all' };
}

/**
 * «Verde», with one meaning: the test played everything and only its known deviations failed (soft checks the spec
 * marks `// app:`). Any other failure is unexpected. A story must also have played every step it documents.
 */
export function isGreen(t: Pick<Trace, 'status' | 'story' | 'steps' | 'stepsTotal' | 'failure'>): boolean {
  if (t.status === 'passed') return true;
  if (t.status !== 'failed' || !t.failure || t.failure.unexpected !== 0 || !t.failure.known) return false;
  return !t.story || t.steps.length >= (t.stepsTotal ?? t.steps.length);
}

/** One line of `traffic.jsonl`. Times are epoch ms on the container clock. Everything is masked at capture. */
export interface TrafficRecord {
  v: 1;
  id: string;
  kind: 'http' | 'sse' | 'tcp' | 'ws' | 'pg';
  t0: number;
  t1?: number;
  /** client IP as the tap saw it */
  from: string;
  /** the screen of a test the request came from (`luis`), named by a token the tap took off the request before it reached the app */
  screen?: string;
  svc: string;
  port: number;
  method?: string;
  path?: string;
  query?: string;
  status?: number;
  reqHeaders?: Record<string, string>;
  resHeaders?: Record<string, string>;
  req?: { bytes: number; text?: string; note?: string };
  res?: { bytes: number; text?: string; note?: string };
  /** for sse: the event, one line per event */
  event?: { name?: string; data?: string };
  /** for tcp: masked printable peek of the first and last bytes */
  peek?: { up?: string; down?: string };
  fault?: string;
  /** what a sink kept: the message this record is, or (`cb`) the status call it made about it */
  msg?: { id: string; kind: 'mail' | 'sms'; to: string; subject?: string; cb?: string };
  mock?: string;
  /** where a request strayed from the mock's contract */
  drift?: string[];
  error?: string;
  /** a Postgres statement's result as it passed (kind `pg`): the backend's pid ties it to the server's log; values masked */
  pg?: { pid?: number; stmt: string; cols: string[]; rows: string[][]; more: number; tag?: string; error?: string };
  /** a forwarded http exchange: ms the tap itself added (until the request left for upstream, and from its answer to the client's) */
  tap?: number;
}
