/**
 * What sits under the system map: every component in one table, or one component's sheet. A sheet puts together what
 * the code says (extracted), what someone wrote (declared) and what the flows saw on their last run (observed).
 */
import { Braces, Database, GitBranch, Globe, Package, Pencil, Plug, Server, type LucideIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode, type RefObject } from 'react';
import { api, useApi, type EnvSummary, type Fact, type FlowInfo, type Indexed, type KnowledgeData, type MapNode, type MockContract, type Seen, type VarsData } from '../api.ts';
import { AllButton, DesignList, DIRECTION, Drift, EndpointBody, EntityRow, EventRow, Missing, Operation, slug, useOpen, type Loaded, type Shape } from '../components/Contract.tsx';
import { CopyButton, Dot, Origin, Skeleton, Status, Tabs } from '../components/ui.tsx';
import { contractsText, diffsOf, entitiesOf, errorsOf, eventsOf, groupApi, norm, noteParts, opOfEndpoint, opsOf, serviceApi, type ApiRow } from '../lib/contracts.ts';
import { KIND, lastText, MOCK_MODE, pieceLabel, plural, STATUS } from '../lib/es.ts';
import { Inline } from '../lib/md.tsx';
import { href } from '../lib/route.ts';
import { appsOf, groupsOf } from '../lib/sysmap.ts';
import { nodeParts, nodeTab, through } from '../lib/nodeTabs.ts';
import { AddMenu, Anchors, FacetList, facetsOf, PieceFields, Stale } from './Docs.tsx';
import { failedOn, flowDot, walkers } from './Flows.tsx';
import { LEVEL_WORD } from './Sheets.tsx';
import { tr } from '../lib/i18n.ts';
import { TechIcon } from '../components/TechIcon.tsx';
import { libInfo, managedName, registryOf } from '../lib/libs.ts';
import { TestLevels, type LiveTest } from '../components/TestList.tsx';
import { knownPurpose, readValue } from '../lib/vars.ts';

const ICON: Record<string, LucideIcon> = { service: Server, datastore: Database, external: Globe };
const where = (f: Fact) => (f.anchor ? `${f.anchor.path.split('/').pop()}${f.anchor.line ? `:${f.anchor.line}` : ''}` : '');
const full = (f: Fact) => (f.anchor ? `${f.anchor.repo}:${f.anchor.path}${f.anchor.line ? `:${f.anchor.line}` : ''}` : '');
const kindOf = (n: MapNode) => KIND[n.kind ?? ''] ?? n.kind ?? '';
type Hop = NonNullable<NonNullable<NonNullable<FlowInfo['last']>['failure']>['hop']>;
const failed = (f: FlowInfo) => f.last?.status === 'failed';

export { through };

/** Its tables and topics: mapped in the code, or held by a store. */
function dataOf(g: Indexed, n: MapNode) {
  const out = g.out(n.id);
  const ids = (ps: string[]) => new Set(out.filter((f) => ps.includes(f.p)).map((f) => f.o)).size;
  if (n.type === 'service') return { tables: ids(['maps-table']), topics: ids(['publishes', 'consumes']) };
  const held = out.filter((f) => f.p === 'contains').map((f) => g.nodes.get(f.o)?.type);
  return { tables: held.filter((t) => t === 'table').length, topics: held.filter((t) => t === 'topic').length };
}
const dataText = (d: { tables: number; topics: number }) => [d.tables && plural(d.tables, tr('tabla'), tr('tablas')), d.topics && plural(d.topics, tr('tema'), tr('temas'))].filter(Boolean).join(' · ');

/** «Componentes»: services, stores and externals, each with what it exposes and holds and how its flows did. */
export function Components({ g, flows, k, onOpen }: { g: Indexed; flows?: FlowInfo[]; k?: KnowledgeData; onOpen: () => void }) {
  const apps = appsOf(g);
  // with several applications, each one's pieces together, in the order laru.yaml lists them
  const order = apps ? groupsOf(g, []).order : [];
  const nodes = g.map.nodes.filter((n) => ICON[n.type]).sort((a, b) => (apps ? order.indexOf(apps.get(a.id)!) - order.indexOf(apps.get(b.id)!) : 0));
  const docs = k && new Set(k.pieces.map((p) => p.id));
  return (
    <section className="panel" aria-labelledby="components-h">
      <header><h2 id="components-h">{tr('Componentes')}</h2><div className="meta">{plural(nodes.length, tr('componente'), tr('componentes'))}</div></header>
      <div className="scroll-x"><table className="t components">
        <thead><tr><th>{tr('Nombre')}</th>{apps && <th>{tr('Aplicativo')}</th>}<th>{tr('Tipo')}</th><th>{tr('Dónde')}</th><th className="r">Endpoints</th><th>{tr('Datos')}</th><th>{tr('Flujos')}</th><th>{tr('Documentación')}</th></tr></thead>
        <tbody>{nodes.map((n) => {
          const Icon = ICON[n.type];
          const eps = n.type === 'service' ? g.out(n.id).filter((f) => f.p === 'exposes').length : undefined;
          const data = dataText(dataOf(g, n));
          const fl = flows && through(flows, n.id), bad = fl?.filter(failed).length ?? 0;
          const flowCell = fl?.length ? <>{fl.length}{bad > 0 && <span className="err-ink"> · {bad} {bad === 1 ? tr('falla') : tr('fallan')}</span>}</> : null;
          return (
            <tr key={n.id}>
              <td className="wrap">
                <a className="rowlink comp-name" href={href('map', n.id)} onClick={onOpen}><TechIcon g={g} node={n} fallback={Icon} />{n.name}</a><span className="only-sm faint"> {kindOf(n)}</span>
                <div className="only-sm faint sub">{[eps !== undefined && plural(eps, tr('endpoint'), tr('endpoints')), data, fl?.length && plural(fl.length, tr('flujo'), tr('flujos'))].filter(Boolean).join(' · ')}{bad > 0 && <span className="err-ink"> · {bad} {bad === 1 ? tr('falla') : tr('fallan')}</span>}</div>
              </td>
              {apps && <td>{apps.get(n.id)}</td>}
              <td>{kindOf(n)}</td>
              <td className="mono clip" title={n.type === 'service' ? `${n.repo}/${String(n.attrs?.dir)}` : undefined}>{n.type === 'service' ? <>{n.repo}<span className="faint">/{String(n.attrs?.dir)}</span></> : <span className="faint">—</span>}</td>
              <td className="r num">{eps ?? <span className="faint">—</span>}</td>
              <td>{data || <span className="faint">—</span>}</td>
              <td className="num">{flowCell ?? <span className="faint">—</span>}</td>
              <td>{!docs ? <span className="faint">—</span> : docs.has(n.id) ? tr('Documentado') : <span className="faint">{tr('Sin documentar')}</span>}</td>
            </tr>
          );
        })}</tbody>
      </table></div>
    </section>
  );
}

const OPEN_IN: Record<string, [string, string]> = { relational: ['data', tr('Abrir en Bases')], queue: ['queues', tr('Abrir en Colas')], file: ['storage', tr('Abrir en Almacenamiento')] };

