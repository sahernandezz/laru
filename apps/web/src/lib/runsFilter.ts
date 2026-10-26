/** The Runs list's filters: by flow and by status, kept in the address (`#/runs?flujo=…&estado=…`). */
import type { RunInfo } from '../api.ts';

export interface RunFilters { flujo: string; estado: string }
export const NO_FILTERS: RunFilters = { flujo: '', estado: '' };

export const filtersOf = (q: URLSearchParams): RunFilters => ({ flujo: q.get('flujo') ?? '', estado: q.get('estado') ?? '' });
export function queryString(f: RunFilters): string {
  const p = new URLSearchParams();
  if (f.flujo) p.set('flujo', f.flujo);
  if (f.estado) p.set('estado', f.estado);
  return p.size ? `?${p}` : '';
}
/** A run matches when it ran the flow (a session has none) and has the status; an empty filter matches all. */
export const matches = (r: Pick<RunInfo, 'flows' | 'status'>, f: RunFilters) => (!f.flujo || r.flows.includes(f.flujo)) && (!f.estado || r.status === f.estado);
export const filterRuns = <T extends Pick<RunInfo, 'flows' | 'status'>>(list: T[], f: RunFilters): T[] => list.filter((r) => matches(r, f));
/** Every flow that appears in the runs, sorted: the options of the flow filter. */
export const flowsOf = (list: Array<Pick<RunInfo, 'flows'>>): string[] => [...new Set(list.flatMap((r) => r.flows))].sort();
