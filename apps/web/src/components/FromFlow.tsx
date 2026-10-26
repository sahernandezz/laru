/** The data explorers on a flow's own environment (`#/data/f-<flow>`) keep that flow's menu, and a line says whose environment this is. */
import { useApi, type FlowEnvData } from '../api.ts';
import { href, pageOf, partsOf } from '../lib/route.ts';
import { flowOfEnv } from '../lib/useEnvs.ts';
import { FlowScope } from './FlowScope.tsx';

export function FromFlow({ screen }: { screen: string }) {
  const de = flowOfEnv();
  const env = partsOf(location.hash)[1];
  const fe = useApi<FlowEnvData>(de ? `/api/flow-env?flow=${encodeURIComponent(de.replace(/^flow:/, ''))}` : null);
  if (!de) return null;
  const slug = de.replace(/^flow:/, '');
  return (
    <>
      <FlowScope id={de} active={screen} />
      <div className="from-flow">
        Los datos de <a className="rowlink" href={pageOf(de)}>{slug}</a> son solo de su entorno <a className="rowlink mono" href={href('envs', env)}>{env}</a>: cada flujo corre aislado, con sus propias bases, colas, ficheros y variables.
        {fe.data && !fe.data.exists && <> Aún no está aprovisionado: <a className="rowlink" href={href('docs', de, 't', 'live')}>aprovisionarlo</a>.</>}
      </div>
    </>
  );
}
