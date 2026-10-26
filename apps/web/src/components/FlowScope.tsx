/**
 * The side menu of a flow: its own sections, and under them the data of its execution (databases, queues, storage,
 * mail and texts, variables). The flow's sheet and those screens declare the same menu, so going from one to the other keeps the
 * menu where it was and «atrás» goes back one step.
 */
import { ArrowLeftRight, BookText, Database, FileText, HardDrive, KeyRound, Mail, Radio, Workflow } from 'lucide-react';
import { useApi, type DocPiece, type EnvSummary, type FlowEnvData, type FlowInfo, type KnowledgeData } from '../api.ts';
import { lastWord, flowDot } from '../pages/Flows.tsx';
import { href } from '../lib/route.ts';
import { useScope } from '../lib/scope.ts';

export const FLOW_TABS: Array<[string, string]> = [['summary', 'Resumen'], ['live', 'Probar en vivo'], ['doc', 'Documento']];

export function FlowScope({ id, active, p, flow, envs, app }: { id: string; active: string; p?: DocPiece; flow?: FlowInfo; envs?: EnvSummary[]; app?: string }) {
  const slug = id.replace(/^flow:/, '');
  const kd = useApi<KnowledgeData>(p ? null : '/api/knowledge');
  const fl = useApi<FlowInfo[]>(flow ? null : '/api/flows');
  const ev = useApi<EnvSummary[]>(envs ? null : '/api/envs');
  const fe = useApi<FlowEnvData>(`/api/flow-env?flow=${encodeURIComponent(slug)}`);
  const piece = p ?? kd.data?.pieces.find((x) => x.id === id);
  const info = flow ?? fl.data?.find((f) => f.id === id);
  const list = envs ?? ev.data;
  const appId = app ?? kd.data?.pieces.find((x) => x.type === 'application')?.id ?? '';
  // Its own environment when it has one, else the one it runs on, else any that is up.
  // Each flow runs isolated in its own environment: its data are that environment's, never another's.
  const env = `f-${slug}`;
  const at = (screen: string) => href(screen, env);
  const last = info ? lastWord(info) : undefined;
  useScope({
    back: { label: 'Todos los flujos', to: href('docs', appId, 't', 'flows') },
    card: { icon: Workflow, kind: 'Flujo', title: piece?.title ?? slug, sub: last?.[1], state: info ? flowDot(info) : undefined },
    sections: [
      ...FLOW_TABS.map(([key, label]) => ({ key, label, to: key === 'summary' ? href('docs', id) : href('docs', id, 't', key), icon: { summary: FileText, live: Radio, doc: BookText }[key] })),
      { key: 'data', label: 'Bases de datos', to: at('data'), icon: Database, group: `Datos de ${env}` },
      { key: 'queues', label: 'Colas', to: at('queues'), icon: ArrowLeftRight, group: `Datos de ${env}` },
      { key: 'storage', label: 'Almacenamiento', to: at('storage'), icon: HardDrive, group: `Datos de ${env}` },
      { key: 'mail', label: 'Correo y mensajes', to: at('mail'), icon: Mail, group: `Datos de ${env}` },
      { key: 'vars', label: 'Variables y secretos', to: at('vars'), icon: KeyRound, group: `Datos de ${env}` },
    ],
    active,
  });
  return null;
}