/** One service, store or external: its header, how the flows that cross it did, and its tabs. */
export function NodeSheet({ g, node, flows, k, seen, reload, headRef, close, tabArg }: { g: Indexed; node: MapNode; flows?: FlowInfo[]; k?: KnowledgeData; seen: Loaded<Seen>; reload: () => void; headRef: RefObject<HTMLHeadingElement | null>; close: () => void; tabArg?: string }) {
  // the tab is the address's: the sheet keeps no copy of it, so a click moves the menu and the sheet in the same frame
  const parts = nodeParts(g, node, k, flows);
  const { svc, out, inn, endpoints, links, tables, events, vars, libs, held, tests, mine, tabs } = parts;
  const tab = nodeTab(parts, tabArg);
  const Icon = ICON[node.type] ?? Server;
  const piece = k?.pieces.find((p) => p.id === node.id);
  const app = k?.pieces.find((p) => p.type === 'application');
  // The failing hop of a flow, when it ended in this node.
  const here = (f: FlowInfo) => (f.last?.failure?.hop?.to === node.name ? f.last.failure.hop : undefined);

  const repo = g.nodes.get(`repo:${node.repo}`);
  const open = node.type === 'external' ? ['mocks', tr('Mocks y fallos')] : OPEN_IN[node.kind ?? ''];

  return (
    <div className="node-sheet" onKeyDown={(e) => { if (e.key === 'Escape') close(); }}>
      <div className="head">
        <div style={{ minWidth: 0 }}>
          <span className="type-badge"><TechIcon g={g} node={node} fallback={Icon} />{pieceLabel(node.type)}{kindOf(node) ? `, ${kindOf(node)}` : ''}</span>{' '}
          {piece && <Origin of="declared" />} <Origin of="extracted" />
          <h1 ref={headRef} tabIndex={-1} style={{ marginTop: 10 }}>{node.name}</h1>
          <p>{piece?.summary ?? (k && tr('Existe en el código —{plural}— pero nadie ha escrito lo que el código no dice: para qué está, qué no debe hacer, qué hacer cuando falla.', { plural: plural(out.length + inn.length, tr('hecho extraído'), tr('hechos extraídos')) }))}</p>
          <div className="idline">
            <code>{node.id}</code><CopyButton value={node.id} label={tr('Copiar el id')} />
            {node.repo && <a className="rowlink" href={href('repos', node.repo)} style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}><GitBranch size={13} />{node.repo}</a>}
            {node.attrs?.dir !== undefined && <span className="mono">{String(node.attrs.dir)}/</span>}
            {repo && <span className="mono">{String(repo.attrs?.ref)}@{String(repo.attrs?.commit).slice(0, 7)}</span>}
            {svc && <span title={Object.entries(tests).map(([t, n]) => `${t}: ${n}`).join(', ') || undefined}>{plural(Object.values(tests).reduce((a, b) => a + b, 0), tr('prueba'), tr('pruebas'))}</span>}
          </div>
        </div>
        <div className="actions" style={{ position: 'relative' }}>
          {open && <a className="btn" href={href(open[0])}>{node.type === 'external' ? <Plug /> : <Database />}{open[1]}</a>}
          {piece && k ? <><a className="btn" href={href('docs', node.id, 'edit')}><Pencil />{tr('Editar la documentación')}</a><AddMenu k={k} p={piece} /></>
            : k && <a className="btn primary" href={href('docs', 'new', node.type, app?.id ?? '-', node.id)}><Pencil />{tr('Documentar')}</a>}
        </div>
      </div>

      {piece && <Stale p={piece} reload={reload} />}
      {flows && <Verdict mine={mine} here={here} />}

      <Tabs id="node" label={tr('Secciones de {name}', { name: node.name })} value={tab} className="tabs piece-tabs" onChange={(t) => { location.hash = href('map', node.id, 't', t); }} tabs={tabs} />
      <div role="tabpanel" id="node-panel" aria-labelledby={`node-tab-${tab}`}>
        {tab === 'endpoints' && <ServiceApi g={g} node={node} k={k} seen={seen} flows={flows} />}
        {tab === 'events' && <ServiceEvents g={g} node={node} k={k} seen={seen.data} />}
        {tab === 'contract' && <MockedFrom g={g} node={node} k={k} seen={seen} />}
        {tab === 'content' && <Content g={g} held={held} />}
        {tab === 'links' && <Links g={g} node={node} links={links} k={k} />}
        {tab === 'data' && <ServiceData g={g} node={node} k={k} tables={[...tables]} />}
        {tab === 'vars' && <ServiceVars g={g} vars={vars} k={k} />}
        {tab === 'tests' && <ServiceTests g={g} node={node} flows={flows} mine={mine} />}
        {tab === 'libs' && <Libs g={g} libs={libs} k={k} />}
        {tab === 'flows' && <NodeFlows g={g} node={node} flows={flows} mine={mine} here={here} />}
        {tab === 'docs' && (!k ? <section className="panel"><div className="empty">—</div></section> : piece ? <><DesignList k={k} g={g} p={piece} seen={seen.data} /><PieceFields k={k} p={piece} /><div style={{ height: 16 }} />{piece.anchors?.length ? <><Anchors p={piece} /><div style={{ height: 16 }} /></> : null}<FacetList k={k} {...facetsOf(k, piece)} /></> : (
          <section className="panel"><div className="empty">{tr('Nadie ha escrito para qué está, qué no debe hacer ni qué hacer cuando falla.')}{' '}<a className="rowlink" href={href('docs', 'new', node.type, app?.id ?? '-', node.id)}>{tr('Documentar')}</a></div></section>
        ))}
      </div>
    </div>
  );
}

/** How the flows through it did on their last run, and whether one failed on a hop into it. */
function Verdict({ mine, here }: { mine: FlowInfo[]; here: (f: FlowInfo) => Hop | undefined }) {
  const bad = mine.filter(failed), at = mine.filter((f) => here(f));
  if (!mine.length) return <p className="verdict"><Status state="idle">{tr('Ningún flujo lo recorre en su último run.')}</Status></p>;
  if (!bad.length) return <p className="verdict"><Status state="ok">{mine.length === 1 ? tr('Lo recorre 1 flujo, y pasó en su último run.') : tr('Lo recorren {length} flujos, y todos pasaron en su último run.', { length: mine.length })}</Status></p>;
  return (
    <p className="verdict"><Status state="err"><span>
      {mine.length === 1 ? tr('Lo recorre 1 flujo, y falló en su último run.') : tr('Lo recorren {length} flujos; {p1} en su último run.', { length: mine.length, p1: bad.length === 1 ? tr('1 falló') : tr('{n} fallaron', { n: bad.length }) })}{' '}
      {at.length ? <>{tr('Falló aquí:')}{' '}{at.map((f, i) => { const hop = here(f)!; return <span key={f.id}>{i ? '; ' : ''}<a className="rowlink" href={href('docs', f.id, 'map')}>{f.title}</a>, {hop.status ?? hop.error ?? tr('sin respuesta')}{' '}{tr('en')}{' '}{hop.what}</span>; })}.</> : tr('Ninguno falló en un salto suyo.')}
    </span></Status></p>
  );
}

const nameOf = (g: Indexed, id: string) => { const n = g.nodes.get(id); return n?.type === 'endpoint' ? `${g.nodes.get(n.service ?? '')?.name} ${n.name}` : n?.name ?? id; };

/** A store's tables or topics: who maps them in the code, and who was seen reading or writing them. */
function Content({ g, held }: { g: Indexed; held: MapNode[] }) {
  if (!held.length) return <section className="panel"><div className="empty"><Missing how={tr('Aparece en cuanto el código mapee o cree sus tablas o temas, o un run los toque.')}>{tr('No se conoce nada dentro de este almacén.')}</Missing></div></section>;
  const VERB: Record<string, string> = { 'maps-table': tr('mapea'), 'defines-table': tr('la define'), publishes: tr('publica'), consumes: tr('consume'), reads: tr('lee'), writes: tr('escribe') };
  const said = (fs: Fact[]) => [...Map.groupBy(fs, (f) => f.s)].map(([s, x]) => `${nameOf(g, s)} ${[...new Set(x.map((f) => VERB[f.p]))].join(' y ')}`).join(' · ');
  return (
    <section className="panel"><Lead>{tr('Lo que guarda: quién lo mapea o lo crea en el código y, aparte, quién lo leyó o escribió en los runs.')}</Lead><div className="scroll-x"><table className="t">
      <thead><tr><th>{held.every((n) => n.type === 'topic') ? tr('Tema@@Kafka') : tr('Tabla')}</th><th>{tr('En el código')}</th><th><Origin of="observed" label={false} />{' '}{tr('Datos reales')}</th></tr></thead>
      <tbody>{held.map((n) => {
        const inn = g.in(n.id);
        const code = inn.filter((f) => f.origin !== 'observed' && f.p in VERB && f.p !== 'reads' && f.p !== 'writes');
        const seen = inn.filter((f) => f.seen && (f.p === 'reads' || f.p === 'writes'));
        const last = seen.reduce<Fact['seen']>((a, f) => (!a || Number(f.seen!.run) > Number(a.run) ? f.seen : a), undefined);
        return (
          <tr key={n.id}>
            <td className="mono">{n.name}</td>
            <td className="wrap">{code.length ? <><Origin of="extracted" label={false} /> {said(code)}</> : <span className="faint">{tr('nadie lo mapea ni lo crea en el código')}</span>}</td>
            <td className="wrap">{seen.length ? <><Origin of="observed" label={false} /> {said(seen)} <span className="faint">{tr('(run')}{' '}{last?.run}, {last?.count}×)</span></> : <span className="faint">{tr('ningún run lo ha tocado todavía')}</span>}</td>
          </tr>
        );
      })}</tbody>
    </table></div></section>
  );
}

