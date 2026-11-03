/** The data explorers on a flow's own environment (`#/data/f-<flow>`): a line says whose environment this is (the menu is the flow's, lib/menu.ts). */
import { useApi, type FlowEnvData } from '../api.ts';
import { href, pageOf, partsOf } from '../lib/route.ts';
import { flowOfEnv } from '../lib/useEnvs.ts';

export function FromFlow() {
  const de = flowOfEnv();
  const env = partsOf(location.hash)[1];
  const fe = useApi<FlowEnvData>(de ? `/api/flow-env?flow=${encodeURIComponent(de.replace(/^flow:/, ''))}` : null);
  if (!de) return null;
  const slug = de.replace(/^flow:/, '');
  return (
    <>
      <div className="from-flow">
        Los datos de <a className="rowlink" href={pageOf(de)}>{slug}</a> son solo de su entorno <a className="rowlink mono" href={href('envs', env)}>{env}</a>: cada flujo corre aislado, con sus propias bases, colas, ficheros y variables.
        {fe.data && !fe.data.exists && <> Aún no está aprovisionado: <a className="rowlink" href={href('docs', de, 't', 'live')}>aprovisionarlo</a>.</>}
      </div>
    </>
  );
}
