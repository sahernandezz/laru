/**
 * «Escenarios»: the named states of the system, on an env. Each says what it leaves, how it is put back
 * (from snapshots, or its setup played again, and what then keeps what it had), and applies in one action: on an
 * env that keeps its data the service first says what applying deletes (`askFirst`), and nothing happens until «Aplicar» in
 * that dialog. Who can sign in comes with the apply; their passwords never reach this page.
 */
import { CircleX, DatabaseBackup, Play } from 'lucide-react';
import { useState } from 'react';
import { api, useApi, type AppliedShown, type EnvSummary, type ScenarioRow, type ScenariosData } from '../api.ts';
import { ActionButton, CopyButton, Dot, Segmented, Skeleton, toast, type DotState } from '../components/ui.tsx';
import { askFirst } from '../lib/ask.ts';
import { secs } from '../lib/es.ts';
import { href } from '../lib/route.ts';

const KIND: Record<string, string> = { data: 'Dato', identity: 'Identidad', mock: 'Mock', fault: 'Fallo' };

export function Scenarios({ embedded }: { embedded?: boolean }) {
  const envs = useApi<EnvSummary[]>('/api/envs');
  const ready = (envs.data ?? []).filter((e) => e.state === 'ready' && !/^f-/.test(e.env));
  const [env, setEnv] = useState<string>();
  const pick = env && ready.some((e) => e.env === env) ? env : ready[0]?.env;
  const data = useApi<ScenariosData>(pick ? `/api/scenarios?env=${encodeURIComponent(pick)}` : null);
  const [applied, setApplied] = useState<AppliedShown>();
  return (
    <div className={embedded ? undefined : 'page'}>
      <div className="head"><div>{embedded ? <h2 className="section-h">Escenarios</h2> : <h1>Escenarios</h1>}{!embedded && <p>Estados del sistema con nombre: datos, mocks, fallos y quién puede entrar. Se aplican en segundos desde sus instantáneas; si su preparación toca algo sin instantánea, se vuelve a jugar y se dice qué conserva.</p>}</div></div>
      {envs.error ? <div className="notice" role="alert"><CircleX />{envs.error}</div> : !envs.data ? <Skeleton lines={4} /> : !ready.length ? (
        <section className="panel"><div className="empty">Ningún entorno está arriba. Levanta uno en <a className="rowlink" href={href('envs')}>Entornos</a>, o con <code>laru up local</code>.</div></section>
      ) : (
        <>
          {ready.length > 1 && <div style={{ marginBottom: 16 }}><Segmented label="Entorno" options={ready.map((e) => ({ key: e.env, label: e.env }))} value={pick!} onChange={setEnv} /></div>}
          {applied && <AppliedNotice a={applied} />}
          {data.error ? <div className="notice" role="alert"><CircleX />{data.error}</div> : !data.data ? <Skeleton lines={6} /> : !data.data.scenarios.length ? (
            <section className="panel"><div className="empty">Todavía no hay escenarios. Escribe uno en <a className="rowlink" href={href('docs')}>Documentación y flujos</a> (o con <code>knowledge_write</code>, tipo <code>scenario</code>) y su <code>&lt;slug&gt;.setup.ts</code> junto a su <code>scenario.md</code>.</div></section>
          ) : (
            <div className="scn-list">{data.data.scenarios.map((s) => <Card key={s.id} s={s} env={pick!} on={data.data!.applied?.slug === s.slug} onApplied={(a) => { setApplied(a); data.reload(); }} />)}</div>
          )}
        </>
      )}
    </div>
  );
}

function stateOf(s: ScenarioRow): [string, DotState, string] {
  const st = s.state;
  if (!s.setup && !s.extends) return ['Sin preparación', 'idle', `Falta ${s.dir}/${s.slug}.setup.ts`];
  if (!st) return ['Sin aprovisionar', 'idle', 'La primera vez juega su preparación'];
  if (st.broken) return ['Roto', 'err', st.broken.split('\n')[0]];
  return st.mode === 'snapshot' ? ['Desde instantáneas', 'ok', `Escribe en ${st.touched.join(', ') || 'nada'}`] : ['Vuelve a prepararse', 'run', `${st.keeps.join(', ')} no tienen instantánea: conservan lo de antes`];
}

