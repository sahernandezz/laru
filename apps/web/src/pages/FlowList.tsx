/**
 * «Flujos»: the heart of Laru. Every flow of the application in one place, grouped by the module it belongs to, with
 * how it did, the scenario it starts from, its own environment and the two things you do with a flow: understand it
 * (open its sheet) and try it live. Picking several runs them together.
 */
import { Play, Radio, Workflow } from 'lucide-react';
import { useMemo } from 'react';
import { useApi, type EnvSummary, type FlowInfo, type KnowledgeData } from '../api.ts';
import { Dot, Skeleton, Status } from '../components/ui.tsx';
import { plural } from '../lib/es.ts';
import { href, pageOf } from '../lib/route.ts';
import { flowDot, lastWord, RunFlows, Spark, usePick } from './Flows.tsx';
import { iconOf } from './Docs.tsx';

export function FlowList({ embedded }: { embedded?: boolean }) {
  const kd = useApi<KnowledgeData>('/api/knowledge');
  const flows = useApi<FlowInfo[]>('/api/flows');
  const envs = useApi<EnvSummary[]>('/api/envs');
  const pick = usePick(() => []);
  const rows = flows.data ?? [];
  const byEnv = useMemo(() => new Map((envs.data ?? []).map((e) => [e.env, e])), [envs.data]);
  const groups = useMemo(() => {
    const parentOf = new Map((kd.data?.pieces ?? []).filter((p) => p.type === 'flow').map((p) => [p.id, p.parent]));
    const title = new Map((kd.data?.pieces ?? []).map((p) => [p.id, p]));
    const out = new Map<string, FlowInfo[]>();
    for (const f of rows) { const k = parentOf.get(f.id) ?? ''; out.set(k, [...(out.get(k) ?? []), f]); }
    return [...out].map(([id, list]) => ({ id, piece: title.get(id), list }));
  }, [rows, kd.data]);
  const n = (pred: (f: FlowInfo) => boolean) => rows.filter(pred).length;
  const failing = n((f) => flowDot(f) === 'err'), passing = n((f) => flowDot(f) === 'ok'), idle = n((f) => f.exists && flowDot(f) === 'idle'), bare = n((f) => !f.exists);

  if (flows.error) return <div className="page"><div className="notice" role="alert">{flows.error}</div></div>;
  return (
    <div className={embedded ? undefined : 'page wide'}>
      <div className="head">
        <div>{embedded ? <h2 className="section-h">Flujos</h2> : <h1>Flujos</h1>}{!embedded && <p>Cada flujo es un recorrido de negocio que se documenta y se prueba a la vez. Ábrelo para entenderlo, pruébalo en vivo con sus datos, o ejecútalos juntos.</p>}</div>
        <div className="actions">{pick.picked.size > 0 ? <RunFlows chosen={rows.filter((f) => pick.picked.has(f.slug))} envs={envs.data} /> : null}</div>
      </div>
      {!flows.data ? <Skeleton lines={6} /> : !rows.length ? (
        <section className="panel"><div className="empty">Todavía no hay flujos. Documenta uno desde la <a className="rowlink" href={href('docs')}>documentación</a> o pídeselo a Claude con <code>knowledge_write</code> (type: flow).</div></section>
      ) : (
        <>
          <div className="stats">
            <div className="stat"><span className="k"><Workflow />Flujos</span><span className="v">{rows.length}</span><span className="s">{bare ? `${bare} sin prueba escrita` : 'todos con prueba'}</span></div>
            <div className="stat"><span className="k"><Dot state="ok" />Pasan</span><span className="v">{passing}</span><span className="s">en su último run</span></div>
            <div className="stat"><span className="k"><Dot state="err" />Fallan</span><span className="v">{failing}</span><span className="s">{failing ? 'ábrelos para ver dónde' : 'ninguno'}</span></div>
            <div className="stat"><span className="k"><Dot state="idle" />Sin ejecutar</span><span className="v">{idle}</span><span className="s">tienen prueba pero no han corrido</span></div>
          </div>
          <section className="panel" style={{ marginTop: 16 }}>
            <div className="scroll-x"><table className={`t flows${embedded ? ' compact' : ''}`}>
              <thead><tr><th className="pick" /><th>Flujo</th><th className="c-last">Último</th><th className="c-spark">Últimos 10</th><th>Escenario</th><th className="c-env">Su entorno</th><th className="r">Acciones</th></tr></thead>
              {groups.map(({ id, piece, list }) => {
                const I = piece ? iconOf(piece) : Workflow;
                return (
                  <tbody key={id}>
                    <tr className="grp"><th colSpan={7} scope="colgroup"><I size={14} />{piece ? <a className="rowlink" href={pageOf(piece.id)}>{piece.title}</a> : 'Sin módulo'}<span className="faint"> · {plural(list.length, 'flujo', 'flujos')}</span></th></tr>
                    {list.map((f) => {
                      const [dot, word] = lastWord(f);
                      const inst = byEnv.get(`f-${f.slug}`);
                      return (
                        <tr key={f.slug} className="clickrow" onClick={(e) => { if (!(e.target as HTMLElement).closest('a,button,input,select')) location.hash = pageOf(f.id); }}>
                          <td className="pick">{f.exists && <input type="checkbox" aria-label={`Elegir ${f.title}`} checked={pick.picked.has(f.slug)} onChange={() => pick.toggle(f.slug)} />}</td>
                          <td className="wrap"><a className="rowlink" href={pageOf(f.id)} style={{ fontWeight: 500 }}>{f.title}</a><div className="faint sub">{plural(f.steps.length, 'paso', 'pasos')}{f.cases.length ? `, ${plural(f.cases.length, 'caso', 'casos')}` : ''}</div></td>
                          <td className="c-last"><Status state={dot}>{word}</Status></td>
                          <td className="c-spark"><Spark history={f.history} /></td>
                          <td>{f.scenario ? <a className="rowlink mono" href={pageOf(f.scenario)}>{f.scenario.replace(/^scn:/, '')}</a> : <span className="faint">ninguno</span>}</td>
                          <td className="c-env">{inst ? <a className="rowlink" href={href('envs', inst.env)}><Status state={inst.state === 'ready' ? 'ok' : inst.state === 'starting' ? 'run' : 'idle'}>{inst.state === 'ready' ? 'listo' : inst.state === 'starting' ? 'levantándose' : 'parado'}</Status></a> : <span className="faint">sin aprovisionar</span>}</td>
                          <td className="r"><span className="row-actions" style={{ justifyContent: 'flex-end' }}>
                            <a className="btn sm primary" href={href('docs', f.id, 't', 'live')}><Radio />Probar en vivo</a>
                            <a className="btn sm" href={pageOf(f.id)}><Play />Abrir</a>
                          </span></td>
                        </tr>
                      );
                    })}
                  </tbody>
                );
              })}
            </table></div>
          </section>
        </>
      )}
    </div>
  );
}
