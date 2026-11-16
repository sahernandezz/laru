/**
 * «Mapa y servicios»: the system map on top and, below it, always one panel: every component, or the selected
 * one's sheet. The canvas is shared with the flow map: a box that scrolls both ways and keeps a node in view.
 */
import { ChevronRight, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { indexMap, useApi, type EnvSummary, type FlowInfo, type Indexed, type KnowledgeData, type MapNode, type Seen } from '../api.ts';
import { EdgeLabel, ICON, MapCanvas, NodeBox } from '../components/MapCanvas.tsx';
import { Origin, Segmented } from '../components/ui.tsx';
import { KIND, pieceLabel, plural } from '../lib/es.ts';
import { href } from '../lib/route.ts';
import { ACTORS, edgesOf, groupsOf, homeOf, layout, NO_GROUP, SHARED, type EdgeKind } from '../lib/sysmap.ts';
import { ServiceEnvMap } from '../components/EnvMap.tsx';
import { RunningEnvs } from '../components/RunningEnvs.tsx';
import { Components, NodeSheet, through } from './Service.tsx';
import { tr } from '../lib/i18n.ts';

const KIND_LABEL: Record<EdgeKind, string> = { call: tr('Llamadas HTTP'), event: tr('Eventos'), store: tr('Almacenes y externos') };

export function MapView({ g: whole, selected, tabArg }: { g: Indexed; selected?: string; tabArg?: string }) {
  const flows = useApi<FlowInfo[]>('/api/flows');
  const envs = useApi<EnvSummary[]>('/api/envs');
  const kd = useApi<KnowledgeData>('/api/knowledge');
  const seen = useApi<Seen>('/api/seen');
  const [show, setShow] = useState<Record<EdgeKind, boolean>>({ call: true, event: true, store: true });
  const [derived, setDerived] = useState(true);
  // With several projects: one at a time or all (in the client; the layout is the same function).
  const projects = whole.map.repos.map((r) => r.name);
  const several = projects.length > 1;
  const [project, setProject] = useState('');
  const g = useMemo(() => {
    if (!project) return whole;
    const keep = whole.map.nodes.filter((n) => !n.repo || n.repo === project);
    const ids = new Set(keep.map((n) => n.id));
    return indexMap({ ...whole.map, nodes: keep, facts: whole.map.facts.filter((f) => ids.has(f.s) && ids.has(f.o)) });
  }, [whole, project]);
  const all = useMemo(() => edgesOf(g), [g]);
  const lay = useMemo(() => layout(g, all, { bands: true }), [g, all]);
  /** an edge from one application to another, when the map is split by application: where one depends on the other */
  const apps = useMemo(() => groupsOf(g, all).of, [g, all]);
  const xapp = (e: { from: string; to: string }) => {
    const a = apps.get(e.from), b = apps.get(e.to), named = (x?: string) => Boolean(x) && ![ACTORS, NO_GROUP, SHARED].includes(x!);
    return lay.bands.length > 0 && named(a) && named(b) && a !== b;
  };
  /** an edge between two projects: drawn with a long dash, never told apart by colour alone */
  const across = (e: { from: string; to: string }) => { const a = g.nodes.get(e.from)?.repo, b = g.nodes.get(e.to)?.repo; return Boolean(a && b && a !== b); };
  const edges = all.filter((e) => show[e.kind] && (derived || e.origin !== 'derived'));
  const shown = lay.edges.filter((e) => edges.some((x) => x.id === e.id));
  // A table or a topic is shown by its store, an endpoint by its service, each at that one's address.
  const home = selected && homeOf(g, selected);
  const sel = home && ICON[g.nodes.get(home)?.type ?? ''] ? g.nodes.get(home) : undefined;
  const near = new Set(sel ? edges.filter((e) => e.from === sel.id || e.to === sel.id).flatMap((e) => [e.from, e.to]) : []);

  // Opened from «Componentes», the focus goes to the sheet; closed, it goes back to the node on the map.
  const heading = useRef<HTMLHeadingElement>(null);
  const toSheet = useRef(false);
  useEffect(() => { if (toSheet.current && sel) heading.current?.focus(); toSheet.current = false; }, [sel]);
  const select = (id: string) => { location.hash = href('map', id); };
  const close = () => {
    if (!sel) return;
    location.hash = href('map');
    document.querySelector<SVGElement>(`.sysmap [data-node="${CSS.escape(sel.id)}"]`)?.focus();
  };

  const flowList = flows.data;
  const count = (t: string) => g.map.nodes.filter((n) => n.type === t).length;
  const nodeName = (n: MapNode) => {
    const fl = flowList && through(flowList, n.id);
    const bad = fl?.filter((f) => f.last?.status === 'failed').length ?? 0;
    return [n.name, `${pieceLabel(n.type).toLowerCase()} ${KIND[n.kind ?? ''] ?? n.kind ?? ''}`.trim(), n.type === 'service' && plural(g.out(n.id).filter((f) => f.p === 'exposes').length, tr('endpoint'), tr('endpoints')),
      fl && plural(fl.length, tr('flujo'), tr('flujos')), bad && (bad === 1 ? tr('{bad} falla', { bad }) : tr('{bad} fallan', { bad }))].filter(Boolean).join(', ');
  };

  return (
    <div className="page wide map-page">
      {selected ? (
        <div className="map-top">
          <nav className="crumbs" aria-label={tr('Ruta')}><a href={href('map')}>{tr('Mapa y servicios')}</a><ChevronRight /><span>{sel?.name ?? selected}</span></nav>
          <button className="btn sm" onClick={close}><X />{tr('Cerrar')}</button>
        </div>
      ) : (
        <div className="head">
          <div><h1>{tr('Mapa y servicios')}</h1><p>{tr('Lo que se despliega y con qué habla cada servicio. Elige una pieza para ver su ficha.')}</p></div>
          <div className="actions faint map-sum">
            {plural(count('service'), tr('servicio'), tr('servicios'))} · {plural(count('datastore'), tr('almacén'), tr('almacenes'))} · {plural(count('external'), tr('externo'), tr('externos'))} · {g.map.repos.length > 2
              ? <span title={g.map.repos.map((r) => `${r.name}@${r.commit.slice(0, 7)}`).join('\n')}>{tr('leído de')}{' '}{plural(g.map.repos.length, tr('proyecto'), tr('proyectos'))}</span>
              : <>{tr('leído de')}{' '}{g.map.repos.map((r) => `${r.name}@${r.commit.slice(0, 7)}`).join(', ')}</>}
          </div>
        </div>
      )}

      {!selected && <RunningEnvs envs={envs.data} g={g} />}
      <section className="panel map-panel">
        <div className="toolbar">
          {(Object.keys(KIND_LABEL) as EdgeKind[]).map((k) => (
            <button key={k} className="btn sm" aria-pressed={show[k]} style={{ opacity: show[k] ? 1 : 0.5 }} onClick={() => setShow((s) => ({ ...s, [k]: !s[k] }))}>
              <svg className="lg" width="22" height="8" aria-hidden="true"><path d="M1 4H21" className={`e ${k}`} style={{ stroke: 'currentColor', strokeWidth: 1.5, strokeDasharray: k === 'event' ? '5 4' : k === 'store' ? '1.5 3.5' : undefined }} /></svg>{KIND_LABEL[k]}
            </button>
          ))}
          <button className="btn sm" aria-pressed={derived} style={{ opacity: derived ? 1 : 0.5 }} onClick={() => setDerived((d) => !d)}><Origin of="derived" label={false} />{tr('Deducidas')}</button>
          {several && <Segmented label={tr('Proyecto')} value={project} onChange={setProject} options={[{ key: '', label: tr('Todos') }, ...projects.map((p) => ({ key: p, label: p }))]} />}
        </div>
        <MapCanvas lay={lay} label={tr('Mapa del sistema, {plural}', { plural: plural(lay.nodes.length, tr('pieza'), tr('piezas')) })} keep={sel?.id} onBackground={close} className={sel ? 'with-sheet' : undefined}>
          {/* Edges have their list equivalents: «Componentes» and each sheet's «Conexiones». */}
          <g aria-hidden="true">
            {shown.map((e) => {
              const hot = sel && (e.from === sel.id || e.to === sel.id);
              return (
                <path key={e.id} d={e.d} className={`e ${e.kind}${e.origin === 'derived' ? ' derived' : ''}${across(e) ? ' across' : ''}${xapp(e) ? ' xapp' : ''}${hot ? ' hot' : sel ? ' dim' : ''}`} markerEnd="url(#arrow)"><title>{`${g.nodes.get(e.from)?.name} → ${g.nodes.get(e.to)?.name}: ${e.kind === 'store' ? tr('usa') : e.label} (${e.origin === 'derived' ? tr('deducido') : tr('extraído')}${across(e) ? tr(', entre proyectos') : ''}${xapp(e) ? tr(', de {get} a {get2}', { get: apps.get(e.from), get2: apps.get(e.to) }) : ''})`}</title></path>
              );
            })}
            {/* over the lines, each stopping its own */}
            {shown.filter((e) => sel && e.kind !== 'store' && (e.from === sel.id || e.to === sel.id)).map((e) => <EdgeLabel key={e.id} e={e} className="hot" />)}
          </g>
          {lay.nodes.map(({ node, x, y }) => (
            <NodeBox key={node.id} node={node} x={x} y={y} sub={`${node.type === 'service' ? `${node.kind}, ${g.out(node.id).filter((f) => f.p === 'exposes').length} endpoints` : KIND[node.kind ?? ''] ?? node.kind ?? ''}${several && node.repo ? ` · ${node.repo}` : ''}`}
              className={sel?.id === node.id ? 'sel' : sel && !near.has(node.id) ? 'dim' : ''} role="button" tabIndex={0} aria-pressed={sel?.id === node.id} aria-label={nodeName(node)}
              onClick={() => select(node.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(node.id); } }} />
          ))}
        </MapCanvas>
        <div className="legend"><span>{tr('Elige una pieza para ver su ficha y sus conexiones')}</span><span>{tr('Las líneas atenuadas son deducidas, no leídas literalmente del código')}</span>{several && <span><svg className="lg" width="22" height="8" aria-hidden="true"><path d="M1 4H21" style={{ stroke: 'currentColor', strokeWidth: 1.5, strokeDasharray: '8 3' }} /></svg>{' '}{tr('entre proyectos')}</span>}{lay.bands.length > 0 && <span><svg className="lg" width="22" height="8" aria-hidden="true"><path d="M1 4H21" style={{ stroke: 'var(--run)', strokeWidth: 2.5 }} /></svg>{' '}{tr('de una aplicación a otra')}</span>}</div>
      </section>

      {flows.error && <div className="notice" role="alert">{tr('No se pudo leer el historial de runs:')}{' '}{flows.error}</div>}
      {sel ? <NodeSheet key={sel.id} tabArg={tabArg} g={g} node={sel} flows={flowList} k={kd.data} seen={seen} reload={kd.reload} headRef={heading} close={close} />
        : selected ? <section className="panel"><div className="empty">{tr('No hay ningún «')}{selected}{tr('» en el mapa.')}{' '}<a className="rowlink" href={href('map')}>{tr('Ver el mapa')}</a></div></section>
        : <>
          <section className="panel" style={{ marginBottom: 16 }}><header><h3>{tr('Servicios por entorno')}</h3><div className="meta">{tr('Dónde corre cada servicio ·')}{' '}<a className="more" href={href('envs')}>{tr('Gestionar entornos')}</a></div></header><ServiceEnvMap g={whole} envs={envs.data} /></section>
          <Components g={g} flows={flowList} k={kd.data} onOpen={() => { toSheet.current = true; }} />
        </>}
    </div>
  );
}
