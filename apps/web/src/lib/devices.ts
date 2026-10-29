/**
 * The devices a trace heard from: who, outside the app, sent what. A test's screens are already apart
 * (`browser:luis`); a sender no service is (`?172.30.1.12`) is that machine; everything else that came in through the
 * gateway (the person's browser, their phone, an app, curl) shares its address and is told apart by its User-Agent. An exchange belongs to the device that sent it, or to the one whose request caused it.
 */
import { isBrowser, type Exchange, type Trace } from '@laru/trace';
import type { Cause } from '@laru/trace/chain';

export interface Device { name: string; count: number }
export interface Devices { of: Map<string, string>; list: Device[]; /** the one Laru's own browser is: the person's (or the test's) actions are its */ actor?: string }

const outside = (from: string) => isBrowser(from) || from === 'host' || from === 'runner' || from.startsWith('?');

/** A User-Agent as a person says it: «Safari en iPhone», «Chrome en Windows», «okhttp». */
export function deviceName(ua?: string): string {
  if (!ua) return 'Sin identificar';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows'
    : /Macintosh|Mac OS X/.test(ua) ? 'Mac' : /CFNetwork|Darwin/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  const app = /HeadlessChrome/.test(ua) ? 'Chromium de Laru' : /Edg[A]?\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\/|FxiOS/.test(ua) ? 'Firefox'
    : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : ua.split(/[\s/(]/)[0] || ua;
  return os ? `${app} en ${os}` : app;
}

/**
 * exchange id → the device it belongs to. An SSE event names its sender by its stream's request (newer traces keep its
 * User-Agent on the event itself); one opened before the trace began goes with the one device its sender is, when it is
 * only one. What a device's request caused goes with it; what nothing outside caused (a job, a consumer) belongs to none.
 */
// Known limit: two devices with the same User-Agent (two iPhones on the same Safari) are one; the tap's client IP would split them if it reached the trace.
export function devicesOf(trace: Pick<Trace, 'exchanges' | 'participants'>, cause: Map<string, Cause>): Devices {
  const byId = new Map(trace.exchanges.map((e) => [e.id, e]));
  const names = new Map(trace.participants.map((p) => [p.id, p.name]));
  const uaOf = (e: Exchange) => e.reqHeaders?.['user-agent'] ?? (e.kind === 'sse' ? byId.get(e.id.replace(/\.\d+$/, ''))?.reqHeaders?.['user-agent'] : undefined);
  // each sender behind the gateway → the devices it was, by their User-Agents
  const senders = new Map<string, Set<string>>();
  for (const e of trace.exchanges) { const ua = ['browser', 'host', 'runner'].includes(e.from) && uaOf(e); if (ua) senders.set(e.from, (senders.get(e.from) ?? new Set()).add(deviceName(ua))); }
  const own = (e: Exchange): string | undefined => {
    if (!outside(e.from)) return undefined;
    if (e.from.startsWith('browser:')) return names.get(e.from) ?? e.from;
    if (e.from.startsWith('?')) return `Equipo ${e.from.slice(1)}`;
    // the test's own calls (`request.post`), not its browser's: the test is the device
    if (e.from === 'runner') return names.get('runner') ?? 'Prueba';
    const ua = uaOf(e), only = senders.get(e.from);
    return ua ? deviceName(ua) : only?.size === 1 ? [...only][0] : e.from === 'host' ? 'Tu máquina' : names.get(e.from) ?? e.from;
  };
  const of = new Map<string, string>();
  for (const e of trace.exchanges) {
    let d = own(e);
    // up its causes to the request from outside that began it
    for (let p = cause.get(e.id)?.parent, i = 0; !d && p && i < 200; p = cause.get(p)?.parent, i++) { const x = byId.get(p); if (x) d = own(x); }
    if (d) of.set(e.id, d);
  }
  const count = new Map<string, number>();
  for (const d of of.values()) count.set(d, (count.get(d) ?? 0) + 1);
  const own0 = trace.exchanges.find((e) => e.from === 'browser' && /HeadlessChrome/.test(e.reqHeaders?.['user-agent'] ?? ''));
  return { actor: own0 && of.get(own0.id), of, list: [...count].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count) };
}

/** The trace with only what one device sent and caused; its lanes, only those still talking; the actions, only Laru's browser's. */
export function onlyDevice<T extends Pick<Trace, 'exchanges' | 'participants'> & { actions?: Trace['actions'] }>(trace: T, d: Devices, device: string): T {
  const exchanges = trace.exchanges.filter((e) => d.of.get(e.id) === device);
  const used = new Set(exchanges.flatMap((e) => [e.from, e.to]));
  return { ...trace, exchanges, participants: trace.participants.filter((p) => used.has(p.id)), ...(trace.actions && device !== d.actor ? { actions: [] } : {}) };
}
