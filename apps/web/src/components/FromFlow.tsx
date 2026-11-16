/**
 * Over every data explorer (`#/data/<env>`): a band that says what the screen shows. On a run's recording
 * (`?run=<id>&flujo=<slug>`), what that run left, with the env off, and the way to the env live; live, the env's data
 * now, and where a flow's recorded ones are.
 */
import { History, Radio } from 'lucide-react';
import { recordedFlow, useApi, useRecorded, type FlowEnvData } from '../api.ts';
import { ago } from '../lib/es.ts';
import { envDataHref, href, pageOf, partsOf } from '../lib/route.ts';
import { flowOfEnv } from '../lib/useEnvs.ts';
import { tr } from '../lib/i18n.ts';

export function FromFlow() {
  const run = useRecorded();
  const [screen, env] = partsOf(location.hash);
  return run ? <Recorded run={run} screen={screen} env={env} /> : <Live screen={screen} env={env} />;
}

function Recorded({ run, screen, env }: { run: string; screen: string; env: string }) {
  const flow = recordedFlow();
  const r = useApi<{ result?: string; recording?: { at: string; cut?: string[]; masked?: boolean; withheld?: number } | null }>(`/api/run/state?id=${run}${flow ? `&flow=${encodeURIComponent(flow)}` : ''}`);
  const said = r.data?.result === 'passed' ? tr(', que pasó') : r.data?.result === 'failed' ? tr(', que falló') : '';
  return (
    <div className="recorded-band" role="note">
      <History size={15} aria-hidden="true" />
      <span><b>{tr('Grabado')}</b>{' '}{tr('al terminar el')}{' '}<a className="rowlink" href={href('runs', run, ...(flow ? [flow] : []))}>run {run}</a>{flow ? <>{' '}{tr('de')}{' '}<a className="rowlink" href={pageOf(`flow:${flow}`)}>{flow}</a></> : null}{said}{r.data?.recording ? `, ${ago(r.data.recording.at)}` : ''}{tr(', en el entorno')}{' '}<span className="mono">{env}</span>{tr('. Es lo que dejó el run: se ve igual con el entorno apagado, y aquí no se cambia nada.')}{cut(r.data?.recording?.cut)}{said2(r.data?.recording)}</span>
      <a className="btn sm" href={envDataHref(screen, env)} title={tr('Los datos del entorno ahora mismo: necesitan el entorno encendido')}><Radio size={14} />{tr('Ver en vivo')}</a>
    </div>
  );
}

/** What passed the recording's limits, said once: those things are seen live. */
const CUT: Record<string, string> = { files: tr('ficheros'), tables: tr('tablas'), collections: tr('colecciones'), keys: tr('claves'), bytes: tr('ficheros grandes'), mails: tr('correos') };
function cut(xs?: string[]) {
  const kinds = [...new Set((xs ?? []).map((x) => CUT[x.split(':')[0]] ?? x))];
  return kinds.length ? tr(' No todo cupo en la grabación ({join}): lo que falta se ve en vivo.', { join: kinds.join(', ') }) : '';
}

/** Whether the recording is masked, and what masking held back. */
function said2(x?: { masked?: boolean; withheld?: number } | null) {
  if (!x) return '';
  if (x.masked === false) return tr(' Sin enmascarar, como el resto de la evidencia del run: el enmascarado está apagado (mask en ~/.laru/config.yaml).');
  return !x.withheld ? tr(' Enmascarado.') : x.withheld === 1 ? tr(' Enmascarado; un fichero que no se puede enmascarar (un PDF, un binario, el original de un correo o un adjunto) no se grabó.')
    : tr(' Enmascarado; {n} ficheros que no se pueden enmascarar (un PDF, un binario, el original de un correo o un adjunto) no se grabaron.', { n: x.withheld });
}

function Live({ screen, env }: { screen: string; env: string }) {
  const de = flowOfEnv();
  const fe = useApi<FlowEnvData>(de ? `/api/flow-env?flow=${encodeURIComponent(de.replace(/^flow:/, ''))}` : null);
  const slug = de?.replace(/^flow:/, '');
  return (
    <div className="live-banner" role="note">
      <Radio size={15} aria-hidden="true" />
      <span><b>{tr('En vivo')}</b>{tr(': los datos del entorno')}{' '}<a className="rowlink mono" href={href('envs', env)}>{env}</a>{' '}{tr('ahora mismo; se leen con el entorno encendido y cambian mientras lo usas.')}{slug && <>{' '}{tr('Lo que dejó el último run de')}{' '}<a className="rowlink" href={pageOf(de!)}>{slug}</a>{' '}{tr('está grabado en')}{' '}<a className="rowlink" href={href('flowdata', slug, screen)}>{tr('sus datos')}</a>.</>}
        {fe.data && !fe.data.exists && <>{' '}{tr('Aún no está aprovisionado:')}{' '}<a className="rowlink" href={href('docs', de!, 't', 'live')}>{tr('aprovisionarlo')}</a>.</>}
      </span>
    </div>
  );
}
