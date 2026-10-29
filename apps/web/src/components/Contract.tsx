/**
 * Contracts where a developer looks. An operation reads as an API reference: its request, its responses and errors,
 * a real example from the runs. A contract is its operations grouped by path, its events and errors; a data model is
 * its entities on their tables, with its rules. What the contract declares, what the code extracts and what the runs
 * observed sit side by side, and where they disagree it says so (drift), with the same rules as the findings.
 */
import { DiagramViewer } from './Viewer.tsx';
import { Braces, ChevronRight, CircleAlert, Table } from 'lucide-react';
import type { EndpointMatch } from '@laru/trace/assemble';
import { endpointOf } from '@laru/trace/summarize';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { DocPiece, Exchange, Indexed, KnowledgeData, MapNode, MockOperation, Sample, Seen, SeenEndpoint } from '../api.ts';
import { entitiesOf, errorsOf, eventsOf, listed, opKey, opOfCall, opOfEndpoint, opsOf, unlisted, type Ev, type Op } from '../lib/contracts.ts';
import { plural, STATUS } from '../lib/es.ts';
import { Inline, Markdown } from '../lib/md.tsx';
import { href } from '../lib/route.ts';
import { langOf } from '../lib/syntax.ts';
import { CodeBlock, HttpStatus, Method, Origin, Status } from './ui.tsx';

/** What a screen has of a GET: its data, or why not. */
export interface Loaded<T> { data?: T; error?: string }

export const opHref = (op: Op) => href('docs', op.contract.id, 'op', opKey(op));
export const ContractChip = ({ op }: { op: Op }) => <a className="chip ctr" href={opHref(op)} title={`${opKey(op)} en ${op.contract.id}`}><Braces />{op.contract.title}</a>;
/** A disagreement between the contract, the code and the runs: amber, with its words. */
/** A line that says the evidence strays from the contract: amber, an icon and its words (no pulse: nothing is running). */
const Warn = ({ children }: { children: ReactNode }) => <p className="warn-line"><CircleAlert />{children}</p>;
export const Drift = ({ children, title }: { children: ReactNode; title?: string }) => <span className="chip run" title={title}><CircleAlert />{children}</span>;

/** Statuses in reading order: numbers up, then the calls that got no answer. */
const order = (keys: string[]) => [...keys].sort((a, b) => (a === 'error' ? 1 : b === 'error' ? -1 : Number(a) - Number(b) || a.localeCompare(b)));
const statusOf = (s: string) => (s === 'error' ? <span className="err-ink">sin respuesta</span> : /^\d+$/.test(s) ? <HttpStatus n={Number(s)} /> : <span className="mono">{s}</span>);

/** The endpoint of the map that implements an operation, when the code has one. */
export const endpointOfOp = (g: Indexed | null, op: Op): MapNode | undefined =>
  g?.out(op.service).filter((f) => f.p === 'exposes').map((f) => g.nodes.get(f.o)).find((ep): ep is MapNode => Boolean(ep && opOfEndpoint(ep, [op])));
const where = (n: MapNode) => (n.anchor ? `${n.anchor.path.split('/').pop()}${n.anchor.line ? `:${n.anchor.line}` : ''}` : '');

/** «201 ×3 · 403 ×1» on an operation's line; a status the contract does not list is marked. */
export function Statuses({ seen, errors }: { seen?: SeenEndpoint; errors?: Array<{ status: string }> }) {
  if (!seen) return null;
  const bad = errors ? unlisted(seen.statuses, errors) : [];
  return (
    <span className="statuses" title={`Visto ${plural(seen.count, 'vez', 'veces')} en los runs; el último, el ${seen.run}`}>
      <span className="sr-only">Visto en los runs:</span>
      {order(Object.keys(seen.statuses)).map((s) => <span key={s} className={bad.includes(s) ? 'drift' : undefined}>{statusOf(s)}<span className="faint num">×{seen.statuses[s]}</span>{bad.includes(s) && <span className="sr-only"> (no está en el contrato)</span>}</span>)}
    </span>
  );
}

