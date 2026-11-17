import { useApi, type EnvSummary } from '../api.ts';
import { partsOf } from './route.ts';

/** The flow whose environment a data screen is on: its address names an instance (`#/data/f-<flow>/…`), which is `flow:<flow>`'s own. */
export const flowOfEnv = (hash = location.hash) => { const e = partsOf(hash)[1]; return e && /^f-./.test(e) ? `flow:${e.slice(2)}` : undefined; };

/**
 * The environments a data screen may show. On a flow's own environment it is that one and nothing else; otherwise the
 * project's, never a flow's: each flow runs isolated, with its own data and variables, and none of it mixes with the
 * other flows' or with the global ones. An app by URL never: its data live where it does.
 */
export function useEnvList() {
  const r = useApi<EnvSummary[]>('/api/envs');
  const own = partsOf(location.hash)[1];
  const mine = own && /^f-./.test(own) ? own : undefined;
  // an app by URL has no store, queue or mailbox Laru opens: it is no data screen's env
  return { ...r, data: r.data?.filter((e) => !e.url && (mine ? e.env === mine : !/^f-/.test(e.env))) };
}
