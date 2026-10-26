/**
 * «Recorrido»: Cadena, Secuencia and the result in one list. Each request is a row in the order it happened, under
 * the act that set it off, with its way drawn across the pieces (a sequence in miniature) and what it carried and got
 * back in a line. The row picked opens in place: the payload and the response first, the SQL rows, the headers folded.
 * The studio of a run and the live studio both show it.
 */
import { ArrowDownLeft, ArrowUpRight, Zap } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import type { Act } from '@laru/trace/chain';
import type { Exchange, Trace } from '../api.ts';
import { CodeBlock, HttpStatus } from '../components/ui.tsx';
import { plural, secs } from '../lib/es.ts';
import { brief, say, type SayCtx } from '../lib/say.ts';
import { ends, route } from '../lib/seq.ts';
import { langOf } from '../lib/syntax.ts';

const header = (h: Record<string, string> | undefined, name: string) => Object.entries(h ?? {}).find(([k]) => k.toLowerCase() === name)?.[1];
const WHAT: Partial<Record<Exchange['kind'], string>> = { sql: 'Sentencia', kafka: 'Mensaje', sse: 'Flujo' };
/** «620 bytes sin capturar»: a side that carried bytes the capture did not keep (a TCP exchange, a body past the cut) */
const uncaught = (b: Exchange['req']) => (b && !b.text && !b.note && b.bytes ? `${b.bytes} bytes sin capturar` : '');

/** A body: SQL, JSON (by its type or its look) formatted, anything else as text. Masks stay marked in all of them. */
export function Body({ text, headers, kind, label }: { text: string; headers?: Record<string, string>; kind: Exchange['kind']; label: string }) {
  return <CodeBlock text={text} lang={kind === 'sql' ? 'sql' : langOf(text, header(headers, 'content-type'))} format label={label} />;
}

/** What a statement returned: its tag, its columns and the first rows (masked as a body is), and how many more there were. */
export function ResultTable({ r }: { r: NonNullable<Exchange['result']> }) {
  const n = r.rows.length + r.more;
  return (
    <div className="pg-result">
      <p className="pg-tag"><span className="mono">{r.tag ?? 'Hecho'}</span>{r.cols.length ? <span className="faint">{n === 0 ? 'ninguna fila' : n === 1 ? '1 fila' : `${n} filas`}{r.more ? `, se muestran ${r.rows.length}` : ''}</span> : null}</p>
      {r.cols.length > 0 && r.rows.length > 0 && (
        <div className="scroll-x"><table className="t pg-rows">
          <thead><tr>{r.cols.map((c, i) => <th key={i} className="mono">{c}</th>)}</tr></thead>
          <tbody>{r.rows.map((row, i) => <tr key={i}>{row.map((v, j) => <td key={j} className={`mono${v === 'NULL' ? ' faint' : ''}`} title={v}>{v}</td>)}</tr>)}</tbody>
        </table></div>
      )}
    </div>
  );
}

/** Headers as a table to read, not a block to decode: the name dim, the value in full (masks stay marked as the body has them). */
export function Headers({ h, first }: { h?: Record<string, string>; first?: string }) {
  const rows = Object.entries(h ?? {});
  if (!rows.length && !first) return null;
  return (
    <dl className="hdrs">
      {first && <><dt className="hdrs-first">{first}</dt><dd /></>}
      {rows.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd className="mono">{v}</dd></Fragment>)}
    </dl>
  );
}

/** The headers under the body, folded: they are there when wanted, not in the way of what was said. */
function Folded({ h }: { h?: Record<string, string> }) {
  const n = Object.keys(h ?? {}).length;
  if (!n) return null;
  return <details className="hdrs-fold"><summary>Cabeceras <span className="num faint">{n}</span></summary><Headers h={h} /></details>;
}

const note = (text: string) => <pre className="json"><span className="faint">{text}</span></pre>;

/**
 * What a hop carried and what came back: the request's payload and the response's body (a statement and its rows),
 * the headers folded under each. `reply` dims the side the cursor is not on.
 */
