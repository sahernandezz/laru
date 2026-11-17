/**
 * Contracts where a developer looks. An operation reads as an API reference: its request, its responses and errors,
 * a real example from the runs. A contract is its operations grouped by path, its events and errors; a data model is
 * its entities on their tables, with its rules. What the contract declares, what the code extracts and what the runs
 * observed sit side by side, and where they disagree it says so (drift), with the same rules as the findings.
 */
import { DiagramViewer } from './Viewer.tsx';
import { Braces, ChevronRight, CircleAlert, CircleDashed, Table } from 'lucide-react';
import type { EndpointMatch } from '@laru/trace/assemble';
import { endpointOf } from '@laru/trace/summarize';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { DocPiece, Exchange, Fact, Indexed, KnowledgeData, MapNode, MockOperation, Sample, Seen, SeenEndpoint } from '../api.ts';
import { detailOf, entitiesOf, errorsOf, eventsOf, listed, noteParts, opKey, opOfCall, opOfEndpoint, opsOf, unlisted, type ApiRow, type Diff, type Ev, type Op } from '../lib/contracts.ts';
import { plural, STATUS } from '../lib/es.ts';
import { Inline, Markdown } from '../lib/md.tsx';
import { href } from '../lib/route.ts';
import { langOf } from '../lib/syntax.ts';
import { CodeBlock, HttpStatus, Method, Origin, Skeleton, Status } from './ui.tsx';
import { tr, trx } from '../lib/i18n.ts';

/** What a screen has of a GET: its data, or why not. */
export interface Loaded<T> { data?: T; error?: string }

export const opHref = (op: Op) => href('docs', op.contract.id, 'op', opKey(op));
export const ContractChip = ({ op }: { op: Op }) => <a className="chip ctr" href={opHref(op)} title={tr('{opKey} en {id}', { opKey: opKey(op), id: op.contract.id })}><Braces />{op.contract.title}</a>;
/** A disagreement between the contract, the code and the runs: amber, with its words. */
/** A line that says the evidence strays from the contract: amber, an icon and its words (no pulse: nothing is running). */
const Warn = ({ children }: { children: ReactNode }) => <p className="warn-line"><CircleAlert />{children}</p>;
export const Drift = ({ children, title }: { children: ReactNode; title?: string }) => <span className="chip run" title={title}><CircleAlert />{children}</span>;

/** Statuses in reading order: numbers up, then the calls that got no answer. */
const order = (keys: string[]) => [...keys].sort((a, b) => (a === 'error' ? 1 : b === 'error' ? -1 : Number(a) - Number(b) || a.localeCompare(b)));
const statusOf = (s: string) => (s === 'error' ? <span className="err-ink">{tr('sin respuesta')}</span> : /^\d+$/.test(s) ? <HttpStatus n={Number(s)} /> : <span className="mono">{s}</span>);

/** The endpoint of the map that implements an operation, when the code has one. */
export const endpointOfOp = (g: Indexed | null, op: Op): MapNode | undefined =>
  g?.out(op.service).filter((f) => f.p === 'exposes').map((f) => g.nodes.get(f.o)).find((ep): ep is MapNode => Boolean(ep && opOfEndpoint(ep, [op])));
const where = (n: MapNode) => (n.anchor ? `${n.anchor.path.split('/').pop()}${n.anchor.line ? `:${n.anchor.line}` : ''}` : '');

/** «201 ×3 · 403 ×1» on an operation's line; a status the contract does not list is marked. */
export function Statuses({ seen, errors }: { seen?: SeenEndpoint; errors?: Array<{ status: string }> }) {
  if (!seen) return null;
  const bad = errors ? unlisted(seen.statuses, errors) : [];
  return (
    <span className="statuses" title={tr('Visto {plural} en los runs; el último, el {run}', { plural: plural(seen.count, tr('vez'), tr('veces')), run: seen.run })}>
      <span className="sr-only">{tr('Visto en los runs:')}</span>
      {order(Object.keys(seen.statuses)).map((s) => <span key={s} className={bad.includes(s) ? 'drift' : undefined}>{statusOf(s)}<span className="faint num">×{seen.statuses[s]}</span>{bad.includes(s) && <span className="sr-only">{' '}{tr('(no está en el contrato)')}</span>}</span>)}
    </span>
  );
}

export interface OpProps {
  id: string;
  /** under a heading that already names its path: the row says the method and what it does, not the path again */
  grouped?: boolean;
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
  /** what it opens into, instead of its request and responses: an endpoint's contract, code and real data */
  body?: ReactNode;
  open: boolean;
  onToggle: () => void;
}

