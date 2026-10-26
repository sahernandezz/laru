/**
 * «Cadena» and «Este mensaje»: the trace as a tree of acts (who called whom, what was stored, published and consumed,
 * one sentence per hop, noise folded) and the card of the stop the player is at. Both read one cursor, the player's,
 * and move it only through `go`.
 */
import { ArrowLeft, ArrowRight, ChevronDown, ChevronRight, CircleX, Footprints } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Act, Noise } from '@laru/trace/chain';
import type { LogLine, Step } from '../api.ts';
import { HttpStatus, Level } from '../components/ui.tsx';
import { plural, secs } from '../lib/es.ts';
import { actSummary, at, brief, chip, markSaid, say, sayCause, sayOrphan, statusText, type SayCtx } from '../lib/say.ts';
import { clock, hopLogs, revealBy, route, stepOf, type SeqLayout, type Stop } from '../lib/seq.ts';


/** Where the cursor is, in words: «Acción 3 de 7 · mensaje 4 de 41 · paso 2». */
export interface Where { act?: Act; actNo?: number; acts: number; m?: number; n?: number; step?: Step; fail?: boolean; /** nothing at the cursor */ none?: boolean }
export const actName = (w: Pick<Where, 'act' | 'actNo' | 'fail' | 'none'>) => (w.fail ? 'El fallo' : w.none ? 'Ningún mensaje' : !w.act ? 'Sin causa visible' : w.act.id === 'preparacion' ? 'Preparación' : `Acción ${w.actNo}`);

/** The folded rows of an act in a line: «10 recursos, canal de avisos, 3 «connected»». */
export function foldedSaid(ids: string[], ctx: SayCtx): string {
  const ex = new Map(ctx.trace.exchanges.map((e) => [e.id, e]));
  const by = new Map<Noise, string[]>();
  for (const id of ids) { const n = ctx.chain.noise.get(id); if (n) (by.get(n) ?? by.set(n, []).get(n)!).push(id); }
  const out: string[] = [];
  const assets = (by.get('asset') ?? []).reduce((s, id) => s + (ex.get(id)?.asset ?? 0), 0);
  if (assets) out.push(plural(assets, 'recurso', 'recursos'));
  if (by.get('stream')?.length) out.push('canal de avisos');
  const hellos = Map.groupBy(by.get('hello') ?? [], (id) => ex.get(id)!.label.replace(/^evento /, ''));
  for (const [name, xs] of hellos) out.push(`${xs.length} «${name}»`);
  if (by.get('preflight')?.length) out.push(plural(by.get('preflight')!.length, 'preflight', 'preflights'));
  if (by.get('foreign')?.length) out.push(plural(by.get('foreign')!.length, 'ajeno', 'ajenos'));
  return out.join(', ');
}

// ---------- the tree ----------

type Kind = 'step' | 'act' | 'hop' | 'same' | 'fold' | 'fail' | 'orphans' | 'empty';
interface Item { key: string; kind: Kind; level: number; parent?: string; expandable: boolean; expanded: boolean; id?: string; ids?: string[]; act?: Act; step?: Step; stop?: Stop; pos?: number; size?: number }

interface ChainProps {
  ctx: SayCtx;
  layout: SeqLayout;
  steps: Step[];
  cur: Stop | null;
  go: (s: Stop) => void;
  /** clock mode: the exchanges whose row is now */
  hot?: Set<string>;
  /** folded rows on show: all, or an act's */
  showAll: boolean;
  setShowAll: (b: boolean) => void;
  unfolded: Set<string>;
  toggleFold: (act: string) => void;
  actNo: Map<string, number>;
  /** the act whose chain holds the failure: open at first */
  failAct?: string;
  onWalk?: (act: Act) => void;
}

