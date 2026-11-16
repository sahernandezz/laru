/**
 * What sits under the system map: every component in one table, or one component's sheet. A sheet puts together what
 * the code says (extracted), what someone wrote (declared) and what the flows saw on their last run (observed).
 */
import { Braces, Database, GitBranch, Globe, Pencil, Plug, Server, type LucideIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode, type RefObject } from 'react';
import { useApi, type Fact, type FlowInfo, type Indexed, type KnowledgeData, type MapNode, type MockContract, type Seen } from '../api.ts';
import { AllButton, ContractChip, DesignList, Drift, EntityRow, EventRow, Operation, slug, useOpen, type Loaded } from '../components/Contract.tsx';
import { CopyButton, Dot, Origin, Skeleton, Status, Tabs } from '../components/ui.tsx';
import { entitiesOf, errorsOf, eventsOf, opsOf, serviceApi, unlisted, type ApiRow } from '../lib/contracts.ts';
import { KIND, lastText, MOCK_MODE, pieceLabel, plural } from '../lib/es.ts';
import { Inline } from '../lib/md.tsx';
import { href } from '../lib/route.ts';
import { appsOf, groupsOf } from '../lib/sysmap.ts';
import { nodeParts, nodeTab, through } from '../lib/nodeTabs.ts';
import { AddMenu, Anchors, FacetList, facetsOf, PieceFields, Stale } from './Docs.tsx';
import { failedOn, flowDot, walkers } from './Flows.tsx';
import { TestList, VarLevels } from './Sheets.tsx';
import { tr } from '../lib/i18n.ts';

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
                <a className="rowlink comp-name" href={href('map', n.id)} onClick={onOpen}><Icon />{n.name}</a><span className="only-sm faint"> {kindOf(n)}</span>
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
          <span className="type-badge"><Icon />{pieceLabel(node.type)}{kindOf(node) ? `, ${kindOf(node)}` : ''}</span>{' '}
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
        {tab === 'links' && <FactTable g={g} rows={links.map((f) => ({ f, dir: f.s === node.id ? 'out' : 'in' }))} self={node.id} />}
        {tab === 'data' && <ServiceData g={g} node={node} k={k} tables={[...tables]} />}
        {tab === 'vars' && <><VarLevels names={[...new Set(vars.map((f) => g.nodes.get(f.o)?.name ?? f.o))].map((name) => ({ name, secret: /(SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|PRIVATE|CREDENTIAL)/i.test(name) }))} service={node.name} /><div style={{ height: 16 }} /><FactTable g={g} rows={vars.map((f) => ({ f, dir: 'out' as const }))} self={node.id} /></>}
        {tab === 'tests' && <ServiceTests id={node.id} />}
        {tab === 'libs' && (
          <section className="panel"><div className="scroll-x"><table className="t">
            <thead><tr><th>{tr('Librería')}</th><th>{tr('Versión')}</th><th>{tr('Dónde')}</th></tr></thead>
            <tbody>{libs.map((f) => { const n = g.nodes.get(f.o); return <tr key={f.o + full(f)}><td className="mono">{f.o.startsWith('repo:') ? <a className="rowlink" href={href('repos', f.o.slice(5))}>{f.o}</a> : n?.name}</td><td className="mono faint">{String(n?.attrs?.version ?? '')}</td><td className="mono faint">{where(f)}</td></tr>; })}</tbody>
          </table></div></section>
        )}
        {tab === 'flows' && (
          <section className="panel">{!flows ? <div className="empty">{tr('No se pudo leer el historial de runs.')}</div> : !mine.length ? <div className="empty">{tr('Ningún flujo lo ha recorrido en su último run.')}</div> : (
            <div className="scroll-x"><table className="t">
              <thead><tr><th>{tr('Flujo')}</th><th>{tr('Último')}</th><th>{tr('Falló aquí')}</th></tr></thead>
              <tbody>{mine.map((f) => {
                const hop = here(f);
                return (
                  <tr key={f.id}>
                    <td><a className="rowlink" href={href('docs', f.id, 'map')} style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}><Dot state={flowDot(f)} />{f.title}</a></td>
                    <td>{lastText(f.last)}</td>
                    <td className="wrap">{hop ? <span className="err-ink">{hop.status ?? hop.error ?? tr('sin respuesta')}{' '}{tr('en')}{' '}{hop.what}</span> : <span className="faint">—</span>}</td>
                  </tr>
                );
              })}</tbody>
            </table></div>
          )}</section>
        )}
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
  if (!held.length) return <section className="panel"><div className="empty">{tr('No se conoce nada dentro de este almacén.')}</div></section>;
  const VERB: Record<string, string> = { 'maps-table': tr('mapea'), 'defines-table': tr('la define'), publishes: tr('publica'), consumes: tr('consume'), reads: tr('lee'), writes: tr('escribe') };
  const said = (fs: Fact[]) => [...Map.groupBy(fs, (f) => f.s)].map(([s, x]) => `${nameOf(g, s)} ${[...new Set(x.map((f) => VERB[f.p]))].join(' y ')}`).join(' · ');
  return (
    <section className="panel"><div className="scroll-x"><table className="t">
      <thead><tr><th>{held.every((n) => n.type === 'topic') ? tr('Tema@@Kafka') : tr('Tabla')}</th><th>{tr('En el código')}</th><th>{tr('Visto en runs')}</th></tr></thead>
      <tbody>{held.map((n) => {
        const inn = g.in(n.id);
        const code = inn.filter((f) => f.origin !== 'observed' && f.p in VERB && f.p !== 'reads' && f.p !== 'writes');
        const seen = inn.filter((f) => f.seen && (f.p === 'reads' || f.p === 'writes'));
        const last = seen.reduce<Fact['seen']>((a, f) => (!a || Number(f.seen!.run) > Number(a.run) ? f.seen : a), undefined);
        return (
          <tr key={n.id}>
            <td className="mono">{n.name}</td>
            <td className="wrap">{code.length ? <><Origin of="extracted" label={false} /> {said(code)}</> : <span className="faint">—</span>}</td>
            <td className="wrap">{seen.length ? <><Origin of="observed" label={false} /> {said(seen)} <span className="faint">{tr('(run')}{' '}{last?.run}, {last?.count}×)</span></> : <span className="faint">—</span>}</td>
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

function FactTable({ g, rows, self }: { g: Indexed; rows: Array<{ f: Fact; dir: 'in' | 'out' }>; self: string }) {
  if (!rows.length) return <section className="panel"><div className="empty">{tr('Nada que mostrar aquí.')}</div></section>;
  return (
    <section className="panel"><div className="scroll-x"><table className="t">
      <thead><tr><th>{tr('Relación')}</th><th>{tr('Con')}</th><th>{tr('Cómo')}</th><th>{tr('Origen')}</th><th>{tr('Dónde')}</th></tr></thead>
      <tbody>{rows.map(({ f, dir }, i) => {
        const other = dir === 'out' ? f.o : f.s;
        const into = dir === 'in' || (f.s !== self);
        return (
          <tr key={i}>
            <td>{VERB[f.p]?.[into ? 1 : 0] || f.p}</td>
            <td className="mono">{ICON[g.nodes.get(other)?.type ?? ''] ? <a className="rowlink" href={href('map', other)}>{nameOf(g, other)}</a> : nameOf(g, f.s === self ? f.o : f.s === other ? f.s : f.o)}</td>
            <td className="wrap faint" style={{ maxWidth: 380 }}>{f.note}</td>
            <td><Origin of={f.origin} /></td>
            <td className="mono faint" title={f.anchor ? `${f.anchor.repo}:${f.anchor.path}` : ''}>{f.anchor ? `${f.anchor.path.split('/').pop()}${f.anchor.line ? `:${f.anchor.line}` : ''}` : ''}</td>
          </tr>
        );
      })}</tbody>
    </table></div></section>
  );
}

/* ------------------------------ contracts on a sheet ------------------------------ */

const at = (n: MapNode) => (n.anchor ? `${n.anchor.path.split('/').pop()}${n.anchor.line ? `:${n.anchor.line}` : ''}` : '');

/**
 * A service's endpoints next to the operations that document them: each opens into its request, its responses and
 * errors and a real example. Drift is marked both ways (an endpoint no contract declares, an operation the code lacks)
 * and in what the runs saw (a status the contract does not list, a request a mock found off-contract).
 */
function ServiceApi({ g, node, k, seen, flows }: { g: Indexed; node: MapNode; k?: KnowledgeData; seen: Loaded<Seen>; flows?: FlowInfo[] }) {
  const eps = g.out(node.id).filter((f) => f.p === 'exposes').map((f) => g.nodes.get(f.o)).filter((x): x is MapNode => Boolean(x));
  const ops = k ? opsOf(k.pieces) : [];
  const rows = serviceApi(node.id, eps, ops);
  const contracts = [...new Map(ops.filter((o) => o.service === node.id).map((o) => [o.contract.id, o.contract])).values()];
  const o = useOpen();
  const [diff, setDiff] = useState(false);
  const seenOf = (r: ApiRow) => (r.ep ? seen.data?.endpoints[r.ep.id] : undefined);
  const off = (r: ApiRow) => Boolean(r.drift) || (r.op ? unlisted(seenOf(r)?.statuses, errorsOf(r.op.contract)).length > 0 : false) || Boolean(seenOf(r)?.drift.length);
  const nOff = rows.filter(off).length;
  const shown = diff ? rows.filter(off) : rows;
  const documented = rows.filter((r) => r.op && r.ep).length, nSeen = rows.filter((r) => seenOf(r)).length;
  return (
    <section className="panel" aria-labelledby="api-h">
      <header>
        <h3 id="api-h">{tr('Endpoints y contratos')}</h3>
        <div className="meta">
          <span>{k ? tr('{documented} de {length} en contratos', { documented, length: eps.length }) : tr('Leyendo los contratos…')}{seen.data ? tr(' · {plural} en los runs', { plural: plural(nSeen, tr('visto'), tr('vistos')) }) : ''}</span>
          {nOff > 0 && <button type="button" className="btn sm" aria-pressed={diff} onClick={() => setDiff((d) => !d)}>{tr('Solo diferencias (')}{nOff})</button>}
          <AllButton o={o} keys={shown.map((r) => r.key)} />
        </div>
      </header>
      {k && rows.length > 0 && (contracts.length
        ? <p className="api-note">{tr('Lo documentan')}{' '}{contracts.map((c) => <a key={c.id} className="chip ctr" href={href('docs', c.id)}><Braces />{c.title}</a>)}</p>
        : <p className="api-note faint">{tr('Ningún contrato declara operaciones de')}{' '}{node.name}{tr(': sus endpoints salen del código y no hay con qué contrastarlos.')}</p>)}
      {seen.error && <p className="api-note err-ink">{tr('No se pudo leer lo que vieron los runs:')}{' '}{seen.error}</p>}
      {!rows.length ? <div className="empty">{tr('El código no expone endpoints HTTP en')}{' '}{node.name}.</div> : (
        <div className="ops">
          {shown.map((r) => {
            const s = seenOf(r);
            const callers = r.ep ? [...new Set(g.in(r.ep.id).filter((f) => f.p === 'calls' || f.p === 'forwards-to').map((f) => f.s))] : [];
            const w = r.ep && flows ? walkers(flows, r.ep.id) : [];
            const facts: Array<[string, ReactNode]> = [
              [tr('Contrato'), r.op ? <><ContractChip op={r.op} />{r.op.summary ? <span className="faint"> <Inline text={r.op.summary} /></span> : null}</>
                : r.ep?.attrs?.contract ? tr('Declarado en un fichero OpenAPI del código.') : contracts.length ? <Drift>{tr('Ningún contrato de')}{' '}{node.name}{' '}{tr('lo declara')}</Drift> : <span className="faint">—</span>],
              [tr('Implementación'), r.ep ? <span className="mono" title={r.ep.anchor ? `${r.ep.anchor.repo}:${r.ep.anchor.path}` : undefined}>{String(r.ep.attrs?.handler ?? '')} <span className="faint">{at(r.ep)}</span></span>
                : <Drift>{tr('Ningún endpoint de')}{' '}{node.name}{' '}{tr('responde')}{' '}{r.method} {r.path}</Drift>],
              ...(r.ep ? [
                [tr('Quién llega'), callers.length ? <span className="callers">{callers.map((c) => <span key={c} className="chip">{nameOf(g, c)}</span>)}</span> : <span className="faint">{tr('Nadie en el mapa')}</span>],
                [tr('Lo recorren'), !flows ? <span className="faint">—</span> : w.length ? <span>{w.map((x, i) => <span key={x.id}>{i ? ', ' : ''}<a className={`rowlink${failedOn(x, r.ep!.id) ? ' err-ink' : ''}`} href={href('docs', x.id)}>{x.title}</a></span>)}</span> : <span className="faint">{tr('— sin recorrer')}</span>],
              ] as Array<[string, ReactNode]> : []),
              ...(s ? [[tr('Visto en los runs'), <>{plural(s.count, tr('llamada'), tr('llamadas'))}{tr(', la última en el')}{' '}<a className="rowlink" href={href('runs', s.run)}>run {s.run}</a> · {s.flows.join(', ')}</>]] as Array<[string, ReactNode]> : []),
              ...(s?.drift.length ? [[tr('El mock vio'), <ul className="plain">{s.drift.map((d) => <li key={d} className="mono">{d}</li>)}</ul>]] as Array<[string, ReactNode]> : []),
            ];
            return (
              <Operation key={r.key} id={`ep-${slug(r.key)}`} method={r.method} path={r.path} summary={r.op?.summary} seen={s} errors={r.op ? errorsOf(r.op.contract) : undefined} facts={facts}
                chips={r.drift === 'not-in-code' ? <><ContractChip op={r.op!} /><Drift>{tr('No está en el código')}</Drift></> : r.op ? <ContractChip op={r.op} /> : r.drift === 'no-contract' ? <Drift>{tr('Sin contrato')}</Drift> : null}
                open={o.has(r.key)} onToggle={() => o.toggle(r.key)} />
            );
          })}
        </div>
      )}
    </section>
  );
}

/** What it publishes and consumes: the contract's events for it, and what the code does that no contract declares. */
function ServiceEvents({ g, node, k, seen }: { g: Indexed; node: MapNode; k?: KnowledgeData; seen?: Seen }) {
  const evs = k ? eventsOf(k.pieces) : [];
  const mine = evs.filter((e) => e.service === node.id);
  const code = g.out(node.id).filter((f) => (f.p === 'publishes' || f.p === 'consumes') && !mine.some((e) => e.direction === f.p && `topic:${e.topic}` === f.o));
  // drift only where contracts speak of this service's events, or of that topic
  const unlisted = (topic: string) => mine.length > 0 || evs.some((e) => e.topic === topic);
  return (
    <section className="panel" aria-labelledby="ev-h">
      <header><h3 id="ev-h">{tr('Eventos')}</h3><div className="meta">{k ? tr('{length} en contratos', { length: mine.length }) : tr('Leyendo los contratos…')}</div></header>
      <ul className="evs">
        {mine.map((e, i) => <EventRow key={`c${i}`} e={e} g={g} seen={seen} self />)}
        {code.map((f) => { const topic = g.nodes.get(f.o)?.name ?? f.o.replace(/^topic:/, ''); return <EventRow key={f.p + f.o} e={{ topic, direction: f.p, service: node.id }} g={g} seen={seen} self unlisted={Boolean(k) && unlisted(topic)} />; })}
      </ul>
    </section>
  );
}

/** The tables it maps or was seen touching, each as its data model describes it, and the rules of those models. */
function ServiceData({ g, node, k, tables }: { g: Indexed; node: MapNode; k?: KnowledgeData; tables: string[] }) {
  if (!tables.length) return <section className="panel"><div className="empty">{node.name}{' '}{tr('no mapea tablas, ni los runs lo han visto tocar ninguna.')}</div></section>;
  const ents = k ? entitiesOf(k.pieces) : [];
  const rows = tables.map((t) => ({ t, e: ents.find((x) => `tbl:${x.table}` === t) }));
  const models = [...new Set(rows.flatMap((r) => (r.e ? [r.e.model] : [])))];
  return (
    <>
      <section className="panel" aria-labelledby="data-h">
        <header><h3 id="data-h">{tr('Tablas y modelos de datos')}</h3><div className="meta">{plural(tables.length, tr('tabla'), tr('tablas'))}{k ? tr(' · {length} en modelos de datos', { length: rows.filter((r) => r.e).length }) : ''}</div></header>
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
        <header><h3 id="mock-seen-h">{tr('En los runs')}</h3><Origin of="observed" /></header>
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

/** The tests under the service's directory, by name and line. */
function ServiceTests({ id }: { id: string }) {
  const t = useApi<Array<{ file: string; level: string; count: number; cases: Array<{ name: string; line: number }> }>>(`/api/service-tests?id=${encodeURIComponent(id)}`);
  if (t.loading && !t.data) return <section className="panel"><div className="body"><Skeleton lines={4} /></div></section>;
  return <TestList tests={t.data ?? []} rule={tr('Las pruebas que cuelgan de la carpeta del servicio, por nombre y línea.')} />;
}
