/** The side menu of an environment: its own sections, shared by the environment's sheet and its databases, queues, storage and variables. */
import { ArrowLeftRight, Container, Database, HardDrive, KeyRound, Mail, Radio } from 'lucide-react';
import { useApi, type EnvSummary, type RunInfo } from '../api.ts';
import { ENV_STATE } from '../lib/es.ts';
import { href } from '../lib/route.ts';
import { inProgress } from '../lib/service.ts';
import { useScope } from '../lib/scope.ts';

/** The live session open on each env, as last read: the next screen's menu keeps it while it asks again. */
const seen = new Map<string, string | undefined>();
/** The env of each live session the menu has named: the session's page declares that menu before its own data arrives. */
export const envOfSession = new Map<string, string>();

/** `session`: the live session that is the screen (open or saved); an open one on the env is a section on every screen of it */
export function EnvScope({ env, active, session }: { env: string; active: string; session?: string }) {
  const envs = useApi<EnvSummary[]>('/api/envs');
  const e = envs.data?.find((x) => x.env === env);
  const running = useApi<RunInfo[]>('/api/runs?running=1');
  const open = running.data ? inProgress(running.data).find((r) => r.kind === 'session' && r.env === env)?.id : seen.get(env);
  if (running.data) seen.set(env, open);
  const live = session ?? open;
  if (live) envOfSession.set(live, env);
  // The menu is the env's from the first frame: its name is in the address; its state fills in when the list arrives. Waiting
  // for the list showed the general menu for a moment on every move between an env's screens.
  useScope(envs.data && !e ? null : {
    back: { label: 'Todos los entornos', to: href('envs') },
    card: { icon: Container, kind: /^f-/.test(env) ? 'Entorno de un flujo' : 'Entorno', title: env, sub: !e ? undefined : e.op && !e.op.done ? (e.op.kind === 'up' ? 'Levantando' : 'Destruyendo') : ENV_STATE[e.state] },
    sections: [
      { key: 'state', label: 'Estado y servicios', to: href('envs', env), icon: Container },
      { key: 'data', label: 'Bases de datos', to: href('data', env), icon: Database },
      { key: 'queues', label: 'Colas', to: href('queues', env), icon: ArrowLeftRight },
      { key: 'storage', label: 'Almacenamiento', to: href('storage', env), icon: HardDrive },
      { key: 'mail', label: 'Correo y mensajes', to: href('mail', env), icon: Mail },
      { key: 'vars', label: 'Variables y secretos', to: href('vars', env), icon: KeyRound },
      ...(live ? [{ key: 'live', label: `Sesión ${live} en vivo`, to: href('live', live), icon: Radio }] : []),
    ],
    active,
  });
  return null;
}
