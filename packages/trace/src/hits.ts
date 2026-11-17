/**
 * An env by URL has no tap between the browser and the app, so the browser is the tap: each request the page makes is
 * kept as Playwright gives it (a hit), raw, by the session's browser on this Mac or by a runner's browser, and the
 * service turns each into a tap record, masked, in the env's journal (runtime/src/urlenv.ts). Only what a tap would
 * keep is read: a textual body's head, never a file being uploaded or a picture. What the page says in its console,
 * and the errors it throws, are the browser's log, as a service's are its own.
 */

/** One request as the browser saw it. Bodies are base64 and only textual ones, cut where the tap cuts. */
export interface BrowserHit {
  t0: number;
  t1: number;
  method: string;
  url: string;
  status?: number;
  reqHeaders: Record<string, string>;
  resHeaders?: Record<string, string>;
  reqBytes: number;
  resBytes?: number;
  req?: string;
  res?: string;
  /** another screen of a test (`luis`): its context says whose it is, as the tap reads it off a token */
  screen?: string;
  /** what the browser says went wrong (net::ERR_CONNECTION_REFUSED, an abort) */
  error?: string;
}

/** What Playwright gives of a request, in both of its packages (the runner's @playwright/test and the service's playwright-core). */
interface PwRequest {
  url(): string;
  method(): string;
  timing(): { startTime: number; responseEnd: number };
  allHeaders(): Promise<Record<string, string>>;
  postDataBuffer(): Buffer | null;
  response(): Promise<{ status(): number; allHeaders(): Promise<Record<string, string>>; body(): Promise<Buffer> } | null>;
  failure(): { errorText: string } | null;
}

/** The tap keeps a body's first 64 KB and the masker's margin, which the cut removes (tap.ts TEE). */
const KEEP = 64 * 1024 + 4096;
/** Bodies a person reads: JSON, XML, forms, text (not scripts or styles, which the trace folds as resources). */
const READ = /^text\/(?!css|javascript)|json|xml|x-www-form-urlencoded/i;

export async function hitOf(q: PwRequest, o: { screen?: string } = {}): Promise<BrowserHit | undefined> {
  const url = q.url();
  if (!/^https?:/i.test(url)) return undefined; // data:, blob: and the browser's own pages are no request to the app
  const t = q.timing();
  const res = await q.response().catch(() => null);
  const reqHeaders = await q.allHeaders().catch(() => ({} as Record<string, string>));
  const resHeaders = res ? await res.allHeaders().catch(() => ({} as Record<string, string>)) : undefined;
  const post = q.postDataBuffer();
  // a redirect has no body to give, and a body that is not read is only counted
  const body = res && READ.test(resHeaders?.['content-type'] ?? '') ? await res.body().catch(() => undefined) : undefined;
  const failure = q.failure()?.errorText;
  return {
    t0: Math.round(t.startTime), t1: Math.round(t.responseEnd >= 0 ? t.startTime + t.responseEnd : Date.now()), method: q.method(), url,
    ...(res ? { status: res.status() } : {}), reqHeaders, ...(resHeaders ? { resHeaders } : {}),
    reqBytes: post?.length ?? 0, ...(post && READ.test(reqHeaders['content-type'] ?? '') ? { req: post.subarray(0, KEEP).toString('base64') } : {}),
    ...(res ? { resBytes: body?.length ?? (Number(resHeaders?.['content-length']) || 0) } : {}), ...(body ? { res: body.subarray(0, KEEP).toString('base64') } : {}),
    ...(o.screen ? { screen: o.screen } : {}), ...(failure ? { error: failure } : {}),
  };
}

/** The level of a console message (Playwright's type) or of an uncaught error of the page (`pageerror`), as the trace says levels. */
export const consoleLevel = (type: string): 'error' | 'warn' | 'debug' | 'info' => (type === 'error' || type === 'pageerror' ? 'error' : type === 'warning' ? 'warn' : type === 'debug' || type === 'trace' ? 'debug' : 'info');