export interface OpProps {
  id: string;
  method: string;
  path: string;
  summary?: string;
  /** on its line: the contract it belongs to, or the drift */
  chips?: ReactNode;
  seen?: SeenEndpoint;
  /** the errors of the contract that documents it; none when no contract does (then nothing can be off-contract) */
  errors?: Array<{ status: string; when: string }>;
  /** an OpenAPI mock's own operation: its request and response examples */
  mock?: MockOperation;
  facts?: Array<[string, ReactNode]>;
  open: boolean;
  onToggle: () => void;
}

/** One operation: a line that opens into its reference. The line is a button; the links on it sit beside it. */
export function Operation({ id, method, path, summary, chips, seen, errors, mock, facts, open, onToggle }: OpProps) {
  return (
    <div className={`op${open ? ' open' : ''}`} id={id}>
      <div className="op-line">
        <button type="button" className="op-h" aria-expanded={open} aria-controls={`${id}-b`} onClick={onToggle}>
          <ChevronRight className="tw" /><Method m={method} /><span className="mono op-path">{path}</span>{summary && <span className="op-sum"><Inline text={summary} /></span>}
        </button>
        <span className="op-tags">{chips}<Statuses seen={seen} errors={errors} /></span>
      </div>
      {open && (
        <div className="op-b" id={`${id}-b`}>
          {facts?.length ? <dl className="op-facts">{facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl> : null}
          <h5>Petición</h5>
          <Request method={method} path={path} sample={best(seen)} mock={mock} />
          <h5>Respuestas y errores</h5>
          <Responses seen={seen} errors={errors} mock={mock} />
        </div>
      )}
    </div>
  );
}

/** The example request: a 2xx call with a body, else any with a body, else any. */
function best(seen?: SeenEndpoint): Sample | undefined {
  if (!seen) return undefined;
  const xs = order(Object.keys(seen.samples)).map((s) => seen.samples[s]);
  const ok = (x: Sample) => x.status !== undefined && x.status < 400;
  return xs.find((x) => ok(x) && x.req?.text) ?? xs.find((x) => x.req?.text) ?? xs.find(ok) ?? xs[0];
}

const Source = ({ s }: { s: Sample }) => <p className="op-src"><Origin of="observed" label={false} />Ejemplo real: <a className="rowlink" href={href('runs', s.run, s.flow)}>run {s.run}</a> · {s.flow}</p>;

function Request({ method, path, sample, mock }: { method: string; path: string; sample?: Sample; mock?: MockOperation }) {
  if (sample) {
    const head = [`${sample.method ?? method} ${sample.path ?? path}${sample.query ? `?${sample.query}` : ''}`, sample.reqType && `content-type: ${sample.reqType}`].filter(Boolean).join('\n');
    return (
      <>
        <Source s={sample} />
        <CodeBlock text={head} lang="http" label="Petición de ejemplo" />
        {sample.req?.text && <CodeBlock text={sample.req.text} lang={langOf(sample.req.text, sample.reqType)} format label="Cuerpo de la petición de ejemplo" />}
        {sample.req?.note ? <p className="faint op-note">{sample.req.note}</p> : !sample.req?.text && <p className="faint op-note">Sin cuerpo.</p>}
      </>
    );
  }
  if (mock?.request) return <><p className="op-src"><Origin of="declared" label={false} />Ejemplo del contrato del mock</p><CodeBlock text={mock.request} lang="json" format label="Cuerpo de la petición según el mock" /></>;
  return <p className="faint op-note">{mock ? 'El contrato del mock no describe un cuerpo.' : 'Ningún run la ha llamado todavía: no hay un ejemplo real.'}</p>;
}

interface Resp { status: string; when?: string; declared?: boolean; count?: number; sample?: Sample; example?: string }

function Responses({ seen, errors, mock }: { seen?: SeenEndpoint; errors?: Array<{ status: string; when: string }>; mock?: MockOperation }) {
  const by = new Map<string, Resp>();
  const at = (s: string) => by.get(s) ?? by.set(s, { status: s }).get(s)!;
  for (const r of mock?.responses ?? []) Object.assign(at(r.status), { when: r.description, declared: true, example: r.example });
  for (const e of errors ?? []) Object.assign(at(e.status), { when: e.when, declared: true });
  for (const [s, n] of Object.entries(seen?.statuses ?? {})) Object.assign(at(s), { count: n, sample: seen!.samples[s] });
  const rows = order([...by.keys()]).map((s) => by.get(s)!);
  if (!rows.length) return <p className="faint op-note">Ni el contrato ni los runs dicen qué responde.</p>;
  const first = rows.findIndex((r) => r.sample?.res?.text || r.example);
  return (
    <ul className="resps">
      {rows.map((r, i) => {
        const off = errors && r.count && Number(r.status) >= 400 && !listed(r.status, errors);
        const text = r.sample?.res?.text ?? r.example;
        return (
          <li key={r.status}>
            <div className="resp-h">
              {statusOf(r.status)}
              <span className="resp-when"><Inline text={r.when || (r.status === 'error' ? 'La llamada no obtuvo respuesta.' : '')} /></span>
              <span className="resp-marks">
                {r.declared && <Origin of="declared" />}
                {r.count ? <span className="faint num"><Origin of="observed" label={false} />{plural(r.count, 'vez', 'veces')}</span> : r.declared ? <span className="faint">no vista en los runs</span> : null}
                {off ? <Drift>No está en el contrato</Drift> : null}
              </span>
            </div>
            {text ? (
              <details className="resp-ex" open={i === first}>
                <summary>Ejemplo {r.sample ? `del run ${r.sample.run}` : 'del mock'}</summary>
                <CodeBlock text={text} lang={langOf(text, r.sample?.resType)} format label={`Respuesta ${r.status} de ejemplo`} />
              </details>
            ) : r.sample?.res?.note ? <p className="faint op-note">{r.sample.res.note}</p> : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Which operations are open: one set per list, `all` to open or close them together. */
export function useOpen(initial: string[] = []) {
  const [open, setOpen] = useState(() => new Set(initial));
  return {
    has: (k: string) => open.has(k),
    toggle: (k: string) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; }),
    all: (keys: string[], on: boolean) => setOpen(on ? new Set(keys) : new Set()),
    any: open.size > 0,
  };
}
export const AllButton = ({ o, keys }: { o: ReturnType<typeof useOpen>; keys: string[] }) =>
  keys.length ? <button type="button" className="btn sm" onClick={() => o.all(keys, !o.any)}>{o.any ? 'Plegar todo' : 'Desplegar todo'}</button> : null;

/* -------------------------------- a contract -------------------------------- */

export const DIRECTION: Record<string, string> = { publishes: 'Publica', consumes: 'Consume' };
export const slug = (s: string) => s.replace(/[^\w-]+/g, '-');

/**
 * A contract as an API reference: what it is for, its operations grouped by path (each opening into its request,
 * responses and an example from the runs), its events and its errors. `focus` opens one operation and brings it into view.
 */
export function ContractReference({ k, g, p, seen, focus }: { k: KnowledgeData; g: Indexed | null; p: DocPiece; seen: Loaded<Seen>; focus?: string }) {
  const ops = opsOf([p]), evs = eventsOf([p]), errors = errorsOf(p);
  const o = useOpen(focus ? [focus] : []);
  const paths = [...Map.groupBy(ops, (x) => x.path)];
  const keys = ops.map(opKey);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focus) return;
    if (!o.has(focus)) o.toggle(focus);
    requestAnimationFrame(() => {
      const el = box.current?.querySelector<HTMLElement>(`[id="op-${CSS.escape(slug(focus))}"]`);
      el?.scrollIntoView({ block: 'start' });
      el?.querySelector<HTMLElement>('.op-h')?.focus({ preventScroll: true });
    });
  }, [focus]);
  const missing = g ? ops.filter((x) => !endpointOfOp(g, x)).length : 0;
  const purpose = typeof p.fields.purpose === 'string' ? p.fields.purpose : '';
  // every status its operations answered in the runs, and the error ones it does not list, with who answered them
  const answered = ops.flatMap((x) => { const ep = endpointOfOp(g, x); return Object.entries(seen.data?.endpoints[ep?.id ?? '']?.statuses ?? {}).map(([st, c]) => ({ x, st, c })); });
  const stats = answered.map(({ st, c }) => [st, c] as [string, number]);
  const off = [...Map.groupBy(answered.filter(({ st }) => Number(st) >= 400 && !listed(st, errors)), ({ st }) => st)].sort(([a], [b]) => Number(a) - Number(b)).map(([st, xs]) => [st, [...new Set(xs.map(({ x }) => opKey(x)))]] as [string, string[]]);
  return (
    <div className="ref" ref={box}>
      {purpose && <section className="panel"><div className="body"><Markdown text={purpose} /></div></section>}
      {seen.error && <div className="notice warn"><CircleAlert /><div>No se pudo leer lo que vieron los runs: {seen.error}. La referencia sale solo del contrato y del código.</div></div>}
      <section className="panel" aria-labelledby="ref-ops-h">
        <header>
          <h3 id="ref-ops-h">Operaciones</h3>
          <div className="meta">
            <span>{plural(ops.length, 'operación', 'operaciones')} · {plural(paths.length, 'ruta', 'rutas')}{missing ? ' · ' : ''}{missing ? <span className="run-ink">{missing} sin implementar</span> : null}</span>
            <AllButton o={o} keys={keys} />
          </div>
        </header>
        {!ops.length ? <div className="empty">Este contrato no declara operaciones HTTP.</div> : paths.map(([path, list]) => (
          <section key={path} className="api-path" aria-label={`Ruta ${path}`}>
            <h4 className="mono">{path}</h4>
            {list.map((x) => {
              const ep = endpointOfOp(g, x), s = ep ? seen.data?.endpoints[ep.id] : undefined, svc = g?.nodes.get(x.service);
              const facts: Array<[string, ReactNode]> = [
                ['Servicio', svc ? <a className="rowlink" href={href('map', svc.id)}>{svc.name}</a> : <span className="mono">{x.service || '—'}</span>],
                ['En el código', !g ? <span className="faint">Sin mapa: pulsa «Releer el código» en Proyectos.</span> : ep ? <><Origin of="extracted" label={false} /> <span className="mono" title={ep.anchor ? `${ep.anchor.repo}:${ep.anchor.path}` : undefined}>{String(ep.attrs?.handler ?? ep.name)} {where(ep)}</span></> : <Drift>Ningún endpoint de {svc?.name ?? x.service} responde {opKey(x)}</Drift>],
                ['Visto en los runs', s ? <>{plural(s.count, 'llamada', 'llamadas')}, la última en el <a className="rowlink" href={href('runs', s.run)}>run {s.run}</a> · {s.flows.join(', ')}</> : <span className="faint">{seen.data ? 'Ningún flujo la ha llamado en su último run.' : seen.error ? '—' : 'Leyendo…'}</span>],
                ...(s?.drift.length ? [['El mock vio', <ul className="plain">{s.drift.map((d) => <li key={d} className="mono">{d}</li>)}</ul>] as [string, ReactNode]] : []),
              ];
              return <Operation key={opKey(x)} id={`op-${slug(opKey(x))}`} method={x.method} path={x.path} summary={x.summary} seen={s} errors={errors} facts={facts}
                chips={g && !ep ? <Drift>No está en el código</Drift> : null} open={o.has(opKey(x))} onToggle={() => o.toggle(opKey(x))} />;
            })}
          </section>
        ))}
      </section>
      {evs.length > 0 && <Events evs={evs} g={g} seen={seen.data} />}
      <section className="panel" aria-labelledby="ref-err-h">
        <header><h3 id="ref-err-h">Errores</h3><div className="meta">Los que debe tratar quien llama</div></header>
        {!errors.length && !off.length ? <div className="empty">El contrato no declara errores: cualquier 4xx o 5xx que vean los runs saldrá como diferencia.</div> : (
          <ul className="resps errs">
            {errors.map((e) => {
              const n = stats.filter(([st]) => listed(st, [e])).reduce((a, [, c]) => a + c, 0);
              return <li key={e.status}><div className="resp-h">{statusOf(e.status)}<span className="resp-when"><Inline text={e.when} /></span><span className="resp-marks"><Origin of="declared" />{n ? <span className="faint num"><Origin of="observed" label={false} />{plural(n, 'vez', 'veces')}</span> : <span className="faint">no visto en los runs</span>}</span></div></li>;
            })}
            {off.map(([st, list]) => (
              <li key={st}><div className="resp-h">{statusOf(st)}<span className="resp-when">Lo respondió {list.map((x, i) => <span key={x}>{i ? ', ' : ''}<span className="mono">{x}</span></span>)}</span><span className="resp-marks"><span className="faint num"><Origin of="observed" label={false} />{plural(stats.filter(([s]) => s === st).reduce((a, [, c]) => a + c, 0), 'vez', 'veces')}</span><Drift>No está en el contrato</Drift></span></div></li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** A contract's events: who publishes or consumes each topic, its payload, whether the code does it and a real message. */
function Events({ evs, g, seen }: { evs: Ev[]; g: Indexed | null; seen?: Seen }) {
  return (
    <section className="panel" aria-labelledby="ref-ev-h">
      <header><h3 id="ref-ev-h">Eventos</h3><div className="meta">{plural(evs.length, 'evento', 'eventos')}</div></header>
      <ul className="evs">{evs.map((e, i) => <EventRow key={i} e={e} g={g} seen={seen} />)}</ul>
    </section>
  );
}

/** An event: who publishes or consumes it, its payload, whether the code does it, and a real message. On a service's
 * sheet (`self`) it names its contract instead of the service; one the code does and no contract declares is `unlisted`. */
export function EventRow({ e, g, seen, self, unlisted: off }: { e: Omit<Ev, 'contract'> & { contract?: DocPiece }; g: Indexed | null; seen?: Seen; self?: boolean; unlisted?: boolean }) {
  const svc = g?.nodes.get(e.service);
  const inCode = g?.out(e.service).some((f) => f.p === e.direction && f.o === `topic:${e.topic}`);
  const t = seen?.topics[e.topic];
  const saw = t && (e.direction === 'publishes' ? t.publishers : t.consumers).includes(svc?.name ?? e.service.replace(/^svc:/, ''));
  return (
    <li>
      <div className="ev-h">
        <span className={`dir ${e.direction}`}>{DIRECTION[e.direction] ?? e.direction}</span>
        <a className="mono rowlink k-kafka-ink" href={href('map', `topic:${e.topic}`)}>{e.topic}</a>
        {!self && <span className="faint">{svc ? <a className="rowlink" href={href('map', svc.id)}>{svc.name}</a> : e.service}</span>}
        <span className="op-tags">
          {self && e.contract && <a className="chip ctr" href={href('docs', e.contract.id)}><Braces />{e.contract.title}</a>}
          {off && <Drift>Sin contrato</Drift>}
          {g && e.contract && inCode === false && <Drift>No está en el código</Drift>}
          {t && <span className="faint num" title={`Visto en el run ${t.run}`}><Origin of="observed" label={false} />{saw ? (e.direction === 'publishes' ? plural(t.count, 'mensaje', 'mensajes') : 'consumido en los runs') : 'no visto en este servicio'}</span>}
        </span>
      </div>
      {e.payload && <p className="ev-payload"><span className="faint">Contenido:</span> <Inline text={e.payload} /></p>}
      {t?.sample?.req?.text && e.direction === 'publishes' && saw && (
        <details className="resp-ex"><summary>Mensaje real del run {t.sample.run}</summary><CodeBlock text={t.sample.req.text} lang={langOf(t.sample.req.text)} format label={`Mensaje de ${e.topic}`} /></details>
      )}
    </li>
  );
}

/* ------------------------------- a data model ------------------------------- */

const VERB: Record<string, string> = { 'maps-table': 'la mapea', 'defines-table': 'la define', reads: 'la lee', writes: 'la escribe' };
/** «la mapea, la lee y la escribe» */
const and = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} y ${xs.at(-1)}`);

/** A data model as its entities on their tables: owner, notes, what the code and the runs say of each table; then its rules. */
export function DataModelReference({ p, g }: { p: DocPiece; g: Indexed | null }) {
  const ents = entitiesOf([p]);
  const rules = (p.fields.rules ?? []) as string[];
  const purpose = typeof p.fields.purpose === 'string' ? p.fields.purpose : '';
  const missing = g ? ents.filter((e) => e.table && !g.nodes.has(`tbl:${e.table}`)).length : 0;
  return (
    <div className="ref">
      {purpose && <section className="panel"><div className="body"><Markdown text={purpose} /></div></section>}
      <section className="panel" aria-labelledby="dm-ent-h">
        <header><h3 id="dm-ent-h">Entidades</h3><div className="meta">{plural(ents.length, 'entidad', 'entidades')}{missing ? <span className="run-ink">{missing} sin tabla en el código</span> : null}</div></header>
        {!ents.length ? <div className="empty">Este modelo no declara entidades.</div> : <div className="ents">{ents.map((e) => <EntityRow key={e.entity + (e.table ?? '')} e={e} g={g} />)}</div>}
      </section>
      {ents.some((e) => e.table) && <DiagramViewer id={`er:${p.id}`} height={360} />}
      <section className="panel" aria-labelledby="dm-rules-h">
        <header><h3 id="dm-rules-h">Reglas</h3><div className="meta">{plural(rules.length, 'regla', 'reglas')}</div></header>
        {rules.length ? <ul className="rules">{rules.map((r, i) => <li key={i}><Markdown text={r} /></li>)}</ul> : <div className="empty">Sin reglas escritas sobre estos datos.</div>}
      </section>
    </div>
  );
}

/**
 * One entity: its table, owner and notes; who maps, defines, reads or writes the table, and a writer other than its
 * owner. Without a model it is a table the code has and no data model describes.
 */
export function EntityRow({ e, g, self }: { e: { model?: DocPiece; entity?: string; table?: string; owner?: string; notes?: string }; g: Indexed | null; self?: string }) {
  const id = e.table ? `tbl:${e.table}` : '';
  const owner = e.owner ? g?.nodes.get(e.owner) : undefined;
  const facts = id && g ? g.in(id).filter((f) => f.p in VERB) : [];
  const said = [...Map.groupBy(facts, (f) => f.s)].map(([s, fs]) => {
    const n = g!.nodes.get(s)?.name ?? s.replace(/^\w+:/, '');
    const seen = fs.find((f) => f.seen)?.seen;
    return <span key={s}>{n} {and([...new Set(fs.map((f) => VERB[f.p]))])}{seen ? <span className="faint"> (run {seen.run})</span> : null}</span>;
  });
  const others = facts.filter((f) => f.p === 'writes' && e.owner && f.s !== e.owner).map((f) => g!.nodes.get(f.s)?.name ?? f.s);
  return (
    <div className="ent">
      <div className="ent-h">
        <Table /><b>{e.entity ?? e.table}</b>
        {e.entity && (e.table ? (g?.nodes.has(id) ? <a className="mono rowlink k-sql-ink" href={href('map', id)}>{e.table}</a> : <span className="mono">{e.table}</span>) : <span className="faint">sin tabla</span>)}
        <span className="op-tags">
          {self && e.model && <a className="chip ctr" href={href('docs', e.model.id)}><Table />{e.model.title}</a>}
          {!e.model && <Drift>Ningún modelo de datos la describe</Drift>}
          {g && e.table && !g.nodes.has(id) && <Drift>No está en el código</Drift>}
          {others.length > 0 && <Drift title={`Su dueño es ${owner?.name ?? e.owner}`}>También la escribe {[...new Set(others)].join(', ')}</Drift>}
        </span>
      </div>
      <dl className="op-facts">
        {e.model && <div><dt>Dueño</dt><dd>{owner ? <a className="rowlink" href={href('map', owner.id)}>{owner.name}</a> : e.owner ? <span className="mono">{e.owner}</span> : <span className="faint">—</span>}{self && e.owner && e.owner !== self ? <span className="faint"> (no es este servicio)</span> : null}</dd></div>}
        {e.notes && <div><dt>Notas</dt><dd><Inline text={e.notes} /></dd></div>}
        {said.length > 0 && <div><dt>En el código y los runs</dt><dd className="said">{said}</dd></div>}
      </dl>
    </div>
  );
}

/* ------------------------- the design of a container ------------------------- */

/** A container's contracts and data models, its own and those of the modules below it, one line each. */
export function DesignList({ k, g, p, seen }: { k: KnowledgeData; g: Indexed | null; p: DocPiece; seen?: Seen }) {
  const below = (id: string): DocPiece[] => k.pieces.filter((x) => x.parent === id).flatMap((x) => (x.type === 'contract' || x.type === 'data-model' ? [x] : k.containers.includes(x.type) ? below(x.id) : []));
  const list = below(p.id);
  if (!list.length) return null;
  const byId = new Map(k.pieces.map((x) => [x.id, x]));
  return (
    <section className="panel design" aria-labelledby="design-h">
      <header><h3 id="design-h">Contratos y modelos de datos</h3><div className="meta">{plural(list.length, 'pieza', 'piezas')} de diseño</div></header>
      <ul>{list.map((x) => {
        const home = x.parent !== p.id ? byId.get(x.parent ?? '') : undefined;
        let stats: string, drift = 0, off = 0;
        if (x.type === 'contract') {
          const ops = opsOf([x]), evs = eventsOf([x]), errs = errorsOf(x);
          stats = [plural(ops.length, 'operación', 'operaciones'), evs.length && plural(evs.length, 'evento', 'eventos'), errs.length && plural(errs.length, 'error', 'errores')].filter(Boolean).join(' · ');
          if (g) for (const op of ops) { const ep = endpointOfOp(g, op); if (!ep) drift++; else if (unlisted(seen?.endpoints[ep.id]?.statuses, errs).length) off++; }
        } else {
          const ents = entitiesOf([x]);
          stats = [plural(ents.length, 'entidad', 'entidades'), ((x.fields.rules ?? []) as string[]).length && plural(((x.fields.rules ?? []) as string[]).length, 'regla', 'reglas')].filter(Boolean).join(' · ');
          if (g) drift = ents.filter((e) => e.table && !g.nodes.has(`tbl:${e.table}`)).length;
        }
        const Icon = x.type === 'contract' ? Braces : Table;
        return (
          <li key={x.id}>
            <Icon />
            <div className="design-main"><a className="rowlink ttl" href={href('docs', x.id)}>{x.title}</a> <code className="faint">{x.id}</code><div className="faint">{stats}{home ? ` · en ${home.title}` : ''}</div></div>
            <span className="op-tags">
              <Status state={['implemented', 'active'].includes(x.status) ? 'ok' : x.status === 'deprecated' ? 'idle' : 'queue'}>{STATUS[x.status] ?? x.status}</Status>
              {drift > 0 && <Drift>{x.type === 'contract' ? `${drift} sin implementar` : `${drift} sin tabla`}</Drift>}
              {off > 0 && <Drift>{plural(off, 'operación responde', 'operaciones responden')} fuera de contrato</Drift>}
            </span>
          </li>
        );
      })}</ul>
    </section>
  );
}

/* ------------------------------ in the inspector ------------------------------ */

const WRITE = /^(INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b/i;

/**
 * Which contract the selected exchange exercised and whether it kept to it: an operation and its status, an event and
 * who may publish or consume it, a table and its owner; a hop that only forwards says where the contract is; a mock
 * says where the request strayed. Nothing when no contract speaks of it.
 */
export function ExchangeContract({ ex, exchanges, k, types, g, match }: { ex: Exchange; exchanges: Exchange[]; k?: KnowledgeData; types: Map<string, string>; g: Indexed | null; match: EndpointMatch }) {
  if (!k) return null;
  const ops = opsOf(k.pieces);
  // the map endpoint a hop reached decides its operation, as on the service sheet
  const opAt = (e: Exchange) => { const id = endpointOf(e, match); return opOfCall(e.to, e.method, e.path, ops, id ? g?.nodes.get(id) : undefined); };
  const lines: ReactNode[] = [];
  const opLine = (op: Op, e: Exchange, via?: boolean) => {
    const errs = errorsOf(op.contract), s = e.status;
    const fine = s === undefined ? null : s < 400 || listed(String(s), errs);
    const when = s !== undefined && s >= 400 ? errs.find((x) => listed(String(s), [x]))?.when : undefined;
    return (
      <>
        <p>{via ? <>La llamada sigue hasta <b>{e.to}</b>, que ejerce </> : 'Ejerce '}<a className="rowlink" href={opHref(op)}><Method m={op.method} /><span className="mono">{op.path}</span></a> de <a className="rowlink" href={href('docs', op.contract.id)}>«{op.contract.title}»</a>.</p>
        {s === undefined ? <p className="faint">{e.error ? 'No llegó respuesta: no se puede contrastar.' : 'Sin estado que contrastar.'}</p>
          : fine ? <Status state="ok"><span><HttpStatus n={s} /> {s < 400 ? 'Respuesta correcta.' : `Error previsto en el contrato${when ? `: ${when}` : '.'}`}</span></Status>
          : <Warn><span><HttpStatus n={s} /> no está entre los errores de «{op.contract.title}».</span></Warn>}
      </>
    );
  };
  if (ex.kind === 'http' && ex.method && ex.path) {
    const op = opAt(ex);
    if (op) lines.push(<div key="op">{opLine(op, ex)}</div>);
    else {
      // a gateway or a front that passes the call on: the contract is the next hop's
      let next: Exchange | undefined = ex, found: Op | undefined;
      for (let i = 0; i < 5 && next && !found; i++) {
        const from: Exchange = next;
        // its child; in traces assembled before parents ignored open streams, the target's own call of the same method
        // and path inside its time
        next = exchanges.find((x) => x.parent === from.id && x.method === ex.method && x.path === ex.path)
          ?? exchanges.find((x) => x.from === from.to && x.method === ex.method && x.path === ex.path && x.t0 >= from.t0 - 2 && x.t0 <= (from.t1 ?? Infinity));
        found = next && opAt(next);
      }
      if (found && next) lines.push(<div key="op">{opLine(found, next, true)}</div>);
      else if (ops.some((o) => o.service === `svc:${ex.to}`)) lines.push(<div key="op"><Warn><span>Ningún contrato de {ex.to} declara <Method m={ex.method} /><span className="mono">{ex.path}</span>.</span></Warn></div>);
    }
  }
  if (ex.kind === 'kafka' && ex.topic) {
    const evs = eventsOf(k.pieces).filter((e) => e.topic === ex.topic);
    const consume = types.get(ex.from) === 'datastore';
    const who = consume ? ex.to : ex.from, dir = consume ? 'consumes' : 'publishes';
    const ev = evs.find((e) => e.direction === dir && e.service === `svc:${who}`);
    if (ev) lines.push(<div key="ev"><p>Evento <span className="mono">{ex.topic}</span> de <a className="rowlink" href={href('docs', ev.contract.id)}>«{ev.contract.title}»</a>{ev.payload ? <>: <span className="faint">{ev.payload}</span></> : '.'}</p><Status state="ok">{who} lo {consume ? 'consume' : 'publica'}, como dice el contrato.</Status></div>);
    else if (evs.length) lines.push(<div key="ev"><Warn><span>Ningún contrato dice que {who} {consume ? 'consuma' : 'publique'} <span className="mono">{ex.topic}</span>; «{evs[0].contract.title}» lo declara para otros.</span></Warn></div>);
  }
  if (ex.kind === 'sql' && ex.table) {
    const e = entitiesOf(k.pieces).find((x) => x.table === ex.table);
    if (e) {
      const owner = e.owner?.replace(/^svc:/, '');
      const writes = WRITE.test(ex.label);
      lines.push(<div key="tbl"><p>Tabla <span className="mono">{ex.table}</span>: entidad «{e.entity}» de <a className="rowlink" href={href('docs', e.model.id)}>«{e.model.title}»</a>{owner ? `, cuyo dueño es ${owner}` : ''}.</p>
        {writes && owner && owner !== ex.from ? <Warn>{ex.from} la escribe sin ser su dueño.</Warn> : null}</div>);
    }
  }
  for (const d of ex.drift ?? []) lines.push(<div key={d}><Warn><span>El mock vio que se sale de su contrato: <span className="mono">{d}</span></span></Warn></div>);
  if (!lines.length) return null;
  return <div className="ex-contract" aria-label="Contrato"><Braces />{<div className="ex-lines">{lines}</div>}</div>;
}
