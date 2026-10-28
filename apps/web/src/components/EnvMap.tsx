/**
 * Services against environments: one row per service or store of the map, one column per environment (the project's and
 * each flow's own), and in each cell whether that service is running there. It answers «where does this run, and where
 * is it not up» at a glance, and every name is a way into its sheet.
 */
import { Database, Globe, Server } from 'lucide-react';
import { type EnvSummary, type Indexed } from '../api.ts';
import { href } from '../lib/route.ts';
import { appsOf, groupsOf } from '../lib/sysmap.ts';
import { Dot, type DotState } from './ui.tsx';

const HEALTH: Record<string, [DotState, string]> = {
  healthy: ['ok', 'sano'], running: ['ok', 'corriendo'], host: ['ok', 'en tu máquina'], done: ['ok', 'terminó'],
  starting: ['run', 'arrancando'], waiting: ['run', 'esperando'], unhealthy: ['err', 'enfermo'], exited: ['err', 'caído'], oom: ['err', 'sin memoria'], absent: ['idle', 'sin levantar'],
};
const norm = (x: string) => x.toLowerCase().replace(/^(svc|ds|ext):/, '').replace(/-real$/, '');

export function ServiceEnvMap({ g, envs, limit }: { g: Indexed | null; envs?: EnvSummary[]; limit?: number }) {
  if (!g) return <div className="empty">Sin mapa todavía: pulsa «Releer el código» en <a className="rowlink" href={href('repos')}>Proyectos</a>.</div>;
  const apps = appsOf(g), order = apps ? groupsOf(g, []).order : [];
  // with several applications, each one's services together, in the order laru.yaml lists them
  const rows = g.map.nodes.filter((n) => n.type === 'service' || n.type === 'datastore').sort((a, b) => (apps ? order.indexOf(apps.get(a.id)!) - order.indexOf(apps.get(b.id)!) : 0));
  const cols = [...(envs ?? [])].sort((a, b) => Number(/^f-/.test(a.env)) - Number(/^f-/.test(b.env)) || a.env.localeCompare(b.env));
  if (!rows.length) return <div className="empty">El mapa no tiene servicios todavía.</div>;
  if (!cols.length) return <div className="empty">Ningún entorno todavía: <code>laru env init</code>.</div>;
  const shown = limit ? rows.slice(0, limit) : rows;
  return (
    <div className="scroll-x">
      <table className="t envmap">
        <thead><tr><th>Servicio</th>{apps && <th>Aplicativo</th>}{cols.map((e) => (
          <th key={e.env} className="c"><a className="rowlink mono" href={href('envs', e.env)}>{e.env}</a><div className="faint sub">{/^f-/.test(e.env) ? 'de un flujo' : e.state === 'ready' ? 'listo' : e.state === 'starting' ? 'levantándose' : 'parado'}</div></th>
        ))}</tr></thead>
        <tbody>{shown.map((n) => {
          const I = n.type === 'datastore' ? Database : n.type === 'external' ? Globe : Server;
          return (
            <tr key={n.id}>
              <td><a className="rowlink" href={href('map', n.id)}><I size={13} style={{ marginRight: 6, verticalAlign: -2 }} />{n.name}</a><span className="faint sub"> {n.type === 'datastore' ? n.kind : ''}</span></td>
              {apps && <td>{apps.get(n.id)}</td>}
              {cols.map((e) => {
                const s = e.services.find((x) => norm(x.service) === norm(n.name) || norm(x.compose) === norm(n.name));
                if (!s) return <td key={e.env} className="c faint" title="No forma parte de este entorno">—</td>;
                const [dot, word] = HEALTH[s.health] ?? ['idle', s.health];
                return <td key={e.env} className="c" title={`${n.name} en ${e.env}: ${word}`}><Dot state={dot} /><span className="sr-only">{word}</span></td>;
              })}
            </tr>
          );
        })}</tbody>
      </table>
      {limit && rows.length > limit && <p className="faint" style={{ padding: '8px 16px' }}>y {rows.length - limit} más en <a className="rowlink" href={href('map')}>Mapa y servicios</a></p>}
    </div>
  );
}