/** «Cadena»: a WAI-ARIA tree, one roving tab stop; only expanded nodes are drawn. */
export function ChainTab({ ctx, layout, steps, cur, go, hot, showAll, setShowAll, unfolded, toggleFold, actNo, failAct, onWalk }: ChainProps) {
  const ch = ctx.chain;
  const [open, setOpen] = useState<Set<string>>(() => new Set(failAct ? [`a:${failAct}`] : []));
  const [shut, setShut] = useState<Set<string>>(() => new Set());
  const [same, setSame] = useState<Set<string>>(() => new Set());
  const [focus, setFocus] = useState<string>();
  // a render after the cursor moved, even when nothing else changed, so the node it names is revealed then
  const [, reveal] = useState(0);
  const tree = useRef<HTMLDivElement>(null);
  const pending = useRef<{ key: string; focus: boolean } | null>(null);
  const ex = useMemo(() => new Map(ctx.trace.exchanges.map((e) => [e.id, e])), [ctx]);
  const reqRow = useMemo(() => new Map(layout.rows.filter((r) => !r.reply).map((r) => [r.ex.id, r.i])), [layout]);
  // the sentences, said once per trace: a move of the cursor redraws the rows, not their words
  const said = useMemo(() => new Map<string, string>(), [ctx]);
  const once = (key: string, f: () => string) => said.get(key) ?? said.set(key, f()).get(key)!;
  const sentence = (id: string) => once(id, () => { const o = ch.orphans.find((x) => x.id === id); return o ? sayOrphan(o, ctx) : say({ kind: 'row', i: reqRow.get(id)! }, ctx); });
  const sig = (id: string) => { const e = ex.get(id)!; return `${e.from}|${e.to}|${e.label}`; };
  const shown = (act: string, id: string) => !ch.noise.has(id) || showAll || unfolded.has(act);
  const folded = useMemo(() => Map.groupBy(ctx.trace.exchanges.filter((e) => ch.noise.has(e.id)).map((e) => e.id), (id) => ch.actOf.get(id) ?? ''), [ctx, ch]);
  // A request and its forwards (front → gateway → service) are one row: the route says the way, its children what the last one did.
  const forwards = (id: string) => (ch.effects.get(id) ?? []).filter((k) => ch.cause.get(k)?.how === 'forward');
  const through = (id: string) => { const xs = [id]; for (let f = forwards(id); f.length === 1 && xs.length < 20; f = forwards(xs.at(-1)!)) xs.push(f[0]); return xs; };
  const headOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of ctx.trace.exchanges) { if (ch.cause.get(e.id)?.how === 'forward' && forwards(ch.cause.get(e.id)!.parent).length === 1) continue; for (const x of through(e.id)) m.set(x, e.id); }
    return m;
  }, [ctx]);
  const rowStop = (id: string): Stop => ({ kind: 'row', i: reqRow.get(id) ?? layout.rows.findIndex((r) => r.ex.id === id) });
  const failStep = ctx.trace.failure && steps.some((s) => s.n === ctx.trace.failure!.step) ? ctx.trace.failure.step : undefined;

  const list = useMemo(() => {
    const out: Item[] = [];
    const hops = (ids: string[], level: number, act: string, parent: string) => {
      const xs = ids.filter((id) => shown(act, id));
      for (let i = 0; i < xs.length;) {
        let j = i + 1;
        while (j < xs.length && sig(xs[j]) === sig(xs[i])) j++;
        if (j - i > 1) {
          const key = `c:${xs[i]}`, isOpen = same.has(key);
          out.push({ key, kind: 'same', level, parent, ids: xs.slice(i, j), expandable: true, expanded: isOpen });
          if (isOpen) for (const id of xs.slice(i, j)) hop(id, level + 1, act, key);
        } else hop(xs[i], level, act, parent);
        i = j;
      }
    };
    const hop = (id: string, level: number, act: string, parent: string) => {
      const way = through(id);
      const kids = way.flatMap((x) => ch.effects.get(x) ?? []).filter((k) => !way.includes(k) && shown(act, k)).sort((a, b) => ex.get(a)!.t0 - ex.get(b)!.t0);
      const key = `h:${id}`, expanded = kids.length > 0 && !shut.has(key);
      out.push({ key, kind: 'hop', id, ids: way, level, parent, expandable: kids.length > 0, expanded, stop: rowStop(id) });
      if (expanded) hops(kids, level + 1, act, key);
    };
    const act = (a: Act, level: number, parent?: string) => {
      const key = `a:${a.id}`, isOpen = open.has(key);
      out.push({ key, kind: 'act', act: a, level, parent, expandable: true, expanded: isOpen, stop: { kind: 'act', act: a } });
      if (!isOpen) return;
      hops(a.roots, level + 1, a.id, key);
      if (folded.get(a.id)?.length) out.push({ key: `f:${a.id}`, kind: 'fold', level: level + 1, parent: key, act: a, expandable: false, expanded: false });
    };
    const fail: Omit<Item, 'level'> = { key: 'fail', kind: 'fail', expandable: false, expanded: false, stop: { kind: 'fail' } };
    const sorted = [...steps].sort((a, b) => a.t0 - b.t0);
    for (const a of ch.acts.filter((x) => x.step === undefined)) act(a, 1);
    for (const s of sorted) {
      const key = `s:${s.n}`, isOpen = !shut.has(key);
      const mine = ch.acts.filter((a) => a.step === s.n);
      out.push({ key, kind: 'step', step: s, level: 1, expandable: true, expanded: isOpen });
      if (!isOpen) continue;
      for (const a of mine) act(a, 2, key);
      if (!mine.length) out.push({ key: `e:${s.n}`, kind: 'empty', level: 2, parent: key, expandable: false, expanded: false });
      if (failStep === s.n) out.push({ ...fail, level: 2, parent: key });
    }
    if (ctx.trace.failure && failStep === undefined) out.push({ ...fail, level: 1 });
    if (ch.orphans.length) {
      const isOpen = !shut.has('o');
      out.push({ key: 'o', kind: 'orphans', level: 1, expandable: true, expanded: isOpen });
      if (isOpen) for (const o of ch.orphans) hop(o.id, 2, '', 'o');
    }
    // aria-setsize and aria-posinset: the drawing is flat, so each item says where it sits among its siblings
    const sizes = new Map<string, number>();
    for (const it of out) { const k = `${it.parent ?? ''}|${it.level}`; it.pos = (sizes.get(k) ?? 0) + 1; sizes.set(k, it.pos); }
    for (const it of out) it.size = sizes.get(`${it.parent ?? ''}|${it.level}`);
    return out;
  }, [ctx, layout, steps, open, shut, same, showAll, unfolded, folded]);

  // The cursor moved (from anywhere): its node is revealed, and focused when the focus was already in the tree.
  const curKey = (s: Stop | null): string | undefined => {
    if (!s) return undefined;
    if (s.kind === 'act') return `a:${s.act.id}`;
    if (s.kind === 'fail') return 'fail';
    const id = layout.rows[s.i]?.ex.id;
    if (!id) return undefined;
    const act = ch.actOf.get(id) ?? '';
    return shown(act, id) ? `h:${headOf.get(id) ?? id}` : `f:${act}`;
  };
  useEffect(() => {
    if (!cur) return;
    const key = curKey(cur);
    if (!key) return;
    if (cur.kind === 'row') {
      const id = layout.rows[cur.i].ex.id, a = ch.actOf.get(id);
      const path: string[] = [];
      for (let x = ch.cause.get(id)?.parent, i = 0; x && i < 200; x = ch.cause.get(x)?.parent, i++) path.unshift(x);
      const actObj = ch.acts.find((y) => y.id === a);
      setOpen((o) => (a && !o.has(`a:${a}`) ? new Set(o).add(`a:${a}`) : o));
      setShut((o) => { const n = new Set(o); for (const p of path) n.delete(`h:${headOf.get(p) ?? p}`); if (actObj?.step !== undefined) n.delete(`s:${actObj.step}`); n.delete('o'); return n.size === o.size ? o : n; });
      // a node inside a compacted run of siblings opens that run
      setSame((o) => {
        const n = new Set(o);
        const chainIds = [...path, id];
        chainIds.forEach((x, k) => {
          const sibs = (k === 0 ? actObj?.roots ?? ch.orphans.map((y) => y.id) : ch.effects.get(chainIds[k - 1]) ?? []).filter((y) => shown(a ?? '', y));
          const i = sibs.indexOf(x);
          let s0 = i;
          while (s0 > 0 && sig(sibs[s0 - 1]) === sig(x)) s0--;
          let s1 = i;
          while (s1 < sibs.length - 1 && sig(sibs[s1 + 1]) === sig(x)) s1++;
          if (i >= 0 && s1 > s0) n.add(`c:${sibs[s0]}`);
        });
        return n.size === o.size ? o : n;
      });
    } else if (cur.kind === 'act') {
      setOpen((o) => (o.has(key) ? o : new Set(o).add(key)));
      if (cur.act.step !== undefined) setShut((o) => (o.has(`s:${cur.act.step}`) ? new Set([...o].filter((k) => k !== `s:${cur.act.step}`)) : o));
    }
    pending.current = { key, focus: Boolean(tree.current?.contains(document.activeElement)) };
    setFocus(key);
    reveal((n) => n + 1);
  }, [cur]);
  /**
   * A node into the part of the tree on screen. The tree scrolls first, so the video and Secuencia stay; only what it
   * cannot cover (at its end) moves its scroller: the page, or the documentation's sheet.
   */
  // Opening a run reveals the failing node inside the tree only: the page stays at its top until the person touches something.
  const touched = useRef(false);
  useEffect(() => {
    const on = () => { touched.current = true; };
    addEventListener('pointerdown', on, true); addEventListener('keydown', on, true);
    return () => { removeEventListener('pointerdown', on, true); removeEventListener('keydown', on, true); };
  }, []);
  const inView = (el: HTMLElement) => {
    const box = tree.current!;
    let scroller: HTMLElement | null = box.parentElement;
    while (scroller && !(/(auto|scroll)/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight)) scroller = scroller.parentElement;
    const s = scroller?.getBoundingClientRect() ?? { top: 0, bottom: innerHeight };
    const view = { top: Math.max(s.top, 0), bottom: Math.min(s.bottom, innerHeight) };
    box.scrollTop += revealBy(box.getBoundingClientRect(), view, el.getBoundingClientRect());
    const left = revealBy({ top: -Infinity, bottom: Infinity }, view, el.getBoundingClientRect());
    if (left && scroller && touched.current) scroller.scrollTop += left;
  };
  useLayoutEffect(() => {
    const p = pending.current;
    if (!p) return;
    const el = tree.current?.querySelector<HTMLElement>(`[data-k="${CSS.escape(p.key)}"]`);
    if (!el) return;
    pending.current = null;
    inView(el);
    if (p.focus && document.activeElement !== el) el.focus({ preventScroll: true });
  });

  const toggle = (it: Item) => {
    if (it.kind === 'act') setOpen((o) => { const n = new Set(o); if (n.has(it.key)) n.delete(it.key); else n.add(it.key); return n; });
    else if (it.kind === 'same') setSame((o) => { const n = new Set(o); if (n.has(it.key)) n.delete(it.key); else n.add(it.key); return n; });
    else setShut((o) => { const n = new Set(o); if (n.has(it.key)) n.delete(it.key); else n.add(it.key); return n; });
  };
  const move = (it: Item) => {
    setFocus(it.key);
    const el = tree.current?.querySelector<HTMLElement>(`[data-k="${CSS.escape(it.key)}"]`);
    if (el) { el.focus({ preventScroll: true }); inView(el); }
    if (it.stop) go(it.stop);
  };
  const activate = (it: Item) => {
    if (it.kind === 'fold' && it.act) toggleFold(it.act.id);
    else if (it.expandable && !it.stop) toggle(it);
    else if (it.stop) go(it.stop);
  };
  const keys = (e: KeyboardEvent) => {
    const i = list.findIndex((x) => x.key === (focus ?? list[0]?.key));
    const it = list[i];
    if (!it) return;
    const actAt = (d: number) => { for (let k = i + d; k >= 0 && k < list.length; k += d) if (list[k].kind === 'act') return k; return null; };
    let to: number | null = null;
    if (e.key === 'ArrowDown') to = e.shiftKey ? actAt(1) : i + 1;
    else if (e.key === 'ArrowUp') to = e.shiftKey ? actAt(-1) : i - 1;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = list.length - 1;
    else if (e.key === 'ArrowRight') { if (it.expandable && !it.expanded) toggle(it); else if (it.expanded) to = i + 1; }
    else if (e.key === 'ArrowLeft') { if (it.expanded) toggle(it); else if (it.parent) to = list.findIndex((x) => x.key === it.parent); }
    else if (e.key === 'Enter') { if (it.kind === 'fold' || !it.expandable) activate(it); else toggle(it); }
    else return;
    e.preventDefault();
    if (to !== null && list[to]) move(list[to]);
  };

  const possible = [...ch.cause.values()].filter((c) => c.certainty === 'possible').length;
  const acts = ch.acts.filter((a) => a.id !== 'preparacion').length;
  const marks = Boolean(ctx.trace.actions?.length);
  const tab = focus && list.some((x) => x.key === focus) ? focus : curKey(cur) && list.some((x) => x.key === curKey(cur)) ? curKey(cur) : list[0]?.key;
  const selKey = curKey(cur);

  const body = (it: Item): ReactNode => {
    switch (it.kind) {
      case 'step': return <><span className="ct-stepname">{it.step!.n}. {it.step!.title}</span>{it.step!.status === 'failed' && <span className="err-ink ct-end"><CircleX />falló</span>}</>;
      case 'empty': return <span className="faint">Ninguna petición en este paso.</span>;
      case 'orphans': return <span className="ct-stepname">Sin causa visible en esta prueba</span>;
      case 'fail': {
        const f = ctx.trace.failure!;
        return <><CircleX className="err-ink" /><span className="ct-say err-ink">Aquí falla {steps.length ? 'la prueba' : 'el caso'}: {f.message.split('\n')[0]}</span></>;
      }
      case 'fold': {
        const ids = folded.get(it.act!.id) ?? [];
        const on = showAll || unfolded.has(it.act!.id);
        return <span className="faint">⋯ {on ? 'desplegado' : 'plegado'}: {once(`f:${it.act!.id}`, () => foldedSaid(ids, ctx))}{showAll ? '' : on ? ' · Intro lo pliega' : ' · Intro lo despliega'}</span>;
      }
      case 'act': {
        const a = it.act!;
        const ids = folded.get(a.id) ?? [];
        return (
          <span className="ct-actline">
            <span className="ct-acthead"><b>{actName({ act: a, actNo: actNo.get(a.id) })}</b> · <span className="ct-say">{once(`a:${a.id}`, () => say({ kind: 'act', act: a }, ctx))}</span>
              <span className="ct-meta num">{clock(a.t0)}</span>{!it.expanded && ids.length > 0 && <span className="faint ct-meta">⋯ {once(`f:${a.id}`, () => foldedSaid(ids, ctx))}</span>}
              {onWalk && <button type="button" className="ct-walk" tabIndex={-1} aria-hidden="true" title="Recorrer paso a paso (P)" onClick={(e) => { e.stopPropagation(); onWalk(a); }}><Footprints /></button>}</span>
          </span>
        );
      }
      case 'same': {
        const e = ex.get(it.ids![0])!;
        return <><span className="mono ct-route">{route(e, ctx.name)}</span><span className="ct-say mono">×{it.ids!.length} {e.label}</span></>;
      }
      case 'hop': {
        const way = it.ids!.map((x) => ex.get(x)!), e = way[0], last = way.at(-1)!, c = ch.cause.get(e.id), { what, note } = brief(e, ctx);
        return (
          <>
            <span className="mono ct-route">{[route(e, ctx.name), ...way.slice(1).map((x) => ctx.name(x.to))].join(' → ')}</span>
            <span className="ct-say"><span className={`mono k-${e.kind}`}>{what}</span>{note && <span className="faint"> · {note}</span>}</span>
            <span className="ct-end">
              {c?.certainty === 'possible' && <span className="ct-maybe" title={once(`c:${e.id}`, () => chip(c, ctx))} aria-label="Causa posible, no segura">?</span>}
              {last.status !== undefined && last.status >= 400 ? <HttpStatus n={last.status} /> : e.status !== undefined ? <HttpStatus n={e.status} /> : !e.ok ? <span className="err-ink">falló</span> : null}
              {e.t1 !== undefined && e.t1 > e.t0 && <span className="faint num">{secs(e.t1 - e.t0)}</span>}
            </span>
          </>
        );
      }
    }
  };

  return (
    <>
      <div className="toolbar ct-bar">
        <button type="button" className="btn sm" aria-pressed={showAll} onClick={() => setShowAll(!showAll)}>Mostrar lo plegado</button>
        <span className="faint num">{plural(acts, 'acción', 'acciones')}{possible ? ` · ${possible} con causa dudosa (?)` : ''}{marks ? '' : ' · agrupadas por tandas'}</span>
      </div>
      <div className="chain-tree" role="tree" aria-label="Cadena de causas: cada acción con lo que provocó" ref={tree} onKeyDown={keys}>
        {list.map((it) => {
          const lv = Math.min(it.level, 8);
          const noise = it.id && ch.noise.has(it.id);
          return (
            <div key={it.key} data-k={it.key} role="treeitem" aria-level={it.level} aria-setsize={it.size} aria-posinset={it.pos} aria-expanded={it.expandable ? it.expanded : undefined}
              aria-selected={it.key === selKey} tabIndex={it.key === tab ? 0 : -1}
              className={['ct-row', `ct-${it.kind}`, it.key === selKey && 'sel', it.id && hot?.has(it.id) && 'now', noise && 'noise'].filter(Boolean).join(' ')}
              title={it.kind === 'hop' ? sentence(it.id!) : undefined}
              style={{ paddingLeft: 8 + (lv - 1) * 12 }} onFocus={(e) => { if (e.target === e.currentTarget) setFocus(it.key); }}
              onClick={() => { setFocus(it.key); activate(it); }}>
              <span className="ct-tw" onClick={(e) => { if (it.expandable) { e.stopPropagation(); setFocus(it.key); toggle(it); } }} aria-hidden="true">{it.expandable ? (it.expanded ? <ChevronDown /> : <ChevronRight />) : null}</span>
              {it.level > 8 && <span className="faint ct-deep">↳ nivel {it.level}</span>}
              {body(it)}
            </div>
          );
        })}
      </div>
    </>
  );
}

