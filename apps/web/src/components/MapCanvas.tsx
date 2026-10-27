/** The frame both maps draw in (the system's and a flow's), and the box a piece is drawn as. */
import { Database, Globe, Maximize, Server, User, ZoomIn, ZoomOut, type LucideIcon } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type SVGProps } from 'react';
import type { MapNode } from '../api.ts';
import { LABEL_H, NODE_H, NODE_W, type Layout } from '../lib/sysmap.ts';

export const ICON: Record<string, LucideIcon> = { service: Server, datastore: Database, external: Globe };

const ZOOM_MIN = 0.3, ZOOM_MAX = 2.5;
/** Where the drawing starts inside its box: centred while it is smaller than the box, at the corner once it is not. */
const offset = (b: HTMLElement) => { const s = b.firstElementChild!.getBoundingClientRect(), r = b.getBoundingClientRect(); return { x: s.left - r.left + b.scrollLeft, y: s.top - r.top + b.scrollTop }; };

/**
 * The frame both maps draw in: a box that scrolls both ways, the column titles, the arrowhead and a node kept in view.
 * It zooms with its buttons, or with ⌘/Ctrl and the wheel (a trackpad's pinch is the same) around the pointer.
 */
export function MapCanvas({ lay, label, keep, onBackground, className, children }: { lay: Layout; label: string; keep?: string; onBackground?: () => void; className?: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [z, setZ] = useState(1);
  // The map point that stays under the pointer (or the middle) while the zoom changes, in map units.
  const anchor = useRef<{ mx: number; my: number; px: number; py: number } | null>(null);
  const zoomTo = (next: number, at?: { x: number; y: number }) => {
    const b = box.current;
    if (!b) return;
    const zz = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
    const px = at?.x ?? b.clientWidth / 2, py = at?.y ?? b.clientHeight / 2;
    const o = offset(b);
    anchor.current = { mx: (b.scrollLeft + px - o.x) / z, my: (b.scrollTop + py - o.y) / z, px, py };
    setZ(zz);
  };
  const fit = () => { const b = box.current; if (b) { anchor.current = null; setZ(Math.min(1, Math.max(ZOOM_MIN, Math.min(b.clientWidth / lay.width, b.clientHeight / lay.height)))); } };
  useLayoutEffect(() => {
    const b = box.current, a = anchor.current;
    if (!b || !a) return;
    anchor.current = null;
    const o = offset(b);
    b.scrollTo(a.mx * z + o.x - a.px, a.my * z + o.y - a.py);
  }, [z]);
  // A wheel with ⌘/Ctrl zooms instead of scrolling the page: the listener must be able to prevent it.
  const zoomRef = useRef(zoomTo);
  zoomRef.current = zoomTo;
  useEffect(() => {
    const b = box.current;
    if (!b) return;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = b.getBoundingClientRect();
      zoomRef.current(zRef.current * Math.exp(-e.deltaY / 300), { x: e.clientX - r.left, y: e.clientY - r.top });
    };
    b.addEventListener('wheel', wheel, { passive: false });
    return () => b.removeEventListener('wheel', wheel);
  }, []);
  const zRef = useRef(z);
  zRef.current = z;
  // Only when it is out of sight, and at once: the box scrolls, never the page.
  useLayoutEffect(() => {
    const b = box.current, p = lay.nodes.find((n) => n.node.id === keep);
    if (!b || !p) return;
    const o = offset(b), x = p.x * z + o.x, y = p.y * z + o.y, w = NODE_W * z, h = NODE_H * z;
    const left = x < b.scrollLeft || x + w > b.scrollLeft + b.clientWidth ? x - (b.clientWidth - w) / 2 : b.scrollLeft;
    const top = y < b.scrollTop || y + h > b.scrollTop + b.clientHeight ? y - (b.clientHeight - h) / 2 : b.scrollTop;
    b.scrollTo(left, top);
  }, [keep, lay]);
  return (
    <div className="mapwrap">
      <div className={`mapcanvas${className ? ` ${className}` : ''}`} ref={box} onClick={(e) => { if (!(e.target as Element).closest('[role="button"]')) onBackground?.(); }}
        onScroll={(e) => { const b = e.currentTarget; b.style.setProperty('--gx', `${-b.scrollLeft / 2}px`); b.style.setProperty('--gy', `${-b.scrollTop / 2}px`); }}>
        <svg className="sysmap" width={lay.width * z} height={lay.height * z} viewBox={`0 0 ${lay.width} ${lay.height}`} role="group" aria-label={label}>
          <defs>{([['arrow', 'var(--ink-3)'], ['arrow-err', 'var(--err)'], ['arrow-acc', 'var(--accent)']] as const).map(([id, fill]) => (
            <marker key={id} id={id} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8" fill={fill} /></marker>
          ))}</defs>
          <g aria-hidden="true">{lay.columns.map((c) => <text key={c.x} className="col-h" x={c.x} y={24}>{c.title}</text>)}</g>
          {children}
        </svg>
      </div>
      <div className="mapzoom" role="group" aria-label="Zoom del mapa">
        <button type="button" className="icon-btn" aria-label="Alejar" title="Alejar (⌘/Ctrl + rueda)" aria-disabled={z <= ZOOM_MIN} onClick={() => zoomTo(z / 1.25)}><ZoomOut size={15} /></button>
        <button type="button" className="mapzoom-v" aria-label={`Zoom ${Math.round(z * 100)} %; volver al 100 %`} title="Volver al 100 %" onClick={() => zoomTo(1)}>{Math.round(z * 100)} %</button>
        <button type="button" className="icon-btn" aria-label="Acercar" title="Acercar (⌘/Ctrl + rueda)" aria-disabled={z >= ZOOM_MAX} onClick={() => zoomTo(z * 1.25)}><ZoomIn size={15} /></button>
        <button type="button" className="icon-btn" aria-label="Ver el mapa entero" title="Ver el mapa entero" onClick={fit}><Maximize size={15} /></button>
      </div>
    </div>
  );
}

/** A piece on a map: its icon, its name and one line under it. */
export function NodeBox({ node, x, y, sub, className = '', ...rest }: { node: MapNode; x: number; y: number; sub: string; className?: string } & SVGProps<SVGGElement>) {
  const Icon = node.kind === 'actor' ? User : ICON[node.type] ?? Server;
  return (
    <g className={`n ${className}`} data-node={node.id} transform={`translate(${x},${y})`} {...rest}>
      <rect width={NODE_W} height={NODE_H} rx="8" />
      <foreignObject x="12" y="12" width="16" height="16"><Icon size={16} color="var(--ink-2)" /></foreignObject>
      <text className="t" x="36" y="25">{node.name}</text>
      <text className="s" x="36" y="43">{sub}</text>
    </g>
  );
}

/** An edge's label on its own line, in the box the layout kept for it: its backdrop stops that line at its edges, and no other line runs under it. */
export function EdgeLabel({ e, className = '' }: { e: Layout['edges'][number]; className?: string }) {
  if (!e.lw) return null;
  return <><rect className="el-bg" x={e.lx - e.lw / 2} y={e.ly - 11} width={e.lw} height={LABEL_H} rx={3} /><text className={`el ${className}`} x={e.lx} y={e.ly} textAnchor="middle">{e.label}</text></>;
}