function Card({ s, env, on, onApplied }: { s: ScenarioRow; env: string; on: boolean; onApplied: (a: AppliedShown) => void }) {
  const [word, dot, why] = stateOf(s);
  // An env that keeps its data answers 409 with what applying would delete: `askFirst` asks, and sends it again with `confirm`.
  const apply = () => askFirst((confirm) => api<AppliedShown>('/api/scenarios/apply', { method: 'POST', body: { name: s.id, env, confirm } }).then(onApplied), 'Aplicar', `Aplicar «${s.title}» en ${env}`);
  const provision = () => askFirst((confirm) => api<unknown>('/api/scenarios/provision', { method: 'POST', body: { name: s.id, env, confirm } }).then(() => toast(`«${s.title}» aprovisionado en ${env}`)), 'Aprovisionar', `Aprovisionar «${s.title}» en ${env}`);
  const live = () => askFirst((confirm) => api<{ run: { id: string } }>('/api/session/start', { method: 'POST', body: { env, scenario: s.id, title: s.title, browser: true, confirm } }).then(({ run }) => { location.hash = href('live', run.id); }), 'Aplicar y abrir', `Aplicar «${s.title}» en ${env}`);
  return (
    <section className="panel scn">
      <header>
        <h3>{s.title}</h3>{on && <span className="chip accent">aplicado</span>}
        <div className="meta"><span className="mono">{s.id}</span>{s.extends && <span>extiende <span className="mono">{s.extends}</span></span>}</div>
      </header>
      <div className="body">
        {s.summary && <p className="faint" style={{ margin: '0 0 10px' }}>{s.summary}</p>}
        <ul className="given">{s.given.map((g, i) => <li key={i}><span className="chip">{KIND[String(g.kind)] ?? String(g.kind)}</span><span>{String(g.what)}</span></li>)}</ul>
        {(s.mocks.length > 0 || s.faults.length > 0) && <p className="faint" style={{ margin: '10px 0 0' }}>{[...s.mocks.map((m) => `${m.service}: ${m.mode}`), ...s.faults.map((f) => `${f.service}: ${[f.rule.latency !== undefined && `${f.rule.latency} ms`, f.rule.status && `responde ${f.rule.status}`, f.rule.p !== undefined && `p ${f.rule.p}`].filter(Boolean).join(', ')}`)].join(' · ')}</p>}
        <div className="scn-foot">
          <div className="scn-state"><span className="status"><Dot state={dot} />{word}</span><span className="faint">{why}{s.state && !s.state.broken ? ` · preparado en ${secs(s.state.ms)}` : ''}{s.state?.applyMs !== undefined ? ` · se repite en ${secs(s.state.applyMs)}` : ''}</span>{s.exclusive && <span className="chip" title="Necesita el entorno entero: corre sola, al final de un run, restaurada">exclusivo</span>}</div>
          <div className="scn-btns">
            <ActionButton icon={DatabaseBackup} disabled={!s.setup && !s.extends} run={apply}>Aplicar</ActionButton>
            <ActionButton icon={DatabaseBackup} disabled={!s.setup} run={provision} title="Vuelve a jugar su preparación desde «base» y guarda lo que pueda como instantáneas">Aprovisionar</ActionButton>
            <ActionButton icon={Play} primary disabled={!s.setup && !s.extends} run={live}>Probarlo en vivo</ActionButton>
          </div>
        </div>
      </div>
    </section>
  );
}

function AppliedNotice({ a }: { a: AppliedShown }) {
  return (
    <div className={`notice ${a.keeps.length ? 'warn' : 'info'}`} role="status" style={{ marginBottom: 16, display: 'grid', gap: 8 }}>
      <div><b>{a.slug} aplicado en {a.env}</b> en {secs(a.ms)}{a.provisioned ? ', jugando su preparación' : ', desde sus instantáneas'}.{a.keeps.length ? ` ${a.keeps.join(', ')} conservan lo que tenían.` : ''}{a.signedIn ? ' «Probarlo en vivo» abre el aplicativo con la sesión iniciada.' : ''}</div>
      {a.identities.map((i) => (
        <div key={i.name} className="who"><span>{i.name}</span>{(i.username ?? i.email) && <><code>{i.username ?? i.email}</code><CopyButton value={i.username ?? i.email!} label="Copiar el usuario" /></>}</div>
      ))}
      {a.identities.length > 0 && <div className="faint">Las contraseñas no se muestran aquí: son las que dejó la preparación del escenario (su <code>.setup.ts</code>).</div>}
    </div>
  );
}
