/** Hash routes: every object has an address, and reloading returns to it. */
import { useEffect, useState } from 'react';

/** An address's parts, decoded. */
export const partsOf = (hash: string) => hash.replace(/^#\/?/, '').split('?')[0].split('/').map(decodeURIComponent).filter(Boolean);
/** The `?a=b` of a hash route (filters, kept in the address): `#/runs?flujo=x&estado=failed`. */
export const queryOf = (hash: string) => new URLSearchParams(hash.split('?')[1] ?? '');

export function useRoute(): string[] {
  const read = () => partsOf(location.hash);
  const [parts, set] = useState(read);
  useEffect(() => {
    const on = () => set((cur) => { const now = read(); return now.join('/') === cur.join('/') ? cur : now; });
    addEventListener('hashchange', on);
    // An address replaced during the first render (a moved one) can change before this listens: read it again.
    on();
    return () => removeEventListener('hashchange', on);
  }, []);
  return parts;
}

export const href = (...parts: string[]) => '#/' + parts.map(encodeURIComponent).join('/');
/** Where a session still open is watched: in the sheet of the flow it was opened from, else on its own screen. */
export const liveHref = (r: { id: string; flow?: string }) => (r.flow ? href('docs', `flow:${r.flow}`, 't', 'live', r.id) : href('live', r.id));

/** The workspace a page serves, from its path (`/w/<id>/`, then the hash route as always); none on the home page. */
export const wsOf = (pathname: string) => { const m = /^\/w\/([^/]+)\//.exec(pathname); return m ? decodeURIComponent(m[1]) : undefined; };
/** The machine's routes, and a route already under a workspace: never prefixed. */
const MACHINE = /^\/api\/(ping|workspaces|machine|w)(\/|\?|$)/;
/** A workspace's API path under its id (`/api/runs` → `/api/w/<id>/runs`); everything else as it is. */
export const apiUrlFor = (ws: string | undefined, p: string) => (ws && p.startsWith('/api/') && !MACHINE.test(p) ? `/api/w/${encodeURIComponent(ws)}/${p.slice(5)}` : p);
/** A workspace's page, keeping the hash route: a switch is a full load, so nothing of the other workspace stays. */
export const wsPage = (id: string, hash = '') => `/w/${encodeURIComponent(id)}/${hash}`;

/**
 * The screen of a route without what it points at: `#/mocks/local/api-gateway` → `#/mocks`. Another workspace has no
 * `api-gateway`, no run 44 and no piece `flow:x`, so switching to it keeps the screen and leaves the rest behind.
 */
export const screenOnly = (hash: string) => { const [screen] = partsOf(hash); return screen ? `#/${encodeURIComponent(screen)}` : ''; };

/** The home page asked for by name, as every link inside Laru does: shown even with one workspace registered. */
export const HOME = '/?home';

/**
 * Where the home page sends the browser, or null to show itself: the only registered workspace, or an address from
 * before workspaces had paths (`/#/runs/44`) to the one opened last (rows come most recently opened first). Never
 * when the page was asked for by name (HOME): «Esta máquina» lives there.
 */
export function homeRedirect(hash: string, rows: Array<{ id: string | null; exists: boolean }>, search = ''): string | null {
  if (new URLSearchParams(search).has('home')) return null;
  const open = rows.filter((r) => r.exists && r.id);
  if (rows.length === 1 && open.length === 1) return wsPage(open[0].id!, hash);
  if (/^#\/./.test(hash) && open.length) return wsPage(open[0].id!, hash);
  return null;
}
/**
 * «Paso a paso» as a suffix on a flow's address (`…/paso-a-paso/<stop>`), on the flow page and in Runs alike. Read from
 * the end: the stop is one part, or a response row's `<id>/respuesta`; whatever comes before is the screen's own.
 */
export const STEP = 'paso-a-paso';
export function splitStop(parts: string[]): [string[], string | undefined] {
  const n = parts.length;
  if (n >= 3 && parts[n - 3] === STEP && parts[n - 1] === 'respuesta') return [parts.slice(0, n - 3), `${parts[n - 2]}/respuesta`];
  if (n >= 2 && parts[n - 2] === STEP) return [parts.slice(0, n - 2), parts[n - 1]];
  return [parts, undefined];
}
/** The address with a stop, or without one. */
export const withStop = (base: string, stop?: string) => (stop ? `${base}/${STEP}/${stop.split('/').map(encodeURIComponent).join('/')}` : base);
/** The stop an address names, and its suffix as written (to keep it when the screen rewrites the rest). */
export const stopIn = (hash: string) => splitStop(partsOf(hash))[1];
export const stopSuffix = (hash: string) => withStop('', stopIn(hash));

/** Services, stores and externals are documented on the map; everything else in the documentation. */
const ON_MAP = /^(svc|ds|ext):/;
export const pageOf = (id: string) => (ON_MAP.test(id) ? href('map', id) : href('docs', id));

/**
 * Where an address that moved lives now, or null. Services and their map share «Mapa y servicios»; a service, store or external is documented on its map sheet (its edit form stays in docs).
 */
export function moved(parts: string[]): string | null {
  const [screen, id] = parts;
  if (screen === 'services') return id ? href('map', `svc:${id}`) : href('map');
  if (screen === 'findings' || (screen === 'flows' && id)) return href('docs');
  if (screen === 'docs' && parts.length === 2 && ON_MAP.test(id)) return href('map', id);
  return null;
}

/**
 * Where a flow's last run failed, in an address that says which test: the flow on the map, with the case that failed
 * when the story did not. Nothing when it did not fail.
 */
export function whereFailed(f: { id: string; last: { status: string; failure?: unknown; cases: Array<{ test: string; status: string }> } | null }): string | undefined {
  if (f.last?.status !== 'failed') return undefined;
  const c = f.last.failure ? undefined : f.last.cases.find((x) => x.status === 'failed');
  return href('docs', f.id, 'map', ...(c ? [c.test] : []));
}


/**
 * A MongoDB _id as its address, read back by /api/mongo/doc: an ObjectId by its hex, a string as itself unless it would
 * read as another type (`"5"`, `"true"`, 24 hex digits: then quoted) or is empty (`""`), anything else as its Extended JSON.
 */
export function idOf(id: unknown): string | undefined {
  if (id === undefined) return undefined;
  if (id && typeof id === 'object' && '$oid' in id) return String((id as { $oid: unknown }).$oid);
  if (typeof id !== 'string') return JSON.stringify(id);
  // An empty _id is quoted too: an empty part is no part of an address.
  let other = id === '' || /^[0-9a-fA-F]{24}$/.test(id);
  try { JSON.parse(id); other = true; } catch { /* only a string */ }
  return other ? JSON.stringify(id) : id;
}

/** Whether a part reads as one quoted JSON string. */
const quoted = (s: string) => /^".*"$/s.test(s);
/**
 * A Redis key as its address: its name, quoted as JSON when bare it would be lost (empty: an empty part is no part of
 * an address) or read as a quoted one. `keyOf` reads it back.
 */
export const keyAddress = (name: string) => (name === '' || quoted(name) ? JSON.stringify(name) : name);
export function keyOf(address: string): string {
  if (quoted(address)) { try { return String(JSON.parse(address)); } catch { /* a bare name that looks quoted */ } }
  return address;
}
/**
 * Whether an open Redis key's name is masked, so the key cannot be asked for by it: true once any list loaded since
 * flagged it (`seen` keeps those names across lists), false when the list has it unflagged, undefined when the list
 * does not say (another pattern, past the cap, a list that failed).
 */
export function keyMasked(name: string, list: Array<{ key: string; masked?: true }>, seen: Set<string>): boolean | undefined {
  for (const k of list) if (k.masked) seen.add(k.key);
  return seen.has(name) || (list.some((k) => k.key === name) ? false : undefined);
}