export function ExchangeIO({ ex, names, reply }: { ex: Exchange; names: Map<string, string>; reply?: boolean }) {
  const sql = ex.kind === 'sql';
  const [stmt, params] = sql ? (ex.req?.text ?? ex.label).split('\n-- ') : [];
  const who = (id: string) => names.get(id) ?? id;
  return (
    <div className="inspector insp-io">
      <div className={reply === true ? 'dim' : undefined}>
        <h4><ArrowUpRight />{sql ? 'Consulta' : WHAT[ex.kind] ?? 'Petición'}<span className="grow" /><span className="mono faint">{who(ends(ex)[0])}</span></h4>
        {sql ? <>
          <CodeBlock text={stmt} lang="sql" format label="La sentencia" />
          {params && <Headers h={Object.fromEntries([...params.matchAll(/(\$\d+) = ('(?:[^']|'')*'|NULL|[^,]+)/g)].map((m) => [m[1], m[2]]))} />}
        </> : <>
          {ex.req?.text ? <Body text={ex.req.text} headers={ex.reqHeaders} kind={ex.kind} label="Cuerpo de la petición" /> : note(ex.req?.note || uncaught(ex.req) || 'Sin cuerpo.')}
          <Folded h={ex.reqHeaders} />
        </>}
      </div>
      <div className={reply === false ? 'dim' : undefined}>
        <h4><ArrowDownLeft />{sql ? 'Resultado' : 'Respuesta'}<span className="grow" /><span className="mono faint">{who(ends(ex)[1])}</span></h4>
        {sql ? (ex.error ? <CodeBlock className="json err-ink" text={ex.error} lang="log" label="Lo que respondió Postgres" />
          : ex.result ? <ResultTable r={ex.result} />
          : <p className="empty insp-note">{ex.ok ? 'Se ejecutó sin error.' : 'Postgres la rechazó.'} Esta traza no trae las filas: es de antes de que el tap leyera Postgres, o la conexión iba cifrada.</p>)
          : ex.error ? <CodeBlock className="json err-ink" text={ex.error} lang="log" label="Error" /> : ex.res || ex.resHeaders ? <>
            {ex.res?.text ? <Body text={ex.res.text} headers={ex.resHeaders} kind={ex.kind} label="Cuerpo de la respuesta" /> : note(ex.res?.note || uncaught(ex.res) || 'Sin cuerpo.')}
            <Folded h={ex.resHeaders} />
          </> : <p className="empty insp-note">{ex.kind === 'kafka' ? 'Kafka no responde: quien consume lo hace por su cuenta.' : ex.t1 === undefined ? 'No llegó respuesta en la ventana de la prueba.' : 'Sin cuerpo.'}</p>}
      </div>
    </div>
  );
}

/**
 * The way the message travels, drawn as it plays: every piece from the first sender to the last that served it,
 * the hop open now lit, a packet that goes there and, when it answered, comes back. Replayed on every message.
 */
export function RouteStrip({ way, at, reply, names }: { way: Exchange[]; at: number; reply: boolean; names: Map<string, string> }) {
  if (!way.length) return null;
  const name = (id: string) => names.get(id) ?? id;
  const stops = [ends(way[0])[0], ...way.map((e) => ends(e)[1])];
  const answered = way[at]?.t1 !== undefined;
  return (
    <div className={`route-strip k-${way[at]?.kind ?? 'http'}`} aria-hidden="true" key={`${way[at]?.id}${reply ? 'r' : ''}`}>
      {stops.map((p, i) => (
        <Fragment key={i}>
          {i > 0 && <span className={`rs-wire${i - 1 < at ? ' past' : i - 1 === at ? ' now' : ''}${i - 1 === at && way[at].ok === false ? ' bad' : ''}`}>
            {i - 1 === at && <i className={`rs-packet${reply ? ' back' : ''}${answered && !reply ? ' round' : ''}`} />}
          </span>}
          <span className={`rs-node${i === at || i === at + 1 ? ' on' : ''}`}>{name(p)}</span>
        </Fragment>
      ))}
    </div>
  );
}

// ---------- the list ----------

/** A request as a row: its first hop and the forwards it went through (front → gateway → service), and how deep it sits. */
interface Item { e: Exchange; via: Exchange[]; d: number }
interface Group { key: string; act?: Act; band?: Trace['steps'][number]; title: string; items: Item[]; hidden: number }

/** A body in a line: what it said, without its spaces. */
const line = (t?: string) => (t ? t.replace(/\s+/g, ' ').trim().slice(0, 200) : '');
function peek(e: Exchange): { up: string; down: string } {
  if (e.kind === 'sql') {
    const n = e.result ? e.result.rows.length + e.result.more : undefined;
    return { up: '', down: e.error ? line(e.error) : e.result ? `${e.result.tag ?? 'Hecho'}${e.result.cols.length ? ` · ${n === 1 ? '1 fila' : `${n} filas`}` : ''}${e.result.rows[0] ? ` · ${e.result.rows[0].join(', ')}` : ''}` : '' };
  }
  return { up: line(e.req?.text), down: line(e.error ?? e.res?.text) };
}

export function Journey({ trace, ctx, lanes, sel, onPick, hot, time, follow }: {
  trace: Trace; ctx: SayCtx; lanes: Array<{ id: string; name: string }>;
  /** the exchange picked: its row is open */
  sel?: string; onPick: (id: string) => void;
  /** the exchanges happening now, lit */
  hot?: Set<string>;
  time: (t: number) => string;
  /** live: the list keeps its end in view as hops arrive, unless the person scrolled up to read */
  follow?: boolean;
}) {
  const ch = ctx.chain;
  const names = useMemo(() => new Map(lanes.map((l) => [l.id, l.name])), [lanes]);
  const groups = useMemo(() => {
    const ex = new Map(trace.exchanges.map((e) => [e.id, e]));
    const forwards = (id: string) => (ch.effects.get(id) ?? []).filter((k) => ch.cause.get(k)?.how === 'forward');
    // a forward that is its parent's only one is part of that parent's row
    const tail = (id: string) => { const c = ch.cause.get(id); return c?.how === 'forward' && forwards(c.parent).length === 1; };
    const through = (id: string) => { const xs = [id]; for (let f = forwards(id); f.length === 1 && xs.length < 20; f = forwards(xs.at(-1)!)) xs.push(f[0]); return xs; };
    const depth = (id: string) => { let d = 0; for (let p = ch.cause.get(id)?.parent, i = 0; p && i < 200; p = ch.cause.get(p)?.parent, i++) if (!tail(p)) d++; return d; };
    const by = new Map<string, Item[]>(), hidden = new Map<string, number>();
    for (const e of trace.exchanges) {
      const a = ch.actOf.get(e.id) ?? '';
      if (ch.noise.has(e.id)) { hidden.set(a, (hidden.get(a) ?? 0) + 1); continue; }
      if (tail(e.id)) continue;
      (by.get(a) ?? by.set(a, []).get(a)!).push({ e, via: through(e.id).map((id) => ex.get(id)!).filter(Boolean), d: depth(e.id) });
    }
    // what set it off before what it set off, then by time
    for (const l of by.values()) l.sort((x, y) => x.e.t0 - y.e.t0 || x.d - y.d);
    const out: Group[] = [];
    let step: number | undefined;
    for (const a of ch.acts) {
      const items = by.get(a.id) ?? [];
      if (!items.length && !a.marks.length) continue;
      const band = a.step !== undefined && a.step !== step ? trace.steps.find((s) => s.n === a.step) : undefined;
      step = a.step ?? step;
      out.push({ key: a.id, act: a, band, title: say({ kind: 'act', act: a }, ctx), items, hidden: hidden.get(a.id) ?? 0 });
    }
    if (by.get('')?.length) out.push({ key: '', title: 'Sin causa visible: nadie de los que se ven lo pidió', items: by.get('')!, hidden: hidden.get('') ?? 0 });
    return out;
  }, [trace, ctx, ch]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const open = flat.find((it) => it.via.some((v) => v.id === sel));

  const box = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  useEffect(() => { if (follow && atEnd.current && box.current) box.current.scrollTop = box.current.scrollHeight; }, [follow, flat.length]);
  // the row picked, or the last one happening now, in view
  const lit = flat.findLast((it) => it.via.some((v) => hot?.has(v.id)))?.e.id;
  useEffect(() => { box.current?.querySelector('.jr-row.sel')?.scrollIntoView({ block: 'nearest' }); }, [open?.e.id]);
  // live keeps the end in view itself, and only while the person is there: a row lit must not pull them away from what they read
  useEffect(() => { if (lit && !open && !follow) box.current?.querySelector(`[data-ex="${CSS.escape(lit)}"]`)?.scrollIntoView({ block: 'nearest' }); }, [lit]);

  const LW = Math.max(14, Math.min(26, Math.floor(240 / Math.max(1, lanes.length))));
  const W = lanes.length * LW;
  const lane = new Map(lanes.map((l, i) => [l.id, i * LW + LW / 2]));

  // ↑ ↓ move from row to row, and the video with them
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' || e.metaKey || e.ctrlKey || e.altKey || !flat.length) return;
    e.preventDefault();
    const i = open ? flat.indexOf(open) : -1;
    const to = flat[Math.max(0, Math.min(flat.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    onPick(to.e.id);
    requestAnimationFrame(() => box.current?.querySelector<HTMLElement>('.jr-row.sel .jr-hit')?.focus({ preventScroll: true }));
  };

  if (!groups.length) return <div className="journey"><p className="empty">Todavía no ha pasado nada: cada acción aparece aquí con todo lo que provoca, de pieza en pieza.</p></div>;
  return (
    <div className="journey" ref={box} onKeyDown={keys} onScroll={(e) => { const b = e.currentTarget; atEnd.current = b.scrollHeight - b.scrollTop - b.clientHeight < 40; }}
      role="group" aria-label={`Recorrido: ${plural(flat.length, 'petición', 'peticiones')} en orden, cada una con lo que llevó y lo que recibió. Las flechas arriba y abajo pasan de una a otra.`}>
      <div className="jr-lanes" aria-hidden="true">
        <div className="jr-names" style={{ width: W }}>{lanes.map((l) => <span key={l.id} style={{ width: LW }} title={l.name}>{l.name}</span>)}</div>
      </div>
      {groups.map((g) => (
        <section key={g.key} className="jr-act">
          {g.band && <div className="jr-band"><b>{g.band.n}. {g.band.title}</b>{g.band.status === 'failed' && <span className="chip err">falló</span>}<span className="faint num">{time(g.band.t0)}</span></div>}
          <h4 className="jr-act-h"><span>{g.title}</span>{g.hidden > 0 && <span className="faint" title="Recursos, avisos y saludos plegados">+{g.hidden}</span>}{g.act && <span className="faint num">{time(g.act.t0)}</span>}</h4>
          <ul>
            {g.items.map((it) => {
              const { e, via } = it;
              const last = via.at(-1)!;
              const isOpen = open === it;
              const shown = via.find((v) => v.id === sel) ?? e;
              const ok = via.every((v) => v.ok !== false);
              const status = [...via].reverse().find((v) => v.status !== undefined)?.status ?? e.status;
              const ms = e.t1 !== undefined ? e.t1 - e.t0 : undefined;
              const b = brief(e, ctx);
              const p = peek(last.res?.text || last.kind === 'sql' ? last : e);
              const xs = [ends(via[0])[0], ...via.map((v) => ends(v)[1])].map((id) => lane.get(id) ?? 0);
              return (
                <li key={e.id} data-ex={e.id} className={`jr-row k-${e.kind}${isOpen ? ' sel' : ''}${via.some((v) => hot?.has(v.id)) ? ' now' : ''}${ok ? '' : ' bad'}`}>
                  <button type="button" className="jr-hit" aria-expanded={isOpen} onClick={() => onPick(e.id)} style={{ ['--d' as string]: Math.min(it.d, 6) }}>
                    <svg className="jr-way" width={W} height={30} aria-hidden="true">
                      {lanes.map((l, i) => <line key={l.id} x1={i * LW + LW / 2} x2={i * LW + LW / 2} y1={0} y2={30} />)}
                      {xs.every((x) => x === xs[0]) ?<circle className="jr-self" cx={xs[0] + 5} cy={15} r={5} />
                        : <polyline points={xs.map((x) => `${x},15`).join(' ')} />}
                      {xs.map((x, i) => <circle key={i} className={i === 0 ? 'jr-from' : i === xs.length - 1 ? 'jr-to' : 'jr-via'} cx={x} cy={15} r={i === 0 || i === xs.length - 1 ? 3.5 : 2.5} />)}
                    </svg>
                    <span className="jr-text">
                      <span className="jr-what"><span>{b.what}</span>{b.note && <span className="faint jr-note">{b.note}</span>}</span>
                      {(p.up || p.down) && <span className="jr-peek mono">{p.up && <span><ArrowUpRight aria-label="llevó" />{p.up}</span>}{p.down && <span className={ok ? undefined : 'err-ink'}><ArrowDownLeft aria-label="recibió" />{p.down}</span>}</span>}
                    </span>
                    <span className="jr-end">
                      {status !== undefined ? <HttpStatus n={status} /> : !ok ? <span className="chip err">falló</span> : null}
                      {e.fault && <span className="chip run"><Zap />{e.fault}</span>}{e.mock && <span className="chip">mock</span>}
                      <span className="faint num">{ms !== undefined ? secs(ms) : time(e.t0)}</span>
                    </span>
                  </button>
                  {isOpen && (
                    <div className="jr-open">
                      {via.length > 1 && (
                        <div className="jr-legs" role="group" aria-label="Tramo">
                          {via.map((v) => <button key={v.id} type="button" className="btn sm" aria-pressed={v === shown} onClick={() => onPick(v.id)}>{route(v, (id) => names.get(id) ?? id)}</button>)}
                        </div>
                      )}
                      <RouteStrip way={via} at={Math.max(0, via.indexOf(shown))} reply={false} names={names} />
                      <p className="jr-label mono">{shown.method ? <><b>{shown.method}</b> {shown.path ?? '/'}{shown.query ? `?${shown.query}` : ''}</> : shown.label}<span className="faint">{time(shown.t0)}{shown.t1 !== undefined ? ` · ${secs(shown.t1 - shown.t0)}` : ''}</span></p>
                      <ExchangeIO ex={shown} names={names} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
