/** «Información del sistema»: this machine as Laru sees it, and what the doctor checks on it. Where each thing lives is «Archivos locales». */
import { CircleX, FolderOpen, RefreshCw } from 'lucide-react';
import { useApi, type Check, type MachineInfo } from '../api.ts';
import { Status } from '../components/ui.tsx';
import { checkName, checkNote } from '../lib/es.ts';
import { HOME, href } from '../lib/route.ts';
import { plural } from '../lib/es.ts';
import { tr, LOCALE } from '../lib/i18n.ts';

const gib = (b: number) => `${(b / 2 ** 30).toLocaleString(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} GiB`;

export function Settings() {
  const doctor = useApi<{ checks: Check[] }>('/api/doctor');
  const machine = useApi<MachineInfo>('/api/machine');
  const m = machine.data;
  const checks = doctor.data?.checks ?? [];
  const failing = checks.filter((c) => !c.ok).length;

  return (
    <div className="page">
      <div className="head"><div><h1>{tr('Información del sistema')}</h1><p>{tr('Lo que esta máquina necesita para levantar entornos. Dónde guarda Laru cada cosa, con su tamaño:')}{' '}<a className="rowlink" href={href('files')}><FolderOpen size={13} aria-hidden="true" style={{ verticalAlign: -2 }} />{' '}{tr('Archivos locales')}</a>{tr('. Cuántos entornos pueden correr a la vez:')}{' '}<a className="rowlink" href={HOME}>{tr('Esta máquina')}</a>.</p></div></div>

      <section className="panel block" aria-labelledby="machine-h">
        <header><h3 id="machine-h">{tr('Esta máquina')}</h3></header>
        {!m ? <div className="body" style={{ display: 'grid', gap: 14 }}>{[60, 45, 70].map((w) => <div key={w} className="sk" style={{ height: 14, width: `${w}%` }} />)}</div> : (
          <dl className="sysinfo">
            <div><dt>Laru</dt><dd className="mono">{m.version}{' '}{tr('· escucha en 127.0.0.1:')}{m.port}</dd></div>
            <div><dt>{tr('Workspaces')}</dt><dd>{plural(m.workspaces, tr('registrado'), tr('registrados'))}</dd></div>
            <div><dt>Docker</dt><dd>{m.docker ? tr('Motor {docker}', { docker: m.docker }) : tr('No responde')}</dd></div>
            <div><dt>{tr('Recursos')}</dt><dd>{m.cpus ?? '—'}{' '}{tr('CPU ·')}{' '}{m.memBytes ? gib(m.memBytes) : '—'}{' '}{tr('de memoria ·')}{' '}{m.maxEnvs ? tr('hasta {plural} a la vez', { plural: plural(m.maxEnvs, tr('entorno'), tr('entornos')) }) : tr('entornos a la vez sin límite')}</dd></div>
            <div><dt>{tr('En marcha')}</dt><dd>{m.running.length ? m.running.map((r) => `${r.title ?? r.app}/${r.env}`).join(', ') : tr('ningún entorno')}</dd></div>
            <div><dt>{tr('Datos de Laru')}</dt><dd className="mono">{m.home.path}</dd></div>
          </dl>
        )}
      </section>

      <section className="panel block" aria-labelledby="doctor-h">
        <header>
          <h3 id="doctor-h">{tr('Diagnóstico')}</h3>
          <div className="meta">
            {doctor.data && <span aria-live="polite">{failing ? tr('{failing} por revisar', { failing }) : tr('Todo correcto')}</span>}
            <button className="btn sm" disabled={doctor.loading} onClick={doctor.reload}><RefreshCw className={doctor.loading ? 'spin' : undefined} />{tr('Repetir')}</button>
          </div>
        </header>
        {doctor.error ? <div className="notice" role="alert" style={{ margin: 16 }}><CircleX />{doctor.error}</div> : !doctor.data ? (
          <div className="body" style={{ display: 'grid', gap: 14 }}>{[70, 55, 80, 62].map((w) => <div key={w} className="sk" style={{ height: 14, width: `${w}%` }} />)}</div>
        ) : (
          <div className="scroll-x">
            <table className="t">
              <thead><tr><th>{tr('Comprobación')}</th><th>{tr('Estado')}</th><th>{tr('Detalle')}</th></tr></thead>
              <tbody>
                {checks.map((c) => (
                  <tr key={c.name}>
                    <td style={{ fontWeight: 500 }}>{checkName(c.name)}</td>
                    <td><Status state={c.ok ? 'ok' : 'err'}>{c.ok ? tr('Correcto') : tr('Por revisar')}</Status></td>
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
