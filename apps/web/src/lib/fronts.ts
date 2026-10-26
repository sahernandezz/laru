import type { Indexed } from '../api.ts';

/** The fronts of an env that a browser can open: the HTTP addresses the map calls a web service, or whose name reads as a front (`frontend`, `audit-web`). */
export const FRONT_NAME = /^(frontend|front|web|ui|portal|app|site|www)$|-(web|front|frontend|ui)$/;

export function frontsOf<A extends { kind: string; service: string }>(addresses: A[], kindOf: (service: string) => string | undefined): A[] {
  return addresses.filter((a) => a.kind === 'http' && (['web', 'mobile'].includes(kindOf(a.service) ?? '') || FRONT_NAME.test(a.service)));
}

/** Which front an address belongs to: the one whose origin it starts with. */
export const frontAt = <A extends { url: string }>(fronts: A[], url: string): A | undefined => fronts.find((f) => url.startsWith(f.url.replace(/\/$/, '')));

/** A front of the application: what a person uses, web or mobile, and the backs it calls. */
export interface Front { id: string; name: string; kind: 'web' | 'mobile'; platform?: string; stack?: string; repo?: string; dir?: string; backends: Array<{ id: string; name: string; endpoints: number }> }

/**
 * The fronts the map knows: services detected as web or mobile, and those of a project whose role is `frontend`. Each says which
 * backs it calls (the facts of its own endpoints and calls, folded per service). A native app has no address in an env: it is mapped, not opened.
 */
export function frontNodes(g: Indexed): Front[] {
  const home = (id: string) => { const n = g.nodes.get(id); return n?.type === 'endpoint' ? n.service : n?.type === 'service' ? n.id : undefined; };
  const isFront = (n: Indexed['nodes'] extends Map<string, infer N> ? N : never) => n.type === 'service' && (n.kind === 'web' || n.kind === 'mobile' || g.nodes.get(`repo:${n.repo}`)?.kind === 'frontend');
  return g.map.nodes.filter(isFront).map((n) => {
    const calls = new Map<string, Set<string>>();
    for (const f of g.map.facts) {
      if (f.p !== 'calls' || home(f.s) !== n.id) continue;
      const to = home(f.o);
      if (to && to !== n.id) (calls.get(to) ?? calls.set(to, new Set()).get(to)!).add(f.o);
    }
    const a = n.attrs ?? {};
    return {
      id: n.id, name: n.name, kind: n.kind === 'mobile' ? 'mobile' : 'web', platform: a.platform as string | undefined, stack: a.stack as string | undefined, repo: n.repo, dir: a.dir as string | undefined,
      backends: [...calls].map(([id, eps]) => ({ id, name: g.nodes.get(id)?.name ?? id, endpoints: eps.size })).sort((x, y) => y.endpoints - x.endpoints),
    };
  });
}

/** A front's name in a list: a mobile one says so. */
export const frontLabel = (name: string, kind?: string) => (kind === 'mobile' ? `${name} (móvil)` : name);
