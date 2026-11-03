/**
 * A service's, store's or external's sections, read from the map: its sheet shows them as tabs and the side menu as its
 * sections, from this one function, so the two always agree and the menu needs no sheet open to know them.
 */
import type { FlowInfo, Indexed, KnowledgeData, MapNode } from '../api.ts';
import { eventsOf } from './contracts.ts';

export type NodeTab = 'endpoints' | 'events' | 'contract' | 'content' | 'links' | 'data' | 'vars' | 'libs' | 'tests' | 'flows' | 'docs';

/** The flows whose last run touched this node. */
export const through = (flows: FlowInfo[], id: string) => flows.filter((f) => f.last?.nodes.includes(id));

export function nodeParts(g: Indexed, node: MapNode, k?: KnowledgeData, flows?: FlowInfo[]) {
  const svc = node.type === 'service';
  const out = g.out(node.id), inn = g.in(node.id);
  const endpoints = out.filter((f) => f.p === 'exposes').map((f) => ({ f, ep: g.nodes.get(f.o)! })).filter(({ ep }) => ep);
  const callersOf = (id: string) => g.in(id).filter((f) => f.p === 'calls' || f.p === 'forwards-to');
  const links = svc ? [
    ...inn.filter((f) => f.p === 'calls'),
    ...endpoints.flatMap(({ ep }) => callersOf(ep.id).filter((f) => f.p === 'calls')),
    ...out.filter((f) => f.p === 'calls' || f.p === 'uses'),
  ] : [...inn.filter((f) => f.p !== 'contains'), ...out.filter((f) => f.p !== 'contains')];
  const tables = new Set(out.filter((f) => ['maps-table', 'defines-table', 'reads', 'writes'].includes(f.p)).map((f) => f.o));
  const events = new Set([...out.filter((f) => f.p === 'publishes' || f.p === 'consumes').map((f) => `${f.p} ${f.o}`), ...(k ? eventsOf(k.pieces).filter((e) => e.service === node.id).map((e) => `${e.direction} topic:${e.topic}`) : [])]);
  const vars = out.filter((f) => f.p === 'reads-var' || f.p === 'declares-var');
  const libs = out.filter((f) => f.p === 'depends-on');
  const held = out.filter((f) => f.p === 'contains').map((f) => g.nodes.get(f.o)!).filter(Boolean);
  const tests = (node.attrs?.tests ?? {}) as Record<string, number>;
  const mine = flows ? through(flows, node.id) : [];
  const tabs: Array<{ key: NodeTab; label: string; n?: number }> = [
    ...(svc ? [{ key: 'endpoints' as const, label: 'Endpoints', n: endpoints.length }] : []),
    ...(svc && events.size ? [{ key: 'events' as const, label: 'Eventos', n: events.size }] : []),
    ...(node.type === 'external' ? [{ key: 'contract' as const, label: 'Contrato' }] : []),
    ...(node.type === 'datastore' ? [{ key: 'content' as const, label: 'Contenido', n: held.length }] : []),
    { key: 'links', label: 'Conexiones', n: links.length },
    ...(svc ? [{ key: 'data' as const, label: 'Datos', n: tables.size }, { key: 'vars' as const, label: 'Variables', n: vars.length }, { key: 'libs' as const, label: 'Librerías', n: libs.length }] : []),
    ...(svc ? [{ key: 'tests' as const, label: 'Pruebas', n: Object.values(tests).reduce((a, b) => a + b, 0) }] : []),
    { key: 'flows', label: 'Flujos', n: flows ? mine.length : undefined },
    { key: 'docs', label: 'Documentación' },
  ];
  // a service with no HTTP endpoints (a consumer) opens on its events
  const first: NodeTab = svc ? (out.some((f) => f.p === 'exposes') || !out.some((f) => f.p === 'publishes' || f.p === 'consumes') ? 'endpoints' : 'events') : node.type === 'datastore' ? 'content' : 'contract';
  return { svc, out, inn, endpoints, links, tables, events, vars, libs, held, tests, mine, tabs, first };
}

/** The tab an address asks for, or the node's first. */
export const nodeTab = (parts: ReturnType<typeof nodeParts>, asked?: string): NodeTab => (parts.tabs.some((t) => t.key === asked) ? asked as NodeTab : parts.first);