// ---------- «Este mensaje» ----------

interface CardProps {
  ctx: SayCtx;
  layout: SeqLayout;
  cur: Stop | null;
  go: (s: Stop) => void;
  where: Where;
  logs: LogLine[];
  onLogs: () => void;
  /** clock mode: walking from an act starts here */
  onWalk?: (s: Stop) => void;
}

const MAX_EFFECTS = 5;

/** What the cursor is at, said: the stop's sentence, where it sits, what caused it and what it caused. */
export function StepCard({ ctx, layout, cur, go, where, logs, onLogs, onWalk }: CardProps) {
  const ch = ctx.chain;
  const ex = useMemo(() => new Map(ctx.trace.exchanges.map((e) => [e.id, e])), [ctx]);
  const reqOf = (id: string): Stop => ({ kind: 'row', i: layout.rows.findIndex((r) => r.ex.id === id && !r.reply) });
  const hop = (id: string) => route(ex.get(id)!, ctx.name);
  const head = (t: number, extra?: string) => (
    <p className="sc-where">{actName(where)}{where.m ? ` › mensaje ${where.m} de ${where.n}` : where.act ? ` · ${plural(where.n ?? 0, 'mensaje', 'mensajes')}` : ''} · {at(t)}{where.step ? ` · paso ${where.step.n} del flujo` : ''}{extra}</p>
  );
  if (!cur) return <p className="empty">Elige un mensaje en el diagrama, un nodo de la cadena, un paso o una fila de Red: aquí se dice qué hace, quién lo provocó y qué provocó.</p>;

  if (cur.kind === 'fail') {
    const lines = say(cur, ctx).split('\n');
    return <div className="step-card">{lines.map((l, i) => <p key={i} className={i ? 'sc-line' : 'sc-say err-ink'}>{l}</p>)}</div>;
  }

  if (cur.kind === 'act') {
    const a = cur.act;
    return (
      <div className="step-card">
        {head(a.t0)}
        <p className="sc-say">{say(cur, ctx)}</p>
        <p className="sc-line faint">{actSummary(a, ctx)}</p>
        {a.marks.length > 0 && (
          <dl className="sc-dl"><dt>Marcas</dt><dd><ul className="sc-list">{a.marks.map((m, i) => <li key={i}><span className="faint num">{clock(m.t0)}</span> {markSaid(m, a, ctx)}{m.target ? <> <code>{m.target}</code></> : null}</li>)}</ul></dd></dl>
        )}
        <dl className="sc-dl"><dt>Empieza por</dt><dd>{a.roots.length ? <ul className="sc-list">{a.roots.map((id) => <li key={id}><button type="button" className="ex-go" onClick={() => go(reqOf(id))}><span className="mono">{hop(id)}</span> {ex.get(id)!.label}</button>{ch.noise.has(id) ? <span className="faint"> (plegado)</span> : null}</li>)}</ul> : <span className="faint">No sale ninguna petición.</span>}</dd></dl>
        {onWalk && <button type="button" className="btn sm" onClick={() => onWalk(cur)}><Footprints />Recorrer paso a paso</button>}
      </div>
    );
  }

  const r = layout.rows[cur.i];
  if (!r) return null;
  const e = r.ex, c = ch.cause.get(e.id);
  const effects = ch.effects.get(e.id) ?? [];
  const lines = hopLogs(e, logs);
  const services = [...new Set(lines.map((l) => l.service))];
  const both = (e.kind === 'http' || e.kind === 'ws') && !e.asset && e.t1 !== undefined;
  const reqI = layout.rows.findIndex((x) => x.ex.id === e.id && !x.reply), resI = layout.rows.findIndex((x) => x.ex.id === e.id && x.reply);
  return (
    <div className="step-card">
      {head(r.t)}
      <p className="sc-say">{say(cur, ctx)}</p>
      <div className="sc-links">
        {(c || where.act) && <button type="button" className="ex-go" onClick={() => go(c ? reqOf(c.parent) : { kind: 'act', act: where.act! })} title={sayCause(e, ctx)}><ArrowLeft /> {c ? <><span className="mono">{hop(c.parent)}</span> {ex.get(c.parent)!.label}</> : actName(where)}{c?.certainty === 'possible' && <span className="ct-maybe" title={chip(c, ctx)}>?</span>}</button>}
        {effects.slice(0, MAX_EFFECTS).map((id) => <button key={id} type="button" className="ex-go" onClick={() => go(reqOf(id))}><ArrowRight /> <span className="mono">{hop(id)}</span> {ex.get(id)!.label}</button>)}
        {effects.length > MAX_EFFECTS && <span className="faint">… y {effects.length - MAX_EFFECTS} más</span>}
      </div>
      {both ? (
        <div className="sc-rr" role="group" aria-label="Petición y respuesta (R salta entre ellas)">
          <button type="button" className="btn sm" aria-pressed={!r.reply} onClick={() => go({ kind: 'row', i: reqI })}>Petición <span className="mono">{e.label}</span></button>
          <button type="button" className="btn sm" aria-pressed={r.reply} onClick={() => go({ kind: 'row', i: resI })}>Respuesta <span className="mono">{e.status !== undefined ? statusText(e.status) : e.error ?? 'sin respuesta'} · {secs(e.t1! - e.t0)}</span></button>
        </div>
      ) : null}
      <details className="sc-logs">
        <summary>{lines.length ? `Logs de ${services.join(' y ')} en este salto (${lines.length})` : 'Ningún log de estos servicios en este salto'}</summary>
        {lines.map((l) => <div key={l.id} className="sc-log"><span className="faint num">{at(l.t)}</span><Level lv={l.level} /><span className="mono">{l.line}</span></div>)}
        <button type="button" className="btn sm" onClick={onLogs}>Ver todos en Logs</button>
      </details>
    </div>
  );
}

/** The step a stop belongs to, and its act and counters, for the card and the transport. */
export function whereOf(cur: Stop | null, ctx: SayCtx, layout: SeqLayout, walkRows: number[], actNo: Map<string, number>, steps: Step[], t: number): Where {
  const ch = ctx.chain;
  const acts = actNo.size;
  const step = stepOf(steps, t);
  if (!cur || cur.kind === 'fail') return { acts, step, fail: cur?.kind === 'fail', none: !cur };
  const id = cur.kind === 'act' ? cur.act.id : ch.actOf.get(layout.rows[cur.i]?.ex.id ?? '');
  const act = cur.kind === 'act' ? cur.act : ch.acts.find((a) => a.id === id);
  if (!act) return { acts, step };
  const mine = walkRows.filter((i) => ch.actOf.get(layout.rows[i].ex.id) === act.id);
  const m = cur.kind === 'row' ? mine.indexOf(cur.i) + 1 || undefined : undefined;
  return { act, actNo: actNo.get(act.id), acts, m, n: mine.length, step };
}

