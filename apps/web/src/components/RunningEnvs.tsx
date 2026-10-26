/**
 * The environments that are up, each with its way in: «Abrir» goes to the app's front in that environment, and every
 * port it listens on is a link (HTTP, through the entrance) or a copyable address (data stores and raw TCP).
 */
import { ExternalLink } from 'lucide-react';
import type { EnvSummary, Indexed } from '../api.ts';
import { href } from '../lib/route.ts';
import { CopyButton, Dot } from './ui.tsx';
import { STATE_DOT } from '../pages/Envs.tsx';

const portOf = (url: string) => /:(\d+)\/?$/.exec(url)?.[1];
/** The address a person opens first: the service the map calls «web», else the first HTTP one. */
const front = (e: EnvSummary, g: Indexed | null) => {
  const web = new Set((g?.map.nodes ?? []).filter((n) => n.type === 'service' && n.kind === 'web').map((n) => n.name));
  const http = e.addresses.filter((a) => a.kind === 'http');
  return http.find((a) => web.has(a.service)) ?? http.find((a) => a.service === 'frontend') ?? http[0];
};

export function RunningEnvs({ envs, g }: { envs?: EnvSummary[]; g: Indexed | null }) {
  const up = (envs ?? []).filter((e) => e.state === 'ready' || e.state === 'starting').sort((a, b) => Number(/^f-/.test(a.env)) - Number(/^f-/.test(b.env)) || a.env.localeCompare(b.env));
  if (!up.length) return null;
  return (
    <section className="panel running" aria-labelledby="running-h">
      <header><h3 id="running-h">Entornos en marcha</h3><div className="meta">Cada puerto es un enlace · <a className="more" href={href('envs')}>Gestionar entornos</a></div></header>
      <div className="running-list">
        {up.map((e) => {
          const open = front(e, g), flow = /^f-/.test(e.env);
          return (
            <div key={e.env} className="running-env">
              <div className="running-head">
                <Dot state={STATE_DOT[e.state]} />
                <a className="rowlink mono" href={href('envs', e.env)}>{e.env}</a>
                <span className="faint">{flow ? 'de un flujo' : e.state === 'ready' ? 'listo' : 'levantándose'}</span>
                {open && <a className="btn sm primary" href={open.url} target="_blank" rel="noreferrer"><ExternalLink />Abrir {open.service}</a>}
              </div>
              <ul className="ports">
                {e.addresses.map((a) => (
                  <li key={a.url + a.service}>
                    <span className="svc">{a.kind === 'http' ? new URL(a.url).hostname.split('.')[0] : a.service}</span>
                    {a.kind === 'http'
                      ? <a className="mono" href={a.url} target="_blank" rel="noreferrer" title={a.url}>:{portOf(a.url) ?? '80'}<span className="sr-only"> {a.service} (se abre en otra pestaña)</span></a>
                      : <><code title={a.url}>:{portOf(a.url) ?? a.url}</code><CopyButton value={a.url} label={`Copiar la dirección de ${a.service}`} /></>}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}