const VERB: Record<string, [string, string]> = {
  calls: [tr('Llama a'), tr('Lo llama')], uses: [tr('Usa'), tr('Lo usa')], 'maps-table': [tr('Mapea la tabla'), ''], 'defines-table': [tr('Crea la tabla'), ''], publishes: [tr('Publica en'), ''], consumes: [tr('Consume'), ''], 'reads-var': [tr('Lee'), ''], 'declares-var': [tr('Recibe'), ''],
  reads: [tr('Lee'), tr('Lo lee')], writes: [tr('Escribe en'), tr('Lo escribe')],
};

/** What a tab is for, said once at its top. */
const Lead = ({ children }: { children: ReactNode }) => <p className="api-note">{children}</p>;
const real = (f: Fact) => f.origin === 'observed' || Boolean(f.seen);

/**
 * A fact's note in the interface's language: how the code reaches the other end (its configuration, a REST client, a
 * proxy, the gateway in between). The map writes it in English, for the agent and the vault.
 */
export function noteText(note: string): string {
  return noteParts(note).map((part) => {
    let m: RegExpMatchArray | null;
    if ((m = part.match(/^config (\S+?)(?: \((\w+)\))?$/))) return m[2] ? tr('su configuración {key}, perfil {profile}', { key: m[1], profile: m[2] }) : tr('su configuración {key}', { key: m[1] });
    if ((m = part.match(/^rest client (.+)$/))) return tr('el cliente REST {name}', { name: m[1] });
    if ((m = part.match(/^base URL from (\S+)$/))) return tr('la dirección que le da {v}', { v: m[1] });
    if ((m = part.match(/^via proxy (\S+)$/))) return tr('por su proxy {prefix}', { prefix: m[1] });
    if ((m = part.match(/^through (\S+)(?: (.+))?$/))) return m[2] ? tr('a través de {via} ({route})', { via: m[1], route: m[2] }) : tr('a través de {via}', { via: m[1] });
    if ((m = part.match(/^sends (mail|text messages) \((.+)\)$/))) return m[1] === 'mail' ? tr('envía correo ({p})', { p: m[2] }) : tr('envía SMS ({p})', { p: m[2] });
    if ((m = part.match(/^payload (.+)$/))) return tr('lleva {type}', { type: m[1] });
    if ((m = part.match(/^key (.+)$/))) return tr('con clave {type}', { type: m[1] });
    if ((m = part.match(/^group (.+)$/))) return tr('en el grupo {group}', { group: m[1] });
    if (part === 'compose depends_on') return tr('su compose lo arranca antes (depends_on)');
    if (part === 'listed in an example env file') return tr('aparece en un fichero de ejemplo de variables');
    if (part === 'declared in laru.yaml') return tr('declarado en laru.yaml');
    if (part === 'across projects') return tr('entre proyectos');
    return part;
  }).join(', ');
}
/** Calls shown at once in a card; the rest open with a click. */
const CALLS = 8;

/**
 * Who it talks to, grouped by the relation and by who is at the other end. Each one in a sentence (how many of whose
 * endpoints, through what, whether the runs saw it), then each call: the endpoint, what it is for when a contract says,
 * and where in the code it is made.
 */
function Links({ g, node, links, k }: { g: Indexed; node: MapNode; links: Fact[]; k?: KnowledgeData }) {
  const self = (id: string) => id === node.id || g.nodes.get(id)?.service === node.id;
  const into = (f: Fact) => !self(f.s);
  const other = (f: Fact) => { const id = into(f) ? f.s : f.o; const n = g.nodes.get(id); return n?.type === 'endpoint' && n.service ? n.service : id; };
  const groups = [...Map.groupBy(links, (f) => VERB[f.p]?.[into(f) ? 1 : 0] || f.p)];
  const ops = k ? opsOf(k.pieces) : [];
  return (
    <section className="panel" aria-labelledby="links-h">
      <header><h3 id="links-h">{tr('Conexiones')}</h3><div className="meta">{plural(new Set(links.map(other)).size, tr('pieza'), tr('piezas'))}</div></header>
      <Lead>{tr('Con quién habla, en los dos sentidos: quién lo llama y a quién llama él. Cada llamada sale de su código; los runs dicen si la han visto pasar.')}</Lead>
      {!links.length ? <div className="empty"><Missing how={tr('El mapa sale del código: si llama a algo por una URL que Laru no ve (un .env, una variable sin valor de ejemplo), decláralo en laru.yaml bajo services.<nombre>.calls y relee el mapa.')}>{tr('Ni el código ni los runs muestran con quién habla.')}</Missing></div> : groups.map(([label, fs]) => (
        <section key={label} className="link-group" aria-label={label}>
          <h4>{label} <span className="faint">{plural(new Set(fs.map(other)).size, tr('pieza'), tr('piezas'))}</span></h4>
          {[...Map.groupBy(fs, other)].map(([id, xs]) => <LinkCard key={id} g={g} id={id} xs={xs} incoming={into(xs[0])} ops={ops} />)}
        </section>
      ))}
    </section>
  );
}

