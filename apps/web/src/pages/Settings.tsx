/** «Información del sistema»: this machine as Laru sees it, and what the doctor checks on it. Where each thing lives is «Archivos locales». */
import { CircleX, FolderOpen, RefreshCw } from 'lucide-react';
import { useApi, type Check, type MachineInfo } from '../api.ts';
import { Status } from '../components/ui.tsx';
import { checkName, checkNote } from '../lib/es.ts';
import { HOME, href } from '../lib/route.ts';
import { plural } from '../lib/es.ts';

const gib = (b: number) => `${(b / 2 ** 30).toFixed(1).replace('.', ',')} GiB`;

export function Settings() {
  const doctor = useApi<{ checks: Check[] }>('/api/doctor');
  const machine = useApi<MachineInfo>('/api/machine');
  const m = machine.data;
  const checks = doctor.data?.checks ?? [];
  const failing = checks.filter((c) => !c.ok).length;

  return (
    <div className="page">
      <div className="head"><div><h1>Información del sistema</h1><p>Lo que esta máquina necesita para levantar entornos. Dónde guarda Laru cada cosa, con su tamaño: <a className="rowlink" href={href('files')}><FolderOpen size={13} aria-hidden="true" style={{ verticalAlign: -2 }} /> Archivos locales</a>. Cuántos entornos pueden correr a la vez: <a className="rowlink" href={HOME}>Esta máquina</a>.</p></div></div>

      <section className="panel block" aria-labelledby="machine-h">
        <header><h3 id="machine-h">Esta máquina</h3></header>
        {!m ? <div className="body" style={{ display: 'grid', gap: 14 }}>{[60, 45, 70].map((w) => <div key={w} className="sk" style={{ height: 14, width: `${w}%` }} />)}</div> : (
          <dl className="sysinfo">
            <div><dt>Laru</dt><dd className="mono">{m.version} · escucha en 127.0.0.1:{m.port}</dd></div>
            <div><dt>Workspaces</dt><dd>{plural(m.workspaces, 'registrado', 'registrados')}</dd></div>
            <div><dt>Docker</dt><dd>{m.docker ? `Motor ${m.docker}` : 'No responde'}</dd></div>
            <div><dt>Recursos</dt><dd>{m.cpus ?? '—'} CPU · {m.memBytes ? gib(m.memBytes) : '—'} de memoria · hasta {plural(m.maxEnvs, 'entorno', 'entornos')} a la vez</dd></div>
            <div><dt>En marcha</dt><dd>{m.running.length ? m.running.map((r) => `${r.title ?? r.app}/${r.env}`).join(', ') : 'ningún entorno'}</dd></div>
            <div><dt>Datos de Laru</dt><dd className="mono">{m.home.path}</dd></div>
          </dl>
        )}
      </section>

      <section className="panel block" aria-labelledby="doctor-h">
        <header>
          <h3 id="doctor-h">Diagnóstico</h3>
          <div className="meta">
            {doctor.data && <span aria-live="polite">{failing ? `${failing} por revisar` : 'Todo correcto'}</span>}
            <button className="btn sm" disabled={doctor.loading} onClick={doctor.reload}><RefreshCw className={doctor.loading ? 'spin' : undefined} />Repetir</button>
          </div>
        </header>
        {doctor.error ? <div className="notice" role="alert" style={{ margin: 16 }}><CircleX />{doctor.error}</div> : !doctor.data ? (
          <div className="body" style={{ display: 'grid', gap: 14 }}>{[70, 55, 80, 62].map((w) => <div key={w} className="sk" style={{ height: 14, width: `${w}%` }} />)}</div>
        ) : (
          <div className="scroll-x">
            <table className="t">
              <thead><tr><th>Comprobación</th><th>Estado</th><th>Detalle</th></tr></thead>
              <tbody>
                {checks.map((c) => (
                  <tr key={c.name}>
                    <td style={{ fontWeight: 500 }}>{checkName(c.name)}</td>
                    <td><Status state={c.ok ? 'ok' : 'err'}>{c.ok ? 'Correcto' : 'Por revisar'}</Status></td>
                    <td className="wrap muted">{checkNote(c.note)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

    </div>
  );
}
