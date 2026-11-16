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
import { tr } from '../lib/i18n.ts';

const HEALTH: Record<string, [DotState, string]> = {
  healthy: ['ok', tr('sano')], running: ['ok', tr('corriendo')], host: ['ok', tr('en tu máquina')], done: ['ok', tr('terminó')],
  starting: ['run', tr('arrancando')], waiting: ['run', tr('esperando')], unhealthy: ['err', tr('enfermo')], exited: ['err', tr('caído')], oom: ['err', tr('sin memoria')], absent: ['idle', tr('sin levantar')],
};
const norm = (x: string) => x.toLowerCase().replace(/^(svc|ds|ext):/, '').replace(/-real$/, '');

export function ServiceEnvMap({ g, envs, limit }: { g: Indexed | null; envs?: EnvSummary[]; limit?: number }) {
  if (!g) return <div className="empty">{tr('Sin mapa todavía: pulsa «Releer el código» en')}{' '}<a className="rowlink" href={href('repos')}>{tr('Proyectos')}</a>.</div>;
  const apps = appsOf(g), order = apps ? groupsOf(g, []).order : [];
  // with several applications, each one's services together, in the order laru.yaml lists them
  const rows = g.map.nodes.filter((n) => n.type === 'service' || n.type === 'datastore').sort((a, b) => (apps ? order.indexOf(apps.get(a.id)!) - order.indexOf(apps.get(b.id)!) : 0));
  const cols = [...(envs ?? [])].sort((a, b) => Number(/^f-/.test(a.env)) - Number(/^f-/.test(b.env)) || a.env.localeCompare(b.env));
  if (!rows.length) return <div className="empty">{tr('El mapa no tiene servicios todavía.')}</div>;
  if (!cols.length) return <div className="empty">{tr('Ningún entorno todavía:')}{' '}<code>laru env init</code>.</div>;
  const shown = limit ? rows.slice(0, limit) : rows;
  return (
    <div className="scroll-x">
      <table className="t envmap">
        <thead><tr><th>{tr('Servicio')}</th>{apps && <th>{tr('Aplicativo')}</th>}{cols.map((e) => (
          <th key={e.env} className="c"><a className="rowlink mono" href={href('envs', e.env)}>{e.env}</a><div className="faint sub">{/^f-/.test(e.env) ? tr('de un flujo') : e.state === 'ready' ? tr('listo') : e.state === 'starting' ? tr('levantándose') : tr('parado')}</div></th>
        ))}</tr></thead>
        <tbody>{shown.map((n) => {
          const I = n.type === 'datastore' ? Database : n.type === 'external' ? Globe : Server;
          return (
            <tr key={n.id}>
              <td><a className="rowlink" href={href('map', n.id)}><I size={13} style={{ marginRight: 6, verticalAlign: -2 }} />{n.name}</a><span className="faint sub"> {n.type === 'datastore' ? n.kind : ''}</span></td>
              {apps && <td>{apps.get(n.id)}</td>}
              {cols.map((e) => {
                const s = e.services.find((x) => norm(x.service) === norm(n.name) || norm(x.compose) === norm(n.name));
                if (!s) return <td key={e.env} className="c faint" title={tr('No forma parte de este entorno')}>—</td>;
                const [dot, word] = HEALTH[s.health] ?? ['idle', s.health];
                return <td key={e.env} className="c" title={tr('{name} en {env}: {word}', { name: n.name, env: e.env, word })}><Dot state={dot} /><span className="sr-only">{word}</span></td>;
              })}
            </tr>
          );
        })}</tbody>
      </table>
      {limit && rows.length > limit && <p className="faint" style={{ padding: '8px 16px' }}>{tr('y')}{' '}{rows.length - limit}{' '}{tr('más en')}{' '}<a className="rowlink" href={href('map')}>{tr('Mapa y servicios')}</a></p>}
    </div>
  );
}