function LinkCard({ g, id, xs, incoming, ops }: { g: Indexed; id: string; xs: Fact[]; incoming: boolean; ops: ReturnType<typeof opsOf> }) {
  const [all, setAll] = useState(false);
  const n = g.nodes.get(id), name = n?.name ?? nameOf(g, id);
  const code = xs.filter((f) => !real(f)), ran = xs.filter(real);
  const last = ran.reduce<Fact['seen']>((a, f) => (f.seen && (!a || Number(f.seen.run) > Number(a.run)) ? f.seen : a), undefined);
  const epOf = (f: Fact) => [f.s, f.o].map((x) => g.nodes.get(x)).find((x) => x?.type === 'endpoint');
  const calls = code.filter((f) => epOf(f)).sort((a, b) => String(epOf(a)!.attrs?.path).localeCompare(String(epOf(b)!.attrs?.path)));
  const rest = code.filter((f) => !epOf(f));
  const seenEp = new Set(ran.map((f) => epOf(f)?.id).filter(Boolean));
  const eps = new Set(calls.map((f) => epOf(f)!.id)).size;
  // a gateway in between, which the map deduced: the caller reaches it, and it forwards those routes here
  const via = [...new Set(calls.map((f) => f.note?.match(/^through (\S+)/)?.[1]).filter((x): x is string => Boolean(x)))];
  const shown = all ? calls : calls.slice(0, CALLS);
  return (
    <div className="link-card">
      <div className="link-h">{ICON[n?.type ?? ''] ? <a className="rowlink" href={href('map', id)}>{name}</a> : <span className="mono">{name}</span>}{n?.kind && <span className="faint">{KIND[n.kind] ?? n.kind}</span>}</div>
      <p className="link-sum">
        {eps > 0 && <>{calls.length > eps ? (incoming ? tr('Hace {calls} llamadas distintas a {n} de sus endpoints', { calls: calls.length, n: eps }) : tr('Hace {calls} llamadas distintas a {n} de los endpoints de {name}', { calls: calls.length, n: eps, name })) : incoming ? tr('Llama a {n} de sus endpoints', { n: eps }) : tr('Llama a {n} de los endpoints de {name}', { n: eps, name })}{via.length ? tr(', a través de {via}', { via: via.join(tr(' y ')) }) : ''}. </>}
        <span className={last ? undefined : 'faint'}><Origin of="observed" label={false} />{' '}{last ? tr('Los runs lo han visto: el último, el {run}; en {n} runs en total.', { run: last.run, n: last.count }) : ran.length ? tr('Los runs lo han visto.') : tr('Ningún run lo ha visto todavía.')}</span>
      </p>
      {via.length > 0 && <p className="link-why"><Origin of="derived" label={false} />{' '}{tr('Deducido del código: {name} llama a {via}, que reenvía esas rutas aquí.', { name: incoming ? name : node(g, calls[0]), via: via.join(tr(' y ')) })}</p>}
      {calls.length > 0 && (
        <div className="scroll-x"><table className="t link-t">
          <thead><tr><th>{tr('Endpoint')}</th><th>{tr('Para qué')}</th><th>{tr('En su código')}</th></tr></thead>
          <tbody>{shown.map((f, i) => {
            const ep = epOf(f)!, op = opOfEndpoint(ep, ops), method = String(ep.attrs?.method ?? ''), path = String(ep.attrs?.path ?? ep.name);
            // what the caller's code calls (`GET /api/files/${id}`), when it is not the endpoint as written (`GET /api/files/**`)
            const parts = noteParts(f.note ?? '').filter((x) => x && !/^through /.test(x));
            const call = parts.find((x) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \//.test(x)), extra = parts.filter((x) => x !== call).map(noteText);
            const [cm, ...cp] = (call ?? `${method} ${path}`).split(' ');
            // a route that only forwards has no contract of its own: the call's own path finds the one of the service it reaches
            const doc = op ?? (call ? ops.find((o) => o.method === cm && norm(o.path) === norm(cp.join(' '))) : undefined);
            return (
              <tr key={i}>
                <td className="two">
                  <span className="mono">{seenEp.has(ep.id) && <Dot state="ok" />}<span className={`m m-${cm.toLowerCase()}`}>{cm}</span> {cp.join(' ')}</span>
                  {(call || extra.length > 0) && <span className="sub">{[call ? tr('llega a {ep}', { ep: `${method} ${path}` }) : '', ...extra].filter(Boolean).join(' · ')}</span>}
                </td>
                <td className="wrap">{doc?.summary ? <Inline text={doc.summary} /> : <span className="faint">{tr('ningún contrato lo dice')}</span>}</td>
                <td className="mono faint" title={full(f)}>{where(f) || '—'}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}
      {calls.length > CALLS && <button className="linkish" onClick={() => setAll(!all)} aria-expanded={all}>{all ? tr('Ver menos') : tr('Ver las {n} llamadas', { n: calls.length })}</button>}
      {rest.length > 0 && <ul className="plain link-how">{rest.map((f, i) => <li key={i}><span>{f.note ? noteText(f.note) : VERB[f.p]?.[incoming ? 1 : 0] || f.p}</span>{f.anchor && <span className="mono faint" title={full(f)}>{where(f)}</span>}</li>)}</ul>}
      {!code.length && <p className="faint ep-p">{tr('El código no lo dice: solo lo vieron los runs.')}</p>}
    </div>
  );
}
/** The piece a call comes from, by name. */
const node = (g: Indexed, f: Fact | undefined) => (f ? g.nodes.get(f.s)?.name ?? f.s : '');

/** A secret's documented purpose: the row of a «Secretos» piece that names it, by its name or by the property it fills (`jwt.secret`). */
function secretPurpose(k: KnowledgeData | undefined, name: string, keys: string[]): string | undefined {
  const flat = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const want = [name, ...keys].map(flat).filter(Boolean);
  for (const p of k?.pieces ?? []) {
    if (p.type !== 'secrets') continue;
    for (const r of (p.fields.needs ?? []) as Array<Record<string, unknown>>) {
      const names = String(r.secret ?? '').split(/[\s,/]+/).map(flat).filter(Boolean);
      if (r.purpose && want.some((w) => names.includes(w))) return String(r.purpose);
    }
  }
  return undefined;
}
const SECRET = /(SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|PRIVATE|CREDENTIAL)/i;

/**
 * The configuration it receives as it starts, one row per variable said for a person: what it is for (a secret's
 * documented purpose, what a common one means, what its name says), where its code reads it and who passes it, and its
 * value in an env as a person reads it (86400000 ms is a day). A secret's value shows only when asked.
 */
function ServiceVars({ g, vars, k }: { g: Indexed; vars: Fact[]; k?: KnowledgeData }) {
  const envs = useApi<EnvSummary[]>('/api/envs');
  const [pick, setPick] = useState<string>();
  // an app by URL has no vault of Laru's: its configuration is where it runs
  const own = (envs.data ?? []).filter((e) => !e.url);
  const env = pick ?? own.find((e) => e.state === 'ready')?.env ?? own[0]?.env;
  const data = useApi<VarsData>(env ? `/api/vars?env=${encodeURIComponent(env)}` : null);
  const [vals, setVals] = useState<Array<{ section: string; key: string; value: string }>>([]);
  useEffect(() => { if (env) api<{ entries: typeof vals }>('/api/vars/values', { method: 'POST', body: { env } }).then((r) => setVals(r.entries), () => setVals([])); }, [env]);
  const [shown, setShown] = useState<Set<string>>(new Set());
  const rows = new Map((data.data?.rows ?? []).map((r) => [r.key, r]));
  const byVar = [...Map.groupBy(vars, (f) => f.o)];
  const readAt = (f: Fact) => `${where(f)}${f.note?.match(/overrides (\S+)/) ? tr(' como {key}', { key: f.note.match(/overrides (\S+)/)![1] }) : ''}${/has a default/.test(f.note ?? '') ? tr(', con valor por defecto') : ''}`;
  return (
    <section className="panel" aria-labelledby="vars-h">
      <header><h3 id="vars-h">{tr('Variables y secretos')}</h3>
        <div className="meta"><Origin of="extracted" />{' '}{tr('+ vault')}{env && <> · <a className="rowlink" href={href('vars', env)}>{tr('Editar ›')}</a></>}{own.length > 1 && <select aria-label={tr('Entorno')} value={env} onChange={(e) => setPick(e.target.value)} style={{ marginLeft: 8 }}>{own.map((e) => <option key={e.env}>{e.env}</option>)}</select>}</div></header>
      <Lead>{tr('La configuración que recibe al arrancar: para qué es cada variable, dónde la lee su código y qué valor tiene. Un secreto se muestra solo si lo pides.')}</Lead>
      {!byVar.length ? <div className="empty">{tr('Su código no lee variables de entorno.')}</div> : (
        <div className="scroll-x"><table className="t var-t">
          <thead><tr><th>{tr('Variable')}</th><th>{tr('Para qué es')}</th><th>{env ? tr('Valor en {env}', { env }) : tr('Valor')}</th></tr></thead>
          <tbody>{byVar.map(([id, fs]) => {
            const name = g.nodes.get(id)?.name ?? id.replace(/^var:/, '');
            const reads = fs.filter((f) => f.p === 'reads-var'), gives = fs.filter((f) => f.p === 'declares-var');
            const keys = reads.flatMap((f) => f.note?.match(/overrides (\S+)/)?.[1] ?? []);
            const r = rows.get(name), secret = Boolean(r?.secret) || SECRET.test(name);
            const documented = secretPurpose(k, name, keys), known = knownPurpose(name);
            const raw = r?.effective ? vals.find((v) => v.section === r.effective && v.key === name)?.value : undefined;
            const read = raw !== undefined ? readValue(name, raw) : undefined;
            const level = r?.effective ? LEVEL_WORD[r.effective] ?? r.effective : '';
            return (
              <tr key={id}>
                <td className="two"><span className="mono var-name">{name}</span><span className="sub">{secret ? tr('secreto') : tr('variable')}</span></td>
                <td className="two wrap">
                  {documented ? <span><Origin of="declared" label={false} /> <Inline text={documented} /></span> : known ? <span>{known}</span> : keys.length ? <span>{tr('Da valor a {keys} en su configuración.', { keys: keys.join(', ') })}</span> : <span className="faint">{tr('Nadie ha escrito para qué es: dilo en la pieza «Secretos» si es un secreto, o en la documentación del servicio.')}</span>}
                  <span className="sub">{reads.length ? <>{tr('La lee')}{' '}<span className="mono" title={reads.map(full).join('\n')}>{reads.map(readAt).join(' · ')}</span></> : known ? tr('No la lee su código sino el framework o la plataforma, al arrancar.') : tr('Ningún código la lee: la recibe y no la usa.')}
                    {gives.map((f, i) => <span key={i}>{' · '}{f.note === 'set by compose' ? <>{tr('se la pasa el compose')}{' '}<span className="mono" title={full(f)}>{where(f)}</span></> : <>{f.note} <span className="mono">{where(f)}</span></>}</span>)}</span>
                </td>
                <td className="two">{!env ? <span className="faint">—</span> : !data.data ? <span className="faint">…</span> : !r ? <span className="faint">{tr('el vault no la conoce')}</span> : !r.effective ? <span className="pending">{tr('sin valor')}</span>
                  : raw === undefined ? <><span className="faint">{r.effective === 'compose' ? tr('la del compose') : '—'}</span>{r.effective !== 'compose' && <span className="sub">{tr('nivel {level}', { level })}</span>}</>
                  : secret && !shown.has(name) ? <><span><span className="mono">••••••••</span>{' '}<button className="linkish inline" onClick={() => setShown(new Set([...shown, name]))}>{tr('Mostrar')}</button></span><span className="sub">{tr('nivel {level}', { level })}</span></>
                  : <><span><span className="mono var-value">{read!.value}</span>{read!.note && <span className="faint">{' · '}{read!.note}</span>}</span><span className="sub" title={r.levels.map((l) => LEVEL_WORD[l] ?? l).join(' › ')}>{tr('nivel {level}', { level })}</span></>}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}
    </section>
  );
}

/** Words of a library that say nothing of which one it is: a stack's row naming «Spring Boot» is not about each starter. */
const GENERIC = new Set(['spring', 'boot', 'starter', 'core', 'common', 'commons', 'api', 'impl', 'quarkus', 'jakarta', 'javax', 'apache', 'client', 'server', 'test', 'tests', 'angular', 'react', 'types']);
/** Why this application needs a library, when someone wrote it: the row of the stack's «Dependencias críticas» that names it (`jjwt 0.12.6`, `spring-kafka`). */
function whyOf(k: KnowledgeData | undefined, coords: string): string | undefined {
  const flat = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const artifact = coords.split(':').pop()!.replace(/^@[^/]+\//, ''), head = artifact.split(/[-.]/)[0];
  for (const p of k?.pieces ?? []) {
    if (p.type !== 'stack') continue;
    for (const r of (p.fields.critical ?? []) as Array<Record<string, unknown>>) {
      const d = String(r.dependency ?? '');
      if (r.why && (flat(d).includes(flat(artifact)) || (head.length >= 4 && !GENERIC.has(head) && d.toLowerCase().split(/[^a-z0-9]+/).includes(head)))) return String(r.why);
    }
  }
  return undefined;
}

/**
 * Its libraries as its build declares them, each said for a person: what it is (Laru knows the common ones, and links
 * the registry of any other), why this application needs it when the stack says so, and its version as resolved (a
 * property's value, the parent or BOM that fixes it). What it runs with first, then what only its tests and build use.
 */
function Libs({ g, libs, k }: { g: Indexed; libs: Fact[]; k?: KnowledgeData }) {
  const dev = (f: Fact) => /^(test|dev|provided)$/i.test(String(g.nodes.get(f.o)?.attrs?.scope ?? ''));
  const parts: Array<[string, string, Fact[]]> = [
    [tr('Con las que corre'), tr('Van dentro de la aplicación: sin ellas no arranca o no hace su trabajo.'), libs.filter((f) => !dev(f))],
    [tr('Solo para pruebas y build'), tr('Las usan sus pruebas o su compilación; no viajan con la aplicación.'), libs.filter(dev)],
  ];
  return (
    <section className="panel" aria-labelledby="libs-h">
      <header><h3 id="libs-h">{tr('Librerías')}</h3><div className="meta"><Origin of="extracted" /> · {plural(libs.length, tr('librería'), tr('librerías'))}</div></header>
      <Lead>{tr('Las librerías que declara su build (pom.xml, package.json), qué es cada una y, cuando la documentación lo dice, por qué la necesita esta aplicación.')}</Lead>
      {!libs.length ? <div className="empty"><Missing how={tr('Laru las lee de pom.xml y package.json; un build de otro tipo no las muestra aquí.')}>{tr('Su build no declara dependencias que Laru lea.')}</Missing></div> : parts.filter(([, , fs]) => fs.length).map(([label, why, fs]) => (
        <section key={label} className="link-group" aria-label={label}>
          <h4>{label} <span className="faint">{fs.length}</span></h4>
          <p className="group-why">{why}</p>
          <div className="scroll-x"><table className="t lib-t">
            <thead><tr><th>{tr('Librería')}</th><th>{tr('Para qué sirve')}</th><th>{tr('Versión')}</th></tr></thead>
            <tbody>{fs.map((f) => {
              const n = g.nodes.get(f.o), coords = n?.name ?? f.o.replace(/^dep:[^:]+:/, ''), info = libInfo(coords), reason = whyOf(k, coords), reg = registryOf(coords, n?.kind);
              const v = String(n?.attrs?.version ?? ''), managed = n?.attrs?.managedBy ? managedName(String(n.attrs.managedBy)) : '', prop = n?.attrs?.property ? String(n.attrs.property) : '';
              return (
                <tr key={f.o + full(f)}>
                  <td className="two"><span className="lib-name">{n && <TechIcon g={g} node={n} size={14} fallback={Package} />}{f.o.startsWith('repo:') ? <a className="rowlink" href={href('repos', f.o.slice(5))}>{f.o}</a> : info?.name ?? coords.split(':').pop()}</span><span className="sub mono" title={full(f)}>{coords} · {where(f)}</span></td>
                  <td className="two wrap">{info ? <span>{info.what}</span> : <span className="faint">{tr('Laru no la conoce.')}{' '}<a className="rowlink" href={reg.url} target="_blank" rel="noreferrer">{tr('Qué es, en {label} ›', { label: reg.label })}</a></span>}
                    {reason && <span className="sub why"><Origin of="declared" label={false} /><span><Inline text={reason} /></span></span>}</td>
                  <td className="two">{!v ? <><span>{managed ? managed.replace(/^.* /, '') : '—'}</span><span className="sub">{managed ? tr('la que fija {by}', { by: managed }) : tr('la que fije su build')}</span></>
                    : /^\$\{/.test(v) ? <><span className="mono">{v}</span><span className="sub">{tr('una propiedad que su build no define')}</span></>
                    : <><span className="mono">{v}</span>{prop && <span className="sub">{tr('de la propiedad {p}', { p: prop })}</span>}</>}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        </section>
      ))}
    </section>
  );
}

/**
 * Its tests by level, each said in its own words: the file by what it tests (its class's @DisplayName or Javadoc, else
 * the class its name names) and each case by its title (its @DisplayName, an `it`'s text), its method small beside it;
 * apart, what the runs say: the flows whose last run went through it and the endpoints none walked.
 */
function ServiceTests({ g, node, flows, mine }: { g: Indexed; node: MapNode; flows?: FlowInfo[]; mine: FlowInfo[] }) {
  const t = useApi<LiveTest[]>(`/api/service-tests?id=${encodeURIComponent(node.id)}`);
  const eps = g.out(node.id).filter((f) => f.p === 'exposes').map((f) => g.nodes.get(f.o)).filter((x): x is MapNode => Boolean(x));
  const walked = flows ? eps.filter((ep) => walkers(flows, ep.id).length) : [];
  const files = t.data ?? [];
  const titled = files.reduce((n, x) => n + x.cases.filter((c) => c.title).length, 0), cases = files.reduce((n, x) => n + x.cases.length, 0);
  return (
    <section className="panel" aria-labelledby="tests-h">
      <header><h3 id="tests-h">{tr('Pruebas')}</h3><div className="meta"><Origin of="extracted" /> · {plural(files.reduce((n, x) => n + x.count, 0), tr('prueba'), tr('pruebas'))}{' '}{tr('en')}{' '}{plural(files.length, tr('fichero'), tr('ficheros'))}</div></header>
      <Lead>{titled ? tr('Lo que comprueban sus pruebas automáticas, dicho por ellas mismas: el título de cada caso, y su método al lado.') : tr('Lo que comprueban sus pruebas automáticas. Sus casos no tienen título (@DisplayName, el texto de un it), así que se leen del nombre de su método.')}{titled > 0 && titled < cases ? ' ' + tr('Los que no tienen título se leen del nombre de su método.') : ''}</Lead>
      {t.loading && !t.data ? <div className="body"><Skeleton lines={4} /></div> : !files.length ? (
        <div className="empty"><Missing how={tr('Laru las lee de src/test (Java) y de los ficheros .test y .spec (JavaScript) bajo la carpeta del servicio; las de otro repositorio no cuentan aquí.')}>{tr('No hay pruebas bajo su carpeta.')}</Missing></div>
      ) : <TestLevels files={files} eps={eps} />}
      <section className="link-group real-box" aria-label={tr('Flujos que pasan por aquí')}>
        <h4><Origin of="observed" label={false} />{tr('Flujos que pasan por aquí')} <span className="faint">{tr('lo que vieron los runs')}</span></h4>
        <p className="group-why">{tr('Además de sus pruebas, los flujos de Laru lo recorren de punta a punta con la aplicación entera.')}</p>
        {!flows ? <p className="faint ep-p">{tr('No se pudo leer el historial de runs.')}</p> : !mine.length ? (
          <Missing how={tr('Lo trae el primer run de un flujo que pase por aquí: escribe uno en Documentación, o graba una sesión de «Probar en vivo» y conviértela en flujo.')}>{tr('Ningún flujo ha pasado por aquí en su último run.')}</Missing>
        ) : (
          <>
            <ul className="plain link-how">{mine.map((f) => <li key={f.id}><Dot state={flowDot(f)} /><a className="rowlink" href={href('docs', f.id, 'map')}>{f.title}</a><span className="faint">{lastText(f.last)}</span></li>)}</ul>
            {eps.length > 0 && <p className="ep-p">{tr('{walked} de sus {n} endpoints, recorridos por algún flujo en su último run.', { walked: walked.length, n: eps.length })}</p>}
          </>
        )}
      </section>
    </section>
  );
}

/** The flows whose last run went through it, failing first: the endpoints of it each walked and, when one failed here, the hop. */
function NodeFlows({ g, node, flows, mine, here }: { g: Indexed; node: MapNode; flows?: FlowInfo[]; mine: FlowInfo[]; here: (f: FlowInfo) => Hop | undefined }) {
  const own = new Set(g.out(node.id).filter((f) => f.p === 'exposes').map((f) => f.o));
  const list = [...mine].sort((a, b) => Number(failed(b)) - Number(failed(a)));
  return (
    <section className="panel" aria-labelledby="flows-h">
      <header><h3 id="flows-h">{tr('Flujos')}</h3><div className="meta"><Origin of="observed" /> · {plural(mine.length, tr('flujo'), tr('flujos'))}</div></header>
      <Lead>{tr('Los flujos cuyo último run pasó por aquí: cómo les fue, qué endpoints suyos recorrieron y, si fallaron aquí, en qué salto.')}</Lead>
      {!flows ? <div className="empty">{tr('No se pudo leer el historial de runs.')}</div> : !mine.length ? (
        <div className="empty"><Missing how={tr('Escribe un flujo que lo use (Documentación › Crear un flujo), o graba una sesión de «Probar en vivo» y conviértela en flujo; su primer run lo trae aquí.')}>{tr('Ningún flujo lo ha recorrido en su último run.')}</Missing></div>
      ) : (
        <div className="scroll-x"><table className="t">
          <thead><tr><th>{tr('Flujo')}</th><th>{tr('Último')}</th><th>{tr('Recorrió')}</th><th>{tr('Falló aquí')}</th></tr></thead>
          <tbody>{list.map((f) => {
            const hop = here(f), walked = (f.last?.endpoints ?? []).filter((e) => own.has(e.id));
            return (
              <tr key={f.id}>
                <td><a className="rowlink" href={href('docs', f.id, 'map')} style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}><Dot state={flowDot(f)} />{f.title}</a></td>
                <td>{lastText(f.last)}</td>
                <td className="wrap">{walked.length ? walked.map((e, i) => <span key={e.id} className={`mono${e.ok ? '' : ' err-ink'}`}>{i ? ', ' : ''}{g.nodes.get(e.id)?.name ?? e.id}</span>) : <span className="faint">{own.size ? tr('ningún endpoint suyo: pasó por sus datos o sus mensajes') : tr('no expone endpoints')}</span>}</td>
                <td className="wrap">{hop ? <span className="err-ink">{hop.status ?? hop.error ?? tr('sin respuesta')}{' '}{tr('en')}{' '}{hop.what}</span> : <span className="faint">{failed(f) ? tr('falló en otro sitio') : tr('no')}</span>}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}
    </section>
  );
}

/* ------------------------------ contracts on a sheet ------------------------------ */

const at = (n: MapNode) => (n.anchor ? `${n.anchor.path.split('/').pop()}${n.anchor.line ? `:${n.anchor.line}` : ''}` : '');

/**
 * A service's endpoints, grouped as a reader looks for them: by the contract that documents them (what the contract is
 * for names the group), the rest by the resource of their path, and those that only forward to other services last.
 * Each opens into its contract (what it is for, takes and answers, with what its code says under each part) and, apart,
 * what the runs saw of it and where that strays from the contract. Nothing is left blank: what is not known says what
 * brings it.
 */
function ServiceApi({ g, node, k, seen, flows }: { g: Indexed; node: MapNode; k?: KnowledgeData; seen: Loaded<Seen>; flows?: FlowInfo[] }) {
  const shapes = useApi<Record<string, Shape>>(`/api/service-shapes?id=${encodeURIComponent(node.id)}`);
  const eps = g.out(node.id).filter((f) => f.p === 'exposes').map((f) => g.nodes.get(f.o)).filter((x): x is MapNode => Boolean(x));
  const ops = k ? opsOf(k.pieces) : [];
  const reach = (ep: MapNode) => g.out(ep.id).filter((f) => f.p === 'forwards-to').map((f) => g.nodes.get(f.o)).filter((x): x is MapNode => Boolean(x));
  // a wildcard route passes calls on even where no route below takes its method: to the services it calls under that prefix
  const called = [...new Set(g.out(node.id).filter((f) => f.p === 'calls').map((f) => g.nodes.get(f.o)).flatMap((n) => (n?.type === 'service' ? [n.id] : n?.service ? [n.service] : [])))];
  const under = (path: string) => called.filter((d) => g.out(d).some((f) => f.p === 'exposes' && String(g.nodes.get(f.o)?.attrs?.path).startsWith(path.slice(0, -3))));
  const rows = serviceApi(node.id, eps, ops, (ep) => { const to = [...new Set(reach(ep).map((x) => x.service ?? ''))].filter(Boolean); return to.length || !String(ep.attrs?.path).endsWith('/**') ? to : under(String(ep.attrs?.path)); });
  // What a route that only forwards reaches, each with its own contract: the endpoints its forwards name, else those of
  // the services under its prefix with its method (`GET /api/files/**` reaches every GET of file-service under /api/files).
  const reached = (r: ApiRow) => {
    if (!r.ep || !r.forward) return [];
    const direct = reach(r.ep), path = String(r.ep.attrs?.path ?? ''), method = String(r.ep.attrs?.method ?? '');
    const list = direct.length || !path.endsWith('/**') ? direct : r.forward.flatMap((svc) => g.out(svc).filter((f) => f.p === 'exposes').map((f) => g.nodes.get(f.o))
      .filter((x): x is MapNode => Boolean(x) && String(x!.attrs?.path).startsWith(path.slice(0, -3)) && (method === 'ANY' || String(x!.attrs?.method) === method)));
    return list.map((x) => ({ ep: x, service: x.service ? g.nodes.get(x.service) : undefined, op: opOfEndpoint(x, ops) }));
  };
  // a forward is documented when all it reaches is
  const documented = (r: ApiRow) => Boolean(r.op) || (Boolean(r.forward) && reached(r).length > 0 && reached(r).every((x) => x.op));
  const groups = groupApi(rows);
  const o = useOpen();
  const [diff, setDiff] = useState(false);
  const seenOf = (r: ApiRow) => (r.ep ? seen.data?.endpoints[r.ep.id] : undefined);
  const said = contractsText(ops, node.id);
  const diffs = new Map(rows.map((r) => [r.key, diffsOf(r, seenOf(r), said)]));
  const off = (r: ApiRow) => Boolean(r.drift) || Boolean(diffs.get(r.key)?.length);
  const nOff = rows.filter(off).length;
  const piece = k?.pieces.find((p) => p.id === node.id);
  const write = href('docs', 'new', 'contract', piece?.id ?? '-');
  const nSeen = rows.filter((r) => seenOf(r)).length;
  const shown = (list: ApiRow[]) => (diff ? list.filter(off) : list);
  return (
    <section className="panel" aria-labelledby="api-h">
      <header>
        <h3 id="api-h">Endpoints</h3>
        <div className="meta">
          <span>{k ? [plural(rows.filter((r) => r.ep).length, tr('endpoint'), tr('endpoints')), tr('{n} con contrato', { n: rows.filter((r) => r.ep && documented(r)).length }), seen.data ? tr('{n} vistos en los runs', { n: nSeen }) : ''].filter(Boolean).join(' · ') : tr('Leyendo los contratos…')}</span>
          {nOff > 0 && <button type="button" className="btn sm" aria-pressed={diff} onClick={() => setDiff((d) => !d)}>{tr('Solo diferencias ({n})', { n: nOff })}</button>}
          <AllButton o={o} keys={rows.map((r) => r.key)} />
        </div>
      </header>
      <p className="api-note">{tr('Cada endpoint con su contrato —para qué sirve, qué recibe, qué responde y sus errores—, lo que dice su código y, aparte, lo que vieron los runs.')}</p>
      {seen.error && <p className="api-note err-ink">{tr('No se pudo leer lo que vieron los runs:')}{' '}{seen.error}</p>}
      {!rows.length ? <div className="empty"><Missing how={tr('Si los tiene y Laru no los ve (un router propio, una imagen sin código), decláralos en laru.yaml bajo services.<nombre>.endpoints y relee el mapa.')}>{tr('El código no expone endpoints HTTP en {name}.', { name: node.name })}</Missing></div> : groups.map((gr) => {
        const list = shown(gr.rows);
        if (!list.length) return null;
        const c = gr.contract, auth = c && typeof c.fields.auth === 'string' ? c.fields.auth : '';
        const seenHere = gr.rows.filter((r) => seenOf(r)).length;
        return (
          <section key={gr.key} className={`api-group ${gr.kind}`} aria-label={c ? c.title : gr.prefix ?? tr('Reenvíos')}>
            <header className="api-group-h">
              <div className="api-group-t">
                <h4 className={`ttl${gr.kind === 'resource' ? ' mono' : ''}`}>{c ? <a className="rowlink" href={href('docs', c.id)}><Braces />{c.title}</a> : gr.kind === 'forward' ? tr('Reenvía a otros servicios') : gr.prefix}</h4>
                {c ? <Status state={c.status === 'deprecated' ? 'idle' : c.status === 'active' ? 'ok' : 'queue'}>{STATUS[c.status] ?? c.status}</Status> : gr.kind === 'resource' ? <Drift>{tr('Sin contrato')}</Drift> : null}
                <span className="faint">{plural(gr.rows.length, tr('endpoint'), tr('endpoints'))}{seen.data ? ` · ${tr('{n} vistos en los runs', { n: seenHere })}` : ''}</span>
              </div>
              {c ? <p className="api-group-d"><Inline text={c.summary} /></p> : gr.kind === 'forward' ? <p className="api-group-d faint">{tr('Pasan las llamadas a otros servicios: el contrato de cada una es el de lo que alcanza, que se ve al abrirla.')}</p> : <p className="api-group-d faint">{tr('Ningún contrato los documenta todavía.')}</p>}
              {auth && <p className="api-group-auth" title={auth}><span className="faint">{tr('Autenticación:')}</span>{' '}<Inline text={auth} /></p>}
            </header>
            <div className="ops">{list.map((r) => {
              const s = seenOf(r), d = diffs.get(r.key) ?? [];
              const callers = r.ep ? [...new Set(g.in(r.ep.id).filter((f) => f.p === 'calls' || f.p === 'forwards-to').map((f) => f.s))] : [];
              const w = r.ep && flows ? walkers(flows, r.ep.id) : [];
              const facts: Array<[string, ReactNode]> = r.ep ? [
                [tr('Implementación'), <span className="mono" title={r.ep.anchor ? `${r.ep.anchor.repo}:${r.ep.anchor.path}` : undefined}>{String(r.ep.attrs?.handler ?? (r.ep.attrs?.declared ? tr('declarado en laru.yaml') : r.ep.attrs?.contract ? tr('fichero OpenAPI') : ''))} <span className="faint">{at(r.ep)}</span></span>],
                [tr('Quién llega'), callers.length ? <span className="callers">{callers.map((x) => <span key={x} className="chip">{nameOf(g, x)}</span>)}</span> : <span className="faint">{tr('Nadie en el mapa: ni el código ni los runs muestran quién lo llama.')}</span>],
                [tr('Lo recorren'), !flows ? <span className="faint">—</span> : w.length ? <span>{w.map((x, i) => <span key={x.id}>{i ? ', ' : ''}<a className={`rowlink${failedOn(x, r.ep!.id) ? ' err-ink' : ''}`} href={href('docs', x.id)}>{x.title}</a></span>)}</span> : <span className="faint">{tr('Ningún flujo en su último run: escribe uno que lo use.')}</span>],
              ] : [];
              const summary = r.op?.summary ?? (typeof r.ep?.attrs?.summary === 'string' ? r.ep.attrs.summary : undefined);
              const reaches = reached(r), withOp = reaches.filter((x) => x.op).length;
              const to = r.forward?.map((x) => g.nodes.get(x)?.name ?? x), prefix = String(r.ep?.attrs?.path ?? '').endsWith('/**');
              const forwardSays = to && `${tr('reenvía a {services}', { services: to.join(', ') })}${reaches.length ? ` · ${withOp === reaches.length ? plural(withOp, tr('operación con contrato'), tr('operaciones con contrato')) : tr('{n} de {m} operaciones con contrato', { n: withOp, m: reaches.length })}` : prefix ? ` · ${tr('ninguna operación {method} allí', { method: r.method })}` : ''}`;
              return (
                <Operation key={r.key} id={`ep-${slug(r.key)}`} method={r.method} path={r.path} summary={summary ?? forwardSays ?? undefined} seen={s} errors={r.op ? errorsOf(r.op.contract, r.op) : undefined} facts={facts}
                  chips={<>{r.drift === 'not-in-code' && <Drift>{tr('No está en el código')}</Drift>}{r.drift === 'no-contract' && <Drift>{tr('Sin contrato')}</Drift>}{d.length > 0 && <Drift title={tr('Lo que el código o los runs hacen y el contrato no dice')}>{plural(d.length, tr('diferencia'), tr('diferencias'))}</Drift>}</>}
                  body={<EndpointBody r={r} seen={seen} diffs={d} write={write} reaches={reaches} to={to} shapes={shapes.data} />}
                  open={o.has(r.key)} onToggle={() => o.toggle(r.key)} grouped={false} />
              );
            })}</div>
          </section>
        );
      })}
    </section>
  );
}

/** What it publishes and consumes: the contract's events for it, and what the code does that no contract declares. */
function ServiceEvents({ g, node, k, seen }: { g: Indexed; node: MapNode; k?: KnowledgeData; seen?: Seen }) {
  const shapes = useApi<Record<string, Shape>>(`/api/service-shapes?id=${encodeURIComponent(node.id)}`);
  const evs = k ? eventsOf(k.pieces) : [];
  const mine = evs.filter((e) => e.service === node.id);
  const code = g.out(node.id).filter((f) => (f.p === 'publishes' || f.p === 'consumes') && !mine.some((e) => e.direction === f.p && `topic:${e.topic}` === f.o));
  const rows = [...mine.map((e, i) => ({ key: `c${i}`, e, off: false })), ...code.map((f) => ({ key: f.p + f.o, e: { topic: g.nodes.get(f.o)?.name ?? f.o.replace(/^topic:/, ''), direction: f.p, service: node.id }, off: Boolean(k) }))];
  return (
    <section className="panel" aria-labelledby="ev-h">
      <header><h3 id="ev-h">{tr('Eventos')}</h3><div className="meta">{k ? tr('{length} en contratos', { length: mine.length }) : tr('Leyendo los contratos…')}</div></header>
      <Lead>{tr('Lo que publica y lo que consume, cada tema con su contrato: para qué es, qué lleva y por qué clave va, con lo que dice su código debajo de cada cosa; aparte, lo que vieron los runs.')}</Lead>
      {!rows.length && <div className="empty"><Missing how={tr('Laru lee Kafka del código; otra mensajería se declara en laru.yaml bajo services.<nombre>.publishes y consumes.')}>{tr('Ni el código ni sus contratos le dan eventos.')}</Missing></div>}
      {(['publishes', 'consumes'] as const).map((d) => rows.some((r) => r.e.direction === d) && (
        <section key={d} className="link-group" aria-label={DIRECTION[d]}>
          <h4>{DIRECTION[d]} <span className="faint">{plural(rows.filter((r) => r.e.direction === d).length, tr('tema@@Kafka'), tr('temas@@Kafka'))}</span></h4>
          <ul className="evs">{rows.filter((r) => r.e.direction === d).map((r) => <EventRow key={r.key} e={r.e} g={g} seen={seen} self apart unlisted={r.off} shapes={shapes.data} />)}</ul>
        </section>
      ))}
    </section>
  );
}

/** The tables it maps or was seen touching, each as its data model describes it, and the rules of those models. */
function ServiceData({ g, node, k, tables }: { g: Indexed; node: MapNode; k?: KnowledgeData; tables: string[] }) {
  if (!tables.length) return <section className="panel"><div className="empty"><Missing how={tr('Si guarda datos por un camino que Laru no lee (SQL suelto, otro ORM), los runs lo muestran en cuanto toque la base.')}>{tr('{name} no mapea tablas, ni los runs lo han visto tocar ninguna.', { name: node.name })}</Missing></div></section>;
  const ents = k ? entitiesOf(k.pieces) : [];
  const rows = tables.map((t) => ({ t, e: ents.find((x) => `tbl:${x.table}` === t) }));
  const models = [...new Set(rows.flatMap((r) => (r.e ? [r.e.model] : [])))];
  return (
    <>
      <section className="panel" aria-labelledby="data-h">
        <header><h3 id="data-h">{tr('Tablas y modelos de datos')}</h3><div className="meta">{plural(tables.length, tr('tabla'), tr('tablas'))}{k ? tr(' · {length} en modelos de datos', { length: rows.filter((r) => r.e).length }) : ''}</div></header>
        <Lead>{tr('Cada tabla que mapea o que los runs le vieron tocar: lo que dice su modelo de datos, lo que dice el código y, aparte, lo que hicieron los runs con ella.')}</Lead>
        <div className="ents">{rows.map(({ t, e }) => <EntityRow key={t} e={e ?? { table: g.nodes.get(t)?.name ?? t.replace(/^tbl:/, '') }} g={g} self={node.id} />)}</div>
      </section>
      {models.map((m) => {
        const rules = (m.fields.rules ?? []) as string[];
        return rules.length ? <section key={m.id} className="panel" style={{ marginTop: 16 }}><header><h3>{tr('Reglas de «')}{m.title}»</h3></header><ul className="rules">{rules.map((x, i) => <li key={i}><Inline text={x} /></li>)}</ul></section> : null;
      })}
    </>
  );
}

/** What Laru mocks an external from: its mode in each env, the files it answers from, its OpenAPI operations. */
function MockedFrom({ g, node, k, seen }: { g: Indexed; node: MapNode; k?: KnowledgeData; seen: Loaded<Seen> }) {
  const mc = useApi<Record<string, MockContract>>('/api/mock-contracts');
  const m = mc.data?.[node.name];
  const t = seen.data?.targets[node.name];
  const piece = k?.pieces.find((p) => p.id === node.id);
  const o = useOpen();
  const keys = m?.operations?.map((x) => `${x.method} ${x.path}`) ?? [];
  return (
    <>
      <section className="panel" aria-labelledby="mock-h">
        <header><h3 id="mock-h">{tr('Cómo lo imita Laru')}</h3><div className="meta"><AllButton o={o} keys={keys} /></div></header>
        <Lead>{tr('Lo que usamos de un sistema que no es nuestro: cómo lo imita Laru en cada entorno y desde qué contrato; aparte, lo que vieron los runs al hablarle.')}</Lead>
        {mc.error ? <p className="api-note err-ink">{tr('No se pudieron leer los mocks:')}{' '}{mc.error}</p> : !mc.data ? <div className="body"><Skeleton lines={2} /></div> : !m ? (
          <div className="empty">{tr('Ningún entorno lo imita: los runs hablan con el')}{' '}{node.name}{' '}{tr('real. Un mock se declara en')}{' '}<code>{tr('envs/<entorno>.yaml')}</code>{' '}{tr('bajo')}{' '}<code>mocks:</code>.</div>
        ) : (
          <div className="body mock-of">
            {m.envs.map((e) => <p key={e.env}><a className="rowlink mono" href={href('envs', e.env)}>{e.env}</a>{tr(': modo')}{' '}<b>{MOCK_MODE[e.mode]?.label ?? e.mode}</b> <span className="faint">({e.mode})</span>. {MOCK_MODE[e.mode]?.hint}</p>)}
            <p>{tr('Responde desde')}{' '}<span className="mono">{m.dir}/</span>{m.files.length ? <>: {m.files.map((f) => <code key={f} className="file">{f}</code>)}</> : <span className="err-ink">{tr(', que no existe o está vacía.')}</span>}</p>
            {m.error && <p className="err-ink mono">{m.error}</p>}
            {!m.operations && !m.error && <p className="faint">{tr('Sin fichero OpenAPI:')}{' '}{m.envs.some((e) => e.mode === 'script') ? tr('lo que responde está escrito en su guion.') : tr('responde con lo grabado.')}</p>}
          </div>
        )}
        {m?.operations && (
          <div className="ops">{m.operations.map((x) => { const key = `${x.method} ${x.path}`; return <Operation key={key} id={`mock-${slug(key)}`} method={x.method} path={x.path} summary={x.summary} mock={x} open={o.has(key)} onToggle={() => o.toggle(key)} />; })}</div>
        )}
      </section>
      <section className="panel" aria-labelledby="mock-seen-h" style={{ marginTop: 16 }}>
        <header><h3 id="mock-seen-h">{tr('Datos reales')}</h3><div className="meta"><Origin of="observed" />{' '}{tr('lo que vieron los runs')}</div></header>
        <div className="body">{seen.error ? <span className="err-ink">{tr('No se pudo leer lo que vieron los runs:')}{' '}{seen.error}</span> : !seen.data ? <span className="faint">{tr('Leyendo…')}</span> : !t ? <span className="faint">{tr('Ningún flujo le ha hablado en su último run.')}</span> : (
          <>
            <p className="api-p">{plural(t.count, tr('intercambio'), tr('intercambios'))} ({t.kinds.join(', ')}{tr('), el último en el')}{' '}<a className="rowlink" href={href('runs', t.run)}>run {t.run}</a>{t.mock ? <>{tr('; respondidos por el mock (')}<span className="mono">{t.mock}</span>)</> : tr('; con el real')}.</p>
            {t.drift.length > 0 && <><p className="api-p"><Drift>{tr('El mock vio peticiones fuera de su contrato')}</Drift></p><ul className="plain">{t.drift.map((d) => <li key={d} className="mono">{d}</li>)}</ul></>}
          </>
        )}</div>
      </section>
      {k && piece && <div style={{ marginTop: 16 }}><DesignList k={k} g={g} p={piece} seen={seen.data} /></div>}
    </>
  );
}