/** One operation: a line that opens into its reference. The line is a button; the links on it sit beside it. */
export function Operation({ id, method, path, summary, chips, seen, errors, mock, facts, body, open, onToggle, grouped }: OpProps) {
  return (
    <div className={`op${open ? ' open' : ''}`} id={id}>
      <div className="op-line">
        <button type="button" className="op-h" aria-expanded={open} aria-controls={`${id}-b`} onClick={onToggle}>
          <ChevronRight className="tw" /><Method m={method} />{grouped ? <span className="sr-only">{path}</span> : <span className="mono op-path">{path}</span>}{summary && <span className={`op-sum${grouped ? ' full' : ''}`}><Inline text={summary} /></span>}
        </button>
        <span className="op-tags">{chips}<Statuses seen={seen} errors={errors} /></span>
      </div>
      {open && (
        <div className="op-b" id={`${id}-b`}>
          {facts?.length ? <dl className="op-facts">{facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl> : null}
          {body ?? <>
            <h5>{tr('Petición')}</h5>
            <Request method={method} path={path} sample={best(seen)} mock={mock} />
            <h5>{tr('Respuestas y errores')}</h5>
            <Responses seen={seen} errors={errors} mock={mock} />
          </>}
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

const Source = ({ s }: { s: Sample }) => <p className="op-src"><Origin of="observed" label={false} />{tr('Ejemplo real:')}{' '}<a className="rowlink" href={href('runs', s.run, s.flow)}>run {s.run}</a> · {s.flow}</p>;

function Request({ method, path, sample, mock }: { method: string; path: string; sample?: Sample; mock?: MockOperation }) {
  if (sample) {
    const head = [`${sample.method ?? method} ${sample.path ?? path}${sample.query ? `?${sample.query}` : ''}`, sample.reqType && `content-type: ${sample.reqType}`].filter(Boolean).join('\n');
    return (
      <>
        <Source s={sample} />
        <CodeBlock text={head} lang="http" label={tr('Petición de ejemplo')} />
        {sample.req?.text && <CodeBlock text={sample.req.text} lang={langOf(sample.req.text, sample.reqType)} format label={tr('Cuerpo de la petición de ejemplo')} />}
        {sample.req?.note ? <p className="faint op-note">{sample.req.note}</p> : !sample.req?.text && <p className="faint op-note">{tr('Sin cuerpo.')}</p>}
      </>
    );
  }
  if (mock?.request) return <><p className="op-src"><Origin of="declared" label={false} />{tr('Ejemplo del contrato del mock')}</p><CodeBlock text={mock.request} lang="json" format label={tr('Cuerpo de la petición según el mock')} /></>;
  return <p className="faint op-note">{mock ? tr('El contrato del mock no describe un cuerpo.') : tr('Ningún run la ha llamado todavía: no hay un ejemplo real.')}</p>;
}

interface Resp { status: string; when?: string; declared?: boolean; count?: number; sample?: Sample; example?: string }

function Responses({ seen, errors, mock }: { seen?: SeenEndpoint; errors?: Array<{ status: string; when: string }>; mock?: MockOperation }) {
  const by = new Map<string, Resp>();
  const at = (s: string) => by.get(s) ?? by.set(s, { status: s }).get(s)!;
  for (const r of mock?.responses ?? []) Object.assign(at(r.status), { when: r.description, declared: true, example: r.example });
  for (const e of errors ?? []) Object.assign(at(e.status), { when: e.when, declared: true });
  for (const [s, n] of Object.entries(seen?.statuses ?? {})) Object.assign(at(s), { count: n, sample: seen!.samples[s] });
  const rows = order([...by.keys()]).map((s) => by.get(s)!);
  if (!rows.length) return <p className="faint op-note">{tr('Ni el contrato ni los runs dicen qué responde.')}</p>;
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
              <span className="resp-when"><Inline text={r.when || (r.status === 'error' ? tr('La llamada no obtuvo respuesta.') : '')} /></span>
              <span className="resp-marks">
                {r.declared && <Origin of="declared" />}
                {r.count ? <span className="faint num"><Origin of="observed" label={false} />{plural(r.count, tr('vez'), tr('veces'))}</span> : r.declared ? <span className="faint">{tr('no vista en los runs')}</span> : null}
                {off ? <Drift>{tr('No está en el contrato')}</Drift> : null}
              </span>
            </div>
            {text ? (
              <details className="resp-ex" open={i === first}>
                <summary>{tr('Ejemplo')}{' '}{r.sample ? tr('del run {run}', { run: r.sample.run }) : tr('del mock')}</summary>
                <CodeBlock text={text} lang={langOf(text, r.sample?.resType)} format label={tr('Respuesta {status} de ejemplo', { status: r.status })} />
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
  keys.length ? <button type="button" className="btn sm" onClick={() => o.all(keys, !o.any)}>{o.any ? tr('Plegar todo') : tr('Desplegar todo')}</button> : null;

/* -------------------------------- an endpoint -------------------------------- */

/** Something not known yet, never an empty box: what is missing, and what brings it. */
export const Missing = ({ children, how }: { children: ReactNode; how?: ReactNode }) => (
  <p className="missing"><CircleDashed aria-hidden="true" /><span>{children}{how ? <>{' '}<span className="how">{how}</span></> : null}</span></p>
);

const IN: Record<string, string> = { path: tr('ruta'), query: tr('consulta'), header: tr('cabecera'), cookie: tr('cookie'), form: tr('formulario'), body: tr('cuerpo') };
interface CodeParam { in: string; name: string; type?: string; required?: boolean }

/** What its code takes, each parameter by where it goes, its name, its type and whether it may be left out. */
const CodeParams = ({ params }: { params: CodeParam[] }) => (
  <ul className="params">{params.map((p) => (
    <li key={p.in + p.name}><span className="in">{IN[p.in] ?? p.in}</span><code>{p.in === 'body' && p.type ? p.type : p.name}</code>{p.type && p.in !== 'body' ? <span className="faint">{p.type}</span> : null}{p.required === false ? <span className="faint">{tr('opcional')}</span> : null}</li>
  ))}</ul>
);
/** A line of what the code says, under what the contract says. */
const Code = ({ children }: { children: ReactNode }) => <div className="ep-code"><span className="src"><Origin of="extracted" label={false} />{tr('Su código')}</span>{children}</div>;
const Part = ({ label, children }: { label: string; children: ReactNode }) => <div className="ep-part"><h6>{label}</h6>{children}</div>;
const statusList = (xs: Array<number | string>) => xs.map((x, i) => <span key={x}>{i ? ', ' : ''}<HttpStatus n={Number(x)} /></span>);

/** A difference in words: what the code or the runs did that the operation does not say. */
function diffText(d: Diff): ReactNode {
  const names = (xs: string[]) => xs.map((x, i) => <span key={x}>{i ? ', ' : ''}<code>{x}</code></span>);
  switch (d.key) {
    case 'status-unlisted': return trx('Respondió {status} ({count}×) y el contrato no lo lista entre los errores de esta operación.', { status: <HttpStatus n={Number(d.status)} />, count: d.count });
    case 'code-status-unlisted': return trx('Su código responde {statuses} y el contrato no lo lista entre los errores de esta operación.', { statuses: statusList(d.statuses) });
    case 'success-differs': {
      const v = { status: statusList(d.status.split(', ')), declared: <HttpStatus n={Number(d.declared)} /> };
      return d.from === 'runs' ? trx('Los runs vieron {status} y su respuesta dice {declared}.', v) : trx('Su código responde {status} y su respuesta dice {declared}.', v);
    }
    case 'unnamed': {
      const v = { names: names(d.names) };
      if (d.side === 'query') return trx('Los runs mandaron en la consulta {names}, que el contrato no nombra.', v);
      if (d.side === 'request') return trx('Las peticiones de los runs traen {names}, que el contrato no nombra.', v);
      if (d.side === 'response') return trx('Las respuestas de los runs traen {names}, que el contrato no nombra.', v);
      return trx('Su código lee {names}, que el contrato no nombra.', v);
    }
    case 'mock': return trx('Un mock lo vio fuera de su contrato: {text}', { text: <code>{d.text}</code> });
  }
}
const Diffs = ({ list }: { list: Diff[] }) => <ul className="ep-diffs">{list.map((d, i) => <li key={i}><Warn><span>{diffText(d)}</span></Warn></li>)}</ul>;

/**
 * An endpoint opened: on one side its contract, each part as the operation says it (what it is for, what it takes, what
 * it answers, its errors) with what its code says under it; on the other, apart, what the runs saw of it and where that
 * strays from the contract. What is not known yet says what brings it. `write`: where its contract gets written.
 */
export function EndpointBody({ r, seen, diffs, write, reaches, to, shapes }: { r: ApiRow; seen: Loaded<Seen>; diffs: Diff[]; write: string; reaches?: Array<{ ep: MapNode; service?: MapNode; op?: Op }>; to?: string[]; shapes?: Record<string, Shape> }) {
  const s = r.ep ? seen.data?.endpoints[r.ep.id] : undefined;
  const op = r.op, a = r.ep?.attrs ?? {};
  const params = (a.params ?? []) as CodeParam[], returns = a.returns as string | undefined, statuses = (a.statuses ?? []) as number[];
  const errors = op ? errorsOf(op.contract, op) : [];
  const detail = op ? detailOf(op.contract, op) : '';
  const byCode = (d: Diff) => d.key === 'code-status-unlisted' || (d.key === 'success-differs' && d.from === 'code') || (d.key === 'unnamed' && d.side === 'code');
  const fill = op && <>{tr('Lo completa el agente al documentar el servicio, o tú:')}{' '}<a className="rowlink" href={href('docs', op.contract.id, 'edit')}>{tr('Editar «{title}»', { title: op.contract.title })}</a></>;
  // a body or an answer of a named type says its fields, when the code declares them
  const bodyType = params.find((x) => x.in === 'body')?.type;
  const takes = r.ep && (params.length ? <Code><CodeParams params={params} />{bodyType && <TypeFields type={bodyType} shapes={shapes} />}</Code> : a.handler ? <Code><span className="faint">{tr('no lee parámetros de la petición')}</span></Code> : null);
  const gives = r.ep && (returns || statuses.length) ? <Code>{returns ? trx('devuelve {returns}', { returns: <code>{returns}</code> }) : null}{returns && statuses.length ? ' · ' : ''}{statuses.length ? trx('responde {statuses}', { statuses: statusList(statuses) }) : null}{returns && <TypeFields type={returns} shapes={shapes} />}</Code> : null;
  return (
    <div className="ep-cols">
      <section className="ep-col" aria-label={tr('Contrato')}>
        <h5><Origin of="declared" label={false} />{tr('Contrato')}{op && <ContractChip op={op} />}</h5>
        {r.forward ? (
          <>
            <p className="ep-p">{tr('Solo reenvía: lo que recibe y responde es lo que dice el contrato de cada operación que alcanza.')}</p>
            {reaches?.length ? <div className="scroll-x"><table className="t reach-t">
              <thead><tr><th>{tr('Alcanza')}</th><th>{tr('Para qué')}</th><th>{tr('Contrato')}</th></tr></thead>
              <tbody>{reaches.map(({ ep, service, op: o }) => (
                <tr key={ep.id}>
                  <td className="two"><span className="mono"><Method m={String(ep.attrs?.method)} /> {String(ep.attrs?.path)}</span>{service && <span className="sub"><a className="rowlink" href={href('map', service.id, 't', 'endpoints')}>{service.name}</a></span>}</td>
                  <td className="wrap">{o?.summary ? <Inline text={o.summary} /> : <span className="faint">{tr('ningún contrato lo documenta')}</span>}{o?.request && <span className="faint reach-io"><b>{tr('Recibe:')}</b> <Inline text={o.request} /></span>}{o?.response && <span className="faint reach-io"><b>{tr('Responde:')}</b> <Inline text={o.response} /></span>}</td>
                  <td>{o ? <a className="chip ctr" href={href('docs', o.contract.id)}><Braces />{o.contract.title}</a> : <Drift>{tr('Sin contrato')}</Drift>}</td>
                </tr>
              ))}</tbody>
            </table></div> : <p className="ep-p faint">{to?.length && String(a.path).endsWith('/**')
              // a prefix that reaches nothing of its method: the gateway lets it through and nothing the code declares answers it
              ? tr('En el mapa, {services} no tiene ninguna operación {method} bajo {prefix}: lo que pase por aquí no lo atiende nada que su código declare.', { services: to.join(', '), method: r.method, prefix: String(a.path).slice(0, -2) })
              : tr('El mapa no ve a qué operaciones llega.')}</p>}
          </>
        ) : !op ? (
          <>
            {a.contract ? <p className="ep-p">{tr('Lo declara un fichero OpenAPI del código: lo que recibe y responde sale de él.')}</p>
              : <Missing how={<>{tr('Lo escribe el agente al documentar el servicio: una operación por endpoint, con su resumen, su petición y su respuesta.')}{' '}<a className="rowlink" href={write}>{tr('Escribir el contrato')}</a></>}>{tr('Ningún contrato documenta este endpoint.')}</Missing>}
            {typeof a.summary === 'string' && <Part label={tr('Para qué')}><Code><Inline text={a.summary} /></Code></Part>}
            {takes && <Part label={tr('Petición')}>{takes}</Part>}
            {gives && <Part label={tr('Respuesta')}>{gives}</Part>}
          </>
        ) : (
          <>
            <Part label={tr('Para qué')}>{op.summary ? <p className="ep-p"><Inline text={op.summary} /></p> : <Missing how={fill}>{tr('El contrato no dice para qué sirve.')}</Missing>}</Part>
            <Part label={tr('Petición')}>{op.request ? <p className="ep-p"><Inline text={op.request} /></p> : <Missing how={fill}>{tr('El contrato no dice qué recibe.')}</Missing>}{takes}</Part>
            <Part label={tr('Respuesta')}>{op.response ? <p className="ep-p"><Inline text={op.response} /></p> : <Missing how={fill}>{tr('El contrato no dice qué responde.')}</Missing>}{gives}</Part>
            <Part label={tr('Errores')}>{errors.length ? (
              <ul className="ep-errs">{errors.map((e) => <li key={e.status + e.when}>{statusOf(e.status)}<span><Inline text={e.when} /></span></li>)}</ul>
            ) : <p className="ep-p faint">{tr('El contrato no le asigna errores: cualquier 4xx o 5xx que respondan su código o los runs sale como diferencia.')}</p>}</Part>
            {!r.ep && <Drift>{tr('No está en el código')}</Drift>}
            {diffs.some(byCode) && <Diffs list={diffs.filter(byCode)} />}
            {detail && <details className="ep-detail"><summary>{tr('Lo que el contrato explica de esta operación')}</summary><div className="md-box"><Markdown text={detail} /></div></details>}
          </>
        )}
      </section>
      <section className="ep-col real" aria-label={tr('Datos reales')}>
        <h5><Origin of="observed" label={false} />{tr('Datos reales')}<span className="sub">{tr('lo que vieron los runs')}</span></h5>
        {seen.error ? <p className="ep-p err-ink">{tr('No se pudo leer lo que vieron los runs:')}{' '}{seen.error}</p>
          : !seen.data ? <Skeleton lines={2} />
          : !r.ep ? <Missing>{tr('El código no lo tiene: ningún run puede llamarlo hasta que exista.')}</Missing>
          : !s ? <Missing how={tr('Lo trae el primer run de un flujo que lo recorra, o una sesión de «Probar en vivo».')}>{tr('Ningún run lo ha llamado todavía.')}</Missing>
          : <>
            <p className="ep-p">{trx('{calls}, la última en el {run} · {flows}', { calls: plural(s.count, tr('llamada'), tr('llamadas')), run: <a className="rowlink" href={href('runs', s.run)}>run {s.run}</a>, flows: s.flows.join(', ') })}</p>
            <Part label={tr('Petición de ejemplo')}><Request method={r.method} path={r.path} sample={best(s)} /></Part>
            <Part label={tr('Respuestas vistas')}><Responses seen={s} /></Part>
            {op ? (diffs.some((d) => !byCode(d)) ? <Part label={tr('Diferencias con el contrato')}><Diffs list={diffs.filter((d) => !byCode(d))} /></Part> : <p className="ep-p"><Status state="ok">{tr('Lo que vieron los runs coincide con su contrato.')}</Status></p>)
              : diffs.length ? <Diffs list={diffs} /> : null}
          </>}
      </section>
    </div>
  );
}

/* -------------------------------- a contract -------------------------------- */

export const DIRECTION: Record<string, string> = { publishes: tr('Publica'), consumes: tr('Consume') };
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
      {seen.error && <div className="notice warn"><CircleAlert /><div>{tr('No se pudo leer lo que vieron los runs:')}{' '}{seen.error}{tr('. La referencia sale solo del contrato y del código.')}</div></div>}
      <section className="panel" aria-labelledby="ref-ops-h">
        <header>
          <h3 id="ref-ops-h">{tr('Operaciones')}</h3>
          <div className="meta">
            <span>{plural(ops.length, tr('operación'), tr('operaciones'))} · {plural(paths.length, tr('ruta'), tr('rutas'))}{missing ? ' · ' : ''}{missing ? <span className="run-ink">{missing}{' '}{tr('sin implementar')}</span> : null}</span>
            <AllButton o={o} keys={keys} />
          </div>
        </header>
        {!ops.length ? <div className="empty">{tr('Este contrato no declara operaciones HTTP.')}</div> : paths.map(([path, list]) => (
          <section key={path} className="api-path" aria-label={tr('Ruta {path}', { path })}>
            <h4 className="mono">{path}</h4>
            {list.map((x) => {
              const ep = endpointOfOp(g, x), s = ep ? seen.data?.endpoints[ep.id] : undefined, svc = g?.nodes.get(x.service);
              const facts: Array<[string, ReactNode]> = [
                [tr('Petición'), x.request ? <Inline text={x.request} /> : <Missing>{tr('El contrato no dice qué recibe.')}</Missing>],
                [tr('Respuesta'), x.response ? <Inline text={x.response} /> : <Missing>{tr('El contrato no dice qué responde.')}</Missing>],
                [tr('Servicio'), svc ? <a className="rowlink" href={href('map', svc.id)}>{svc.name}</a> : <span className="mono">{x.service || '—'}</span>],
                [tr('En el código'), !g ? <span className="faint">{tr('Sin mapa: pulsa «Releer el código» en Proyectos.')}</span> : ep ? <><Origin of="extracted" label={false} /> <span className="mono" title={ep.anchor ? `${ep.anchor.repo}:${ep.anchor.path}` : undefined}>{String(ep.attrs?.handler ?? ep.name)} {where(ep)}</span></> : <Drift>{tr('Ningún endpoint de')}{' '}{svc?.name ?? x.service}{' '}{tr('responde')}{' '}{opKey(x)}</Drift>],
                [tr('Visto en los runs'), s ? <>{plural(s.count, tr('llamada'), tr('llamadas'))}{tr(', la última en el')}{' '}<a className="rowlink" href={href('runs', s.run)}>run {s.run}</a> · {s.flows.join(', ')}</> : <span className="faint">{seen.data ? tr('Ningún flujo la ha llamado en su último run.') : seen.error ? '—' : tr('Leyendo…')}</span>],
                ...(s?.drift.length ? [[tr('El mock vio'), <ul className="plain">{s.drift.map((d) => <li key={d} className="mono">{d}</li>)}</ul>] as [string, ReactNode]] : []),
              ];
              return <Operation key={opKey(x)} id={`op-${slug(opKey(x))}`} method={x.method} path={x.path} summary={x.summary} seen={s} errors={errorsOf(p, x)} facts={facts}
                chips={g && !ep ? <Drift>{tr('No está en el código')}</Drift> : null} open={o.has(opKey(x))} onToggle={() => o.toggle(opKey(x))} grouped />;
            })}
          </section>
        ))}
      </section>
      {evs.length > 0 && <Events evs={evs} g={g} seen={seen.data} />}
      <section className="panel" aria-labelledby="ref-err-h">
        <header><h3 id="ref-err-h">{tr('Errores')}</h3><div className="meta">{tr('Los que debe tratar quien llama')}</div></header>
        {!errors.length && !off.length ? <div className="empty">{tr('El contrato no declara errores: cualquier 4xx o 5xx que vean los runs saldrá como diferencia.')}</div> : (
          <ul className="resps errs">
            {errors.map((e) => {
              const n = stats.filter(([st]) => listed(st, [e])).reduce((a, [, c]) => a + c, 0);
              return <li key={e.status}><div className="resp-h">{statusOf(e.status)}<span className="resp-when"><Inline text={e.when} /></span><span className="resp-marks"><Origin of="declared" />{n ? <span className="faint num"><Origin of="observed" label={false} />{plural(n, tr('vez'), tr('veces'))}</span> : <span className="faint">{tr('no visto en los runs')}</span>}</span></div></li>;
            })}
            {off.map(([st, list]) => (
              <li key={st}><div className="resp-h">{statusOf(st)}<span className="resp-when">{tr('Lo respondió')}{' '}{list.map((x, i) => <span key={x}>{i ? ', ' : ''}<span className="mono">{x}</span></span>)}</span><span className="resp-marks"><span className="faint num"><Origin of="observed" label={false} />{plural(stats.filter(([s]) => s === st).reduce((a, [, c]) => a + c, 0), tr('vez'), tr('veces'))}</span><Drift>{tr('No está en el contrato')}</Drift></span></div></li>
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
      <header><h3 id="ref-ev-h">{tr('Eventos')}</h3><div className="meta">{plural(evs.length, tr('evento'), tr('eventos'))}</div></header>
      <ul className="evs">{evs.map((e, i) => <EventRow key={i} e={e} g={g} seen={seen} />)}</ul>
    </section>
  );
}

/**
 * An event: who publishes or consumes it, its payload, whether the code does it, and a real message. On a service's
 * sheet (`self`) it names its contract instead of the service; one the code does and no contract declares is `unlisted`.
 * `apart`: what the runs saw goes in a block of its own, and what the contract does not say says what brings it.
 */
/** A data class of a service's code, by name (/api/service-shapes): what a message or a body carries, field by field. */
export interface Shape { fields: Array<{ name: string; type: string }>; file: string; line: number }
/** What a fact's note says its code sends or takes on a topic: `payload FileEvent, key String, group g`. */
const noteSays = (note?: string) => {
  const parts = noteParts(note ?? ''), says = (k: string) => parts.find((p) => p.startsWith(`${k} `))?.slice(k.length + 1);
  return { payload: says('payload'), key: says('key'), group: says('group') };
};
/** A type's fields, when its code declares them; a type with none Laru reads says how it is read. */
export function TypeFields({ type, shapes }: { type: string; shapes?: Record<string, Shape> }) {
  const sh = shapes?.[type.replace(/^.*\./, '').replace(/<.*$/, '')] ?? shapes?.[type.match(/<\s*(?:[\w.]+\s*,\s*)?([\w.]+)\s*>$/)?.[1] ?? ''];
  if (sh) return <ul className="plain type-fields">{sh.fields.map((f) => <li key={f.name}><span className="mono">{f.name}</span><span className="mono faint">{f.type}</span></li>)}</ul>;
  if (/^(?:Map|HashMap|JsonNode|Object|String|byte\[\])\b/.test(type)) return <p className="ep-p faint">{tr('Su código lo lee sin un tipo propio: lo que trae solo lo dice el contrato.')}</p>;
  return null;
}

/**
 * A topic a service publishes or consumes. In a contract's page, one line (the topic, who, what it carries). Apart, on a
 * service's sheet, its contract the way an endpoint's is: what it is for, what it carries and its key, with what the code
 * sends or takes under each (the message's type and fields, its key, the consumer's group), who else publishes or
 * consumes it, and, beside it, what the runs saw.
 */
export function EventRow({ e, g, seen, self, unlisted: off, apart, shapes }: { e: Omit<Ev, 'contract'> & { contract?: DocPiece }; g: Indexed | null; seen?: Seen; self?: boolean; unlisted?: boolean; apart?: boolean; shapes?: Record<string, Shape> }) {
  const svc = g?.nodes.get(e.service);
  const fact = g?.out(e.service).find((f) => f.p === e.direction && f.o === `topic:${e.topic}`);
  const inCode = Boolean(fact);
  const t = seen?.topics[e.topic];
  const saw = t && (e.direction === 'publishes' ? t.publishers : t.consumers).includes(svc?.name ?? e.service.replace(/^svc:/, ''));
  const real = t && (saw ? (e.direction === 'publishes' ? tr('{n}, el último en el run {run}', { n: plural(t.count, tr('mensaje'), tr('mensajes')), run: t.run }) : tr('lo consumió en el run {run}', { run: t.run })) : tr('los runs vieron el tema, pero no a este servicio en él'));
  const sample = t?.sample?.req?.text && e.direction === 'publishes' && saw && (
    <details className="resp-ex"><summary>{tr('Mensaje real del run')}{' '}{t.sample!.run}</summary><CodeBlock text={t.sample!.req!.text!} lang={langOf(t.sample!.req!.text!)} format label={tr('Mensaje de {topic}', { topic: e.topic })} /></details>
  );
  const head = (
    <div className="ev-h">
      {!apart && <span className={`dir ${e.direction}`}>{DIRECTION[e.direction] ?? e.direction}</span>}
      <a className="mono rowlink k-kafka-ink" href={href('map', `topic:${e.topic}`)}>{e.topic}</a>
      {!self && <span className="faint">{svc ? <a className="rowlink" href={href('map', svc.id)}>{svc.name}</a> : e.service}</span>}
      <span className="op-tags">
        {self && e.contract && <a className="chip ctr" href={href('docs', e.contract.id)}><Braces />{e.contract.title}</a>}
        {off && <Drift>{tr('Sin contrato')}</Drift>}
        {g && e.contract && !inCode && <Drift>{tr('No está en el código')}</Drift>}
        {t && !apart && <span className="faint num" title={tr('Visto en el run {run}', { run: t.run })}><Origin of="observed" label={false} />{saw ? (e.direction === 'publishes' ? plural(t.count, tr('mensaje'), tr('mensajes')) : tr('consumido en los runs')) : tr('no visto en este servicio')}</span>}
      </span>
    </div>
  );
  if (!apart) return <li>{head}{e.payload && <p className="ev-payload"><span className="faint">{tr('Contenido:')}</span> <Inline text={e.payload} /></p>}{sample}</li>;

  const code = noteSays(fact?.note);
  const fill = e.contract ? <>{tr('Lo completa el agente al documentar el servicio, o tú:')}{' '}<a className="rowlink" href={href('docs', e.contract.id, 'edit')}>{tr('Editar «{title}»', { title: e.contract.title })}</a></> : tr('Lo escribe el agente al documentar el servicio: en «Eventos» de un contrato, una fila por tema.');
  const where = fact?.anchor ? `${fact.anchor.path.split('/').pop()}${fact.anchor.line ? `:${fact.anchor.line}` : ''}` : '';
  // the other end: who else publishes it when this one consumes, who consumes it when this one publishes, each with how
  const others = g ? g.in(`topic:${e.topic}`).filter((f) => f.p === (e.direction === 'publishes' ? 'consumes' : 'publishes') && f.s !== e.service) : [];
  return (
    <li className="ev-card">
      {head}
      <div className="ep-cols">
        <section className="ep-col" aria-label={tr('Contrato')}>
          <h5><Origin of="declared" label={false} />{tr('Contrato')}</h5>
          {!e.contract && <Missing how={fill}>{tr('Ningún contrato declara este evento.')}</Missing>}
          {e.contract && <Part label={tr('Para qué')}>{e.summary ? <p className="ep-p"><Inline text={e.summary} /></p> : <Missing how={fill}>{tr('El contrato no dice para qué es.')}</Missing>}</Part>}
          {(e.contract || code.payload) && <Part label={tr('Contenido')}>
            {e.payload ? <p className="ep-p"><Inline text={e.payload} /></p> : e.contract ? <Missing how={fill}>{tr('El contrato no dice qué lleva.')}</Missing> : null}
            {code.payload && <Code>{e.direction === 'publishes' ? trx('envía {type}', { type: <code>{code.payload}</code> }) : trx('recibe {type}', { type: <code>{code.payload}</code> })}{where && <span className="faint"> · {where}</span>}<TypeFields type={code.payload} shapes={shapes} /></Code>}
          </Part>}
          <Part label={tr('Clave')}>
            {e.key ? <p className="ep-p"><Inline text={e.key} /></p> : !code.key && <p className="ep-p faint">{tr('Ni el contrato ni el código dicen por qué clave va: sin ella, los mensajes no guardan orden entre sí.')}</p>}
            {code.key && <Code>{trx('clave de tipo {type}', { type: <code>{code.key}</code> })}</Code>}
          </Part>
          {(code.group || e.direction === 'consumes') && <Part label={tr('Grupo')}>{code.group ? <Code><code>{code.group}</code>{' '}<span className="faint">{tr('cada grupo recibe cada mensaje una vez')}</span></Code> : <p className="ep-p faint">{tr('Su código no dice en qué grupo consume.')}</p>}</Part>}
          <Part label={e.direction === 'publishes' ? tr('Lo consumen') : tr('Lo publica')}>{others.length ? <ul className="plain ev-others">{others.map((f) => { const o = noteSays(f.note), n = g!.nodes.get(f.s); return <li key={f.s}><a className="rowlink" href={href('map', f.s, 't', 'events')}>{n?.name ?? f.s}</a>{o.payload && <span className="mono faint">{o.payload}</span>}{o.group && <span className="faint">{tr('grupo {g}', { g: o.group })}</span>}</li>; })}</ul> : <p className="ep-p faint">{e.direction === 'publishes' ? tr('Nadie en el mapa lo consume.') : tr('Nadie en el mapa lo publica.')}</p>}</Part>
        </section>
        <section className="ep-col real" aria-label={tr('Datos reales')}>
          <h5><Origin of="observed" label={false} />{tr('Datos reales')}<span className="sub">{tr('lo que vieron los runs')}</span></h5>
          {real ? <p className="ep-p">{real}</p> : <Missing how={tr('Lo trae el primer run de un flujo que lo provoque.')}>{tr('Ningún run lo ha visto todavía.')}</Missing>}
          {sample}
        </section>
      </div>
    </li>
  );
}

/* ------------------------------- a data model ------------------------------- */

const VERB: Record<string, string> = { 'maps-table': tr('la mapea'), 'defines-table': tr('la define'), reads: tr('la lee'), writes: tr('la escribe') };
/** «la mapea, la lee y la escribe» */
const and = (xs: string[]) => (xs.length < 2 ? xs.join('') : tr('{join} y {at}', { join: xs.slice(0, -1).join(', '), at: xs.at(-1) }));

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
        <header><h3 id="dm-ent-h">{tr('Entidades')}</h3><div className="meta">{plural(ents.length, tr('entidad'), tr('entidades'))}{missing ? <span className="run-ink">{missing}{' '}{tr('sin tabla en el código')}</span> : null}</div></header>
        {!ents.length ? <div className="empty">{tr('Este modelo no declara entidades.')}</div> : <div className="ents">{ents.map((e) => <EntityRow key={e.entity + (e.table ?? '')} e={e} g={g} />)}</div>}
      </section>
      {ents.some((e) => e.table) && <DiagramViewer id={`er:${p.id}`} height={360} />}
      <section className="panel" aria-labelledby="dm-rules-h">
        <header><h3 id="dm-rules-h">{tr('Reglas')}</h3><div className="meta">{plural(rules.length, tr('regla'), tr('reglas'))}</div></header>
        {rules.length ? <ul className="rules">{rules.map((r, i) => <li key={i}><Markdown text={r} /></li>)}</ul> : <div className="empty">{tr('Sin reglas escritas sobre estos datos.')}</div>}
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
  // what the code says of the table, and apart what the runs saw done to it
  const said = (fs: Fact[]) => [...Map.groupBy(fs, (f) => f.s)].map(([s, xs]) => {
    const n = g!.nodes.get(s)?.name ?? s.replace(/^\w+:/, '');
    const seen = xs.find((f) => f.seen)?.seen;
    return <span key={s}>{n} {and([...new Set(xs.map((f) => VERB[f.p]))])}{seen ? <span className="faint">{' '}{tr('(run')}{' '}{seen.run})</span> : null}</span>;
  });
  const code = said(facts.filter((f) => f.p === 'maps-table' || f.p === 'defines-table')), real = said(facts.filter((f) => f.p === 'reads' || f.p === 'writes'));
  const others = facts.filter((f) => f.p === 'writes' && e.owner && f.s !== e.owner).map((f) => g!.nodes.get(f.s)?.name ?? f.s);
  return (
    <div className="ent">
      <div className="ent-h">
        <Table /><b>{e.entity ?? e.table}</b>
        {e.entity && (e.table ? (g?.nodes.has(id) ? <a className="mono rowlink k-sql-ink" href={href('map', id)}>{e.table}</a> : <span className="mono">{e.table}</span>) : <span className="faint">{tr('sin tabla')}</span>)}
        <span className="op-tags">
          {self && e.model && <a className="chip ctr" href={href('docs', e.model.id)}><Table />{e.model.title}</a>}
          {!e.model && <Drift>{tr('Ningún modelo de datos la describe')}</Drift>}
          {g && e.table && !g.nodes.has(id) && <Drift>{tr('No está en el código')}</Drift>}
          {others.length > 0 && <Drift title={tr('Su dueño es {p0}', { p0: owner?.name ?? e.owner })}>{tr('También la escribe')}{' '}{[...new Set(others)].join(', ')}</Drift>}
        </span>
      </div>
      <dl className="op-facts">
        {e.model && <div><dt>{tr('Dueño')}</dt><dd>{owner ? <a className="rowlink" href={href('map', owner.id)}>{owner.name}</a> : e.owner ? <span className="mono">{e.owner}</span> : <span className="faint">—</span>}{self && e.owner && e.owner !== self ? <span className="faint">{' '}{tr('(no es este servicio)')}</span> : null}</dd></div>}
        {e.notes && <div><dt>{tr('Notas')}</dt><dd><Inline text={e.notes} /></dd></div>}
        {g && id && <div><dt>{tr('En el código')}</dt><dd className="said">{code.length ? code : <span className="faint">{tr('Ningún código la mapea ni la crea.')}</span>}</dd></div>}
        {g && id && <div><dt><Origin of="observed" label={false} />{tr('Datos reales')}</dt><dd className="said">{real.length ? real : <span className="faint">{tr('Ningún run la ha leído ni escrito todavía.')}</span>}</dd></div>}
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
      <header><h3 id="design-h">{tr('Contratos y modelos de datos')}</h3><div className="meta">{plural(list.length, tr('pieza'), tr('piezas'))}{' '}{tr('de diseño')}</div></header>
      <ul>{list.map((x) => {
        const home = x.parent !== p.id ? byId.get(x.parent ?? '') : undefined;
        let stats: string, drift = 0, off = 0;
        if (x.type === 'contract') {
          const ops = opsOf([x]), evs = eventsOf([x]), errs = errorsOf(x);
          stats = [plural(ops.length, tr('operación'), tr('operaciones')), evs.length && plural(evs.length, tr('evento'), tr('eventos')), errs.length && plural(errs.length, tr('error'), tr('errores'))].filter(Boolean).join(' · ');
          if (g) for (const op of ops) { const ep = endpointOfOp(g, op); if (!ep) drift++; else if (unlisted(seen?.endpoints[ep.id]?.statuses, errs).length) off++; }
        } else {
          const ents = entitiesOf([x]);
          stats = [plural(ents.length, tr('entidad'), tr('entidades')), ((x.fields.rules ?? []) as string[]).length && plural(((x.fields.rules ?? []) as string[]).length, tr('regla'), tr('reglas'))].filter(Boolean).join(' · ');
          if (g) drift = ents.filter((e) => e.table && !g.nodes.has(`tbl:${e.table}`)).length;
        }
        const Icon = x.type === 'contract' ? Braces : Table;
        return (
          <li key={x.id}>
            <Icon />
            <div className="design-main"><a className="rowlink ttl" href={href('docs', x.id)}>{x.title}</a> <code className="faint">{x.id}</code><div className="faint">{stats}{home ? tr(' · en {title}', { title: home.title }) : ''}</div></div>
            <span className="op-tags">
              <Status state={['implemented', 'active'].includes(x.status) ? 'ok' : x.status === 'deprecated' ? 'idle' : 'queue'}>{STATUS[x.status] ?? x.status}</Status>
              {drift > 0 && <Drift>{x.type === 'contract' ? tr('{drift} sin implementar', { drift }) : tr('{drift} sin tabla', { drift })}</Drift>}
              {off > 0 && <Drift>{plural(off, tr('operación responde'), tr('operaciones responden'))}{' '}{tr('fuera de contrato')}</Drift>}
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
        <p>{via ? <>{tr('La llamada sigue hasta')}{' '}<b>{e.to}</b>{tr(', que ejerce')}{' '}</> : tr('Ejerce ')}<a className="rowlink" href={opHref(op)}><Method m={op.method} /><span className="mono">{op.path}</span></a>{' '}{tr('de')}{' '}<a className="rowlink" href={href('docs', op.contract.id)}>«{op.contract.title}»</a>.</p>
        {s === undefined ? <p className="faint">{e.error ? tr('No llegó respuesta: no se puede contrastar.') : tr('Sin estado que contrastar.')}</p>
          : fine ? <Status state="ok"><span><HttpStatus n={s} /> {s < 400 ? tr('Respuesta correcta.') : tr('Error previsto en el contrato{p0}', { p0: when ? `: ${when}` : '.' })}</span></Status>
          : <Warn><span><HttpStatus n={s} />{' '}{tr('no está entre los errores de «')}{op.contract.title}».</span></Warn>}
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
      else if (ops.some((o) => o.service === `svc:${ex.to}`)) lines.push(<div key="op"><Warn><span>{tr('Ningún contrato de')}{' '}{ex.to}{' '}{tr('declara')}{' '}<Method m={ex.method} /><span className="mono">{ex.path}</span>.</span></Warn></div>);
    }
  }
  if (ex.kind === 'kafka' && ex.topic) {
    const evs = eventsOf(k.pieces).filter((e) => e.topic === ex.topic);
    const consume = types.get(ex.from) === 'datastore';
    const who = consume ? ex.to : ex.from, dir = consume ? 'consumes' : 'publishes';
    const ev = evs.find((e) => e.direction === dir && e.service === `svc:${who}`);
    if (ev) lines.push(<div key="ev"><p>{tr('Evento')}{' '}<span className="mono">{ex.topic}</span>{' '}{tr('de')}{' '}<a className="rowlink" href={href('docs', ev.contract.id)}>«{ev.contract.title}»</a>{ev.payload ? <>: <span className="faint">{ev.payload}</span></> : '.'}</p><Status state="ok">{who}{' '}{tr('lo')}{' '}{consume ? tr('consume') : tr('publica')}{tr(', como dice el contrato.')}</Status></div>);
    else if (evs.length) lines.push(<div key="ev"><Warn><span>{tr('Ningún contrato dice que')}{' '}{who} {consume ? tr('consuma') : tr('publique')} <span className="mono">{ex.topic}</span>; «{evs[0].contract.title}{tr('» lo declara para otros.')}</span></Warn></div>);
  }
  if (ex.kind === 'sql' && ex.table) {
    const e = entitiesOf(k.pieces).find((x) => x.table === ex.table);
    if (e) {
      const owner = e.owner?.replace(/^svc:/, '');
      const writes = WRITE.test(ex.label);
      lines.push(<div key="tbl"><p>{tr('Tabla')}{' '}<span className="mono">{ex.table}</span>{tr(': entidad «')}{e.entity}{tr('» de')}{' '}<a className="rowlink" href={href('docs', e.model.id)}>«{e.model.title}»</a>{owner ? tr(', cuyo dueño es {owner}', { owner }) : ''}.</p>
        {writes && owner && owner !== ex.from ? <Warn>{ex.from}{' '}{tr('la escribe sin ser su dueño.')}</Warn> : null}</div>);
    }
  }
  for (const d of ex.drift ?? []) lines.push(<div key={d}><Warn><span>{tr('El mock vio que se sale de su contrato:')}{' '}<span className="mono">{d}</span></span></Warn></div>);
  if (!lines.length) return null;
  return <div className="ex-contract" aria-label={tr('Contrato')}><Braces />{<div className="ex-lines">{lines}</div>}</div>;
}
