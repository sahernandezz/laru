/**
 * «Montar todo el entorno con datos»: the project's environment up and every flow's scenario seeded in it, to walk the
 * whole application by hand. It says, flow by flow, what was put in and who can sign in; the environment is local, so
 * the passwords are shown with the rest.
 */
import { AppWindow, Boxes } from 'lucide-react';
import { openStudio } from '../pages/Live.tsx';
import { useEffect, useRef, useState } from 'react';
import { api, useApi, type EnvSummary, type Mounted } from '../api.ts';
import { plural } from '../lib/es.ts';
import { href, pageOf } from '../lib/route.ts';
import { ActionButton, Dialog, Status, toast } from './ui.tsx';

const WORD = { seeded: ['ok', 'con datos'], 'no-scenario': ['idle', 'sin escenario: parte de lo que haya'], exclusive: ['run', 'exclusivo: necesita el entorno entero'], failed: ['err', 'falló'] } as const;

export function MountAll() {
  const envs = useApi<EnvSummary[]>('/api/envs');
  const own = (envs.data ?? []).filter((e) => !/^f-/.test(e.env));
  const env = own.find((e) => e.state === 'ready')?.env ?? own[0]?.env;
  const op = own.find((e) => e.env === env)?.op;
  const busy = Boolean(op && !op.done);
  const [mounted, setMounted] = useState<Mounted | null>(null);
  const read = () => (env ? api<{ mounted: Mounted | null }>('/api/env/mounted', { method: 'POST', body: { env } }).then((r) => setMounted(r.mounted), () => undefined) : undefined);
  useEffect(() => { void read(); }, [env]); // eslint-disable-line react-hooks/exhaustive-deps
  const [open, setOpen] = useState(false);
  const was = useRef(false);
  // While it works, ask again; when it ends, read what it left (and say if it failed).
  useEffect(() => {
    if (busy) { was.current = true; const t = setInterval(() => envs.reload(), 2500); return () => clearInterval(t); }
    if (was.current) { was.current = false; if (op?.error) toast(`No se pudo montar: ${op.error}`); else void read()?.then(() => setOpen(true)); }
  }, [busy]); // eslint-disable-line react-hooks/exhaustive-deps
  const m = mounted;
  if (!env) return null;
  return (
    <>
      <ActionButton icon={Boxes} primary disabled={busy} title={`Levanta ${env} si está parado y siembra en él el escenario de cada flujo`}
        run={() => api('/api/env/mount', { method: 'POST', body: { env } }).then(() => envs.reload())}>
        {busy ? 'Montando…' : 'Montar todo el entorno con datos'}
      </ActionButton>
      {m && !busy && <button className="btn" onClick={() => setOpen(true)}>Ver lo montado</button>}
      {m && !busy && <ActionButton icon={AppWindow} run={() => openStudio(m.env)}>Abrir en el estudio</ActionButton>}
      {open && m && (
        <Dialog title={`Todo montado en ${m.env}`} onClose={() => setOpen(false)} wide>
          <div className="dlg-body">
            <p className="faint">{plural(m.flows.filter((f) => f.state === 'seeded').length, 'flujo con datos', 'flujos con datos')} de {m.flows.length}. Cada flujo tiene sus propias cuentas y filas: entra en la aplicación con ellas y recórrelo. <button type="button" className="ex-go rowlink" onClick={() => { setOpen(false); void openStudio(m.env).catch((e: Error) => toast(e.message)); }}>Abrirlo en el estudio ›</button></p>
            <div className="scroll-x"><table className="t"><thead><tr><th>Flujo</th><th>Datos</th><th>Quién puede entrar</th></tr></thead><tbody>
              {m.flows.map((f) => (
                <tr key={f.flow}>
                  <td className="wrap"><a className="rowlink" href={pageOf(`flow:${f.flow}`)} onClick={() => setOpen(false)}>{f.title}</a></td>
                  <td className="wrap"><Status state={WORD[f.state][0]}>{WORD[f.state][1]}</Status>{f.error && <div className="faint sub">{f.error}</div>}{f.scenario && <div className="faint mono sub">{f.scenario.replace(/^scn:/, '')}</div>}</td>
                  <td className="wrap mono">{f.identities.length ? f.identities.map((i) => <div key={i.name}>{i.username ?? i.email ?? i.name}{i.password ? ` / ${i.password}` : ''}</div>) : <span className="faint">—</span>}</td>
                </tr>
              ))}
            </tbody></table></div>
          </div>
          <footer><button className="btn primary" data-autofocus onClick={() => setOpen(false)}>Cerrar</button></footer>
        </Dialog>
      )}
    </>
  );
}
