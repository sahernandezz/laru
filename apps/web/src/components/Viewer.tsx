/**
 * The viewer of a derived diagram: the engine's SVG with zoom, drag, full screen, a click on any box that opens its
 * sheet, «apagar lo de fuera» of a boundary, and export as SVG or as Mermaid. The drawing itself is made on the service
 * (`/api/diagram`); this only moves it around.
 */
import { Download, Expand, Maximize2, Minus, Plus, ScanSearch, Scissors } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { useApi } from '../api.ts';
import { pageOf } from '../lib/route.ts';
import { Origin, Skeleton, copy, toast } from './ui.tsx';

export interface DiagramData { id: string; kind: string; title: string; svg: string; mermaid: string; viewBox: [number, number, number, number]; ms: number; pieces: number; links: number }

const download = (name: string, text: string, type: string) => {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'diagrama';

export function DiagramViewer({ id, height = 560 }: { id: string; height?: number }) {
  const d = useApi<DiagramData>(`/api/diagram?id=${encodeURIComponent(id)}`);
  if (d.loading && !d.data) return <section className="panel"><div className="body"><Skeleton lines={6} /></div></section>;
  if (d.error || !d.data) return <section className="panel"><div className="empty">{d.error ?? 'No hay con qué dibujarlo: lee el código primero (Proyectos › Releer el código).'}</div></section>;
  if (d.data.pieces <= 1 && d.data.links === 0 && d.data.kind !== 'data-model') return <section className="panel"><div className="empty">Sin relaciones declaradas todavía: se dibujan cuando una pieza nombra a otra.</div></section>;
  return <Stage key={id} data={d.data} height={height} />;
}

function Stage({ data, height }: { data: DiagramData; height: number }) {
  const box = useRef<HTMLDivElement>(null);
  const view = useRef<HTMLDivElement>(null);
  const [t, setT] = useState({ s: 1, x: 0, y: 0 });
  const [limit, setLimit] = useState(false);
  const [lit, setLit] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const [w, h] = [data.viewBox[2], data.viewBox[3]];

  // Fit the drawing to the frame, and again when the frame changes size (full screen).
  const fit = () => {
    const r = view.current?.getBoundingClientRect();
    if (!r || !w || !h) return;
    const s = Math.min(r.width / w, r.height / h, 1.4);
    setT({ s, x: (r.width - w * s) / 2, y: (r.height - h * s) / 2 });
  };
  useEffect(() => { fit(); const on = () => fit(); addEventListener('resize', on); document.addEventListener('fullscreenchange', on); return () => { removeEventListener('resize', on); document.removeEventListener('fullscreenchange', on); }; }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  // Every box that is a piece is a link: reachable by keyboard and named for a screen reader.
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    stage.current?.querySelectorAll<SVGGElement>('g.pd-node[data-ref]').forEach((g) => {
      g.setAttribute('tabindex', '0'); g.setAttribute('role', 'link');
      g.setAttribute('aria-label', `Abrir ${g.querySelector('text')?.textContent ?? g.dataset.ref}`);
      g.style.cursor = 'pointer';
    });
  }, [data]);

  // «Apagar lo de fuera»: only what is inside the boundary stays lit, and the arrows between them.
  useEffect(() => {
    const root = stage.current; if (!root) return;
    const inside = (id: string): Set<string> => {
      const all = [...root.querySelectorAll<SVGGElement>('g.pd-node')], out = new Set<string>();
      const holds = (n: SVGGElement, b: string): boolean => n.dataset.inside === b || [...root.querySelectorAll<SVGGElement>('g.pd-boundary')].some((x) => x.dataset.id === n.dataset.inside && x.dataset.id !== b && holds(x as SVGGElement, b));
      for (const n of all) if (holds(n, id)) out.add(n.dataset.id!);
      return out;
    };
    const keep = lit ? inside(lit) : null;
    root.querySelectorAll<SVGGElement>('g.pd-node').forEach((n) => { n.style.opacity = !keep || keep.has(n.dataset.id!) ? '' : '0.18'; });
    root.querySelectorAll<SVGGElement>('g.pd-edge').forEach((e) => { const ends = (e.dataset.ends ?? '').split(' '); e.style.opacity = !keep || ends.every((x) => keep.has(x)) ? '' : '0.1'; });
    root.querySelectorAll<SVGGElement>('g.pd-boundary').forEach((b) => { b.style.opacity = !keep || b.dataset.id === lit ? '' : '0.35'; });
  }, [lit, data]);

  const zoom = (f: number, cx?: number, cy?: number) => setT((p) => {
    const r = view.current!.getBoundingClientRect(), px = cx ?? r.width / 2, py = cy ?? r.height / 2;
    const s = Math.min(4, Math.max(0.15, p.s * f));
    return { s, x: px - ((px - p.x) / p.s) * s, y: py - ((py - p.y) / p.s) * s };
  });
  const down = (e: RPointerEvent) => { drag.current = { x: e.clientX, y: e.clientY, moved: false }; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); };
  const move = (e: RPointerEvent) => {
    const d = drag.current; if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (d.moved) { d.x = e.clientX; d.y = e.clientY; setT((p) => ({ ...p, x: p.x + dx, y: p.y + dy })); }
  };
  const up = (e: RPointerEvent) => {
    const moved = drag.current?.moved; drag.current = null;
    if (moved) return;
    const target = e.target as Element;
    if (limit) { const b = target.closest('g.pd-boundary') as SVGGElement | null; if (b) { setLit((x) => (x === b.dataset.id ? null : b.dataset.id!)); return; } }
    const ref = (target.closest('g.pd-node[data-ref]') as SVGGElement | null)?.dataset.ref;
    if (ref) location.hash = pageOf(ref);
  };
  const key = (e: React.KeyboardEvent) => {
    const ref = (e.target as Element).closest?.('g.pd-node[data-ref]') as SVGGElement | null;
    if (ref && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); location.hash = pageOf(ref.dataset.ref!); }
    else if (e.key === '+' || e.key === '=') zoom(1.25); else if (e.key === '-') zoom(0.8); else if (e.key === '0') fit();
  };
  const svg = useMemo(() => ({ __html: data.svg }), [data.svg]);
  const btn = (label: string, I: typeof Plus, on: () => void, pressed?: boolean) => <button className="btn sm icon" aria-label={label} title={label} aria-pressed={pressed} onClick={on}><I /></button>;

  return (
    <section className="panel viewer" ref={box}>
      <header><h3>{data.title}</h3>
        <div className="meta"><Origin of="derived" /> {data.pieces} piezas · {data.links} flechas · dibujado en {data.ms} ms</div></header>
      <div className="viewer-tools" role="toolbar" aria-label="Herramientas del diagrama">
        {btn('Acercar', Plus, () => zoom(1.25))}{btn('Alejar', Minus, () => zoom(0.8))}{btn('Ajustar al marco', ScanSearch, fit)}
        {btn('Pantalla completa', Maximize2, () => (document.fullscreenElement ? document.exitFullscreen() : box.current?.requestFullscreen()))}
        <button className="btn sm" aria-pressed={limit} onClick={() => { setLimit((v) => !v); setLit(null); }} title="Pulsa un límite (un recuadro) y se apaga lo que queda fuera"><Scissors />Apagar lo de fuera{limit ? ': elige un límite' : ''}</button>
        {lit && <button className="btn sm" onClick={() => setLit(null)}>Encender todo</button>}
        <span className="grow" />
        <button className="btn sm" onClick={() => download(`${slug(data.title)}.svg`, data.svg.includes('xmlns') ? data.svg : data.svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"'), 'image/svg+xml')}><Download />SVG</button>
        <button className="btn sm" onClick={() => copy(data.mermaid, 'Mermaid copiado')}><Expand />Copiar Mermaid</button>
        <button className="btn sm" onClick={() => { download(`${slug(data.title)}.mmd`, data.mermaid, 'text/plain'); toast('Mermaid descargado'); }}><Download />Mermaid</button>
      </div>
      <div className="viewer-frame" ref={view} style={{ height }} tabIndex={0} role="group" aria-label={`${data.title}: arrastra para moverlo, +/− para acercar, Enter sobre una caja abre su hoja`}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onKeyDown={key}
        onWheel={(e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); const r = view.current!.getBoundingClientRect(); zoom(e.deltaY < 0 ? 1.1 : 0.9, e.clientX - r.left, e.clientY - r.top); } }}>
        <div ref={stage} className="viewer-stage" style={{ width: w, height: h, transform: `translate(${t.x}px, ${t.y}px) scale(${t.s})` }} dangerouslySetInnerHTML={svg} />
      </div>
    </section>
  );
}
