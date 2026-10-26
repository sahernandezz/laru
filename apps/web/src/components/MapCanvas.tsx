/** The frame both maps draw in (the system's and a flow's), and the box a piece is drawn as. */
import { Database, Globe, Server, User, type LucideIcon } from 'lucide-react';
import { useLayoutEffect, useRef, type ReactNode, type SVGProps } from 'react';
import type { MapNode } from '../api.ts';
import { LABEL_H, NODE_H, NODE_W, type Layout } from '../lib/sysmap.ts';

export const ICON: Record<string, LucideIcon> = { service: Server, datastore: Database, external: Globe };

/** The frame both maps draw in: a box that scrolls both ways, the column titles, the arrowhead and a node kept in view. */
export function MapCanvas({ lay, label, keep, onBackground, className, children }: { lay: Layout; label: string; keep?: string; onBackground?: () => void; className?: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  // Only when it is out of sight, and at once: the box scrolls, never the page.
  useLayoutEffect(() => {
    const b = box.current, p = lay.nodes.find((n) => n.node.id === keep);
    if (!b || !p) return;
    const left = p.x < b.scrollLeft || p.x + NODE_W > b.scrollLeft + b.clientWidth ? p.x - (b.clientWidth - NODE_W) / 2 : b.scrollLeft;
    const top = p.y < b.scrollTop || p.y + NODE_H > b.scrollTop + b.clientHeight ? p.y - (b.clientHeight - NODE_H) / 2 : b.scrollTop;
    b.scrollTo(left, top);
  }, [keep, lay]);
  return (
    <div className={`mapcanvas${className ? ` ${className}` : ''}`} ref={box} onClick={(e) => { if (!(e.target as Element).closest('[role="button"]')) onBackground?.(); }}
      onScroll={(e) => { const b = e.currentTarget; b.style.setProperty('--gx', `${-b.scrollLeft / 2}px`); b.style.setProperty('--gy', `${-b.scrollTop / 2}px`); }}>
      <svg className="sysmap" width={lay.width} height={lay.height} role="group" aria-label={label}>
        <defs>{([['arrow', 'var(--ink-3)'], ['arrow-err', 'var(--err)'], ['arrow-acc', 'var(--accent)']] as const).map(([id, fill]) => (
          <marker key={id} id={id} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8" fill={fill} /></marker>
        ))}</defs>
        <g aria-hidden="true">{lay.columns.map((c) => <text key={c.x} className="col-h" x={c.x} y={24}>{c.title}</text>)}</g>
        {children}
      </svg>
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
