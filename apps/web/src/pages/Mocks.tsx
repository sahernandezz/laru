/**
 * Mocks and faults: every dependency the tap stands in front of, with its mock mode, its fault rules and the
 * requests it receives, live. Faults are edited here, applied live (the tap reloads its rules within a second) and
 * reach envs/<env>.yaml only through «Guardar en el entorno».
 */
import { ArrowLeftRight, CircleX, Pause, Play, Plug, Plus, Save, Trash2, Zap } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { api, useApi, type EnvSummary, type FaultRule, type MocksData, type TapRoute, type TrafficRecord, apiUrl } from '../api.ts';
import { ActionButton, HttpStatus, Kind, Skeleton, Status, toast } from '../components/ui.tsx';
import { faultText, MOCK_MODE, plural, secs } from '../lib/es.ts';
import { href } from '../lib/route.ts';

const MODES = ['contract', 'record', 'simulate', 'spy', 'script'] as const;
const PRESETS: Array<[string, FaultRule]> = [
  ['Latencia 800 ms', { latency: 800 }],
  ['Error 503', { status: 503 }],
  ['Corte', { abort: true }],
  ['Sin respuesta', { timeout: true }],
  ['Ancho de banda', { bandwidth: 16 * 1024 }],
];
/** What a mail or SMS sink can be made to do: the stage is the method, the recipient the path, and `code` the provider's own. */
const SINK_PRESETS: Array<[string, FaultRule[], 'smtp' | 'twilio']> = [
  ['Servidor de correo caído', [{ method: 'CONNECT', status: 421 }], 'smtp'],
  ['Credenciales rechazadas', [{ method: 'AUTH', status: 535 }], 'smtp'],
  ['Destinatario rechazado', [{ method: 'RCPT', status: 550 }], 'smtp'],
  ['Buzón lleno, temporal', [{ method: 'RCPT', status: 452 }], 'smtp'],
  ['Fallo tras el DATA', [{ method: 'DATA', status: 451 }], 'smtp'],
  ['Conexión cortada', [{ method: 'DATA', abort: true }], 'smtp'],
  ['Latencia de 3 s', [{ latency: 3000 }], 'smtp'],
  ['Rebote tras aceptar', [{ method: 'DELIVERY', status: 550 }, { method: 'DELIVERY', latency: 2000 }], 'smtp'],
  ['SMS: límite de tasa', [{ method: 'POST', status: 429 }], 'twilio'],
  ['SMS: número inválido', [{ method: 'POST', status: 400 }], 'twilio'],
  ['SMS no entregado', [{ method: 'DELIVERY', code: 30003 }], 'twilio'],
  ['Llamada de estado lenta', [{ method: 'DELIVERY', latency: 5000 }], 'twilio'],
];
const KEEP = 200;

/** The same rules, whatever the order of their keys: what decides whether the env file is behind the live rules. */
const canon = (faults: Record<string, FaultRule[]> = {}) =>
  JSON.stringify(Object.entries(faults).filter(([, v]) => v?.length).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v.map((r) => Object.entries(r).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)))]));

export function Mocks({ parts }: { parts: string[] }) {
  const [envArg, svcArg] = parts;
  const envs = useApi<EnvSummary[]>('/api/envs');
  const list = envs.data ?? [];
  const env = list.find((e) => e.env === envArg)?.env ?? list.find((e) => e.state === 'ready')?.env ?? list[0]?.env;
  const m = useApi<MocksData>(env ? `/api/mocks?env=${encodeURIComponent(env)}` : null);
  const d = m.data;
  const route = d?.routes.find((r) => r.svc === svcArg) ?? d?.routes[0];

  const head = (
    <div className="head">
      <div><h1>Mocks y fallos</h1><p>Cada dependencia que el interceptor tiene delante: su modo, sus fallos y las peticiones que recibe en vivo. Los fallos se aplican al momento y solo pasan a <span className="mono">envs/{env ?? '<entorno>'}.yaml</span> al guardarlos.</p></div>
      {list.length > 1 && <div className="actions"><nav className="seg" aria-label="Entorno">{list.map((e) => <a key={e.env} href={href('mocks', e.env)} aria-current={e.env === env ? 'page' : undefined}>{e.env}</a>)}</nav></div>}
    </div>
  );
  if (envs.error) return <div className="page wide">{head}<div className="notice" role="alert"><CircleX />{envs.error}</div></div>;
  if (envs.data && !env) return <div className="page wide">{head}<section className="panel"><div className="empty">Este workspace no tiene entornos. Crea uno en <a className="rowlink" href={href('envs')}>Entornos</a>: el interceptor nace con su primer arranque.</div></section></div>;
  if (m.error) {
    const fresh = /has not been started/.test(m.error);
    return (
      <div className="page wide">{head}
        {fresh ? <section className="panel"><div className="empty"><span>{env} no se ha levantado todavía: el interceptor y sus reglas nacen con el primer arranque.</span><span>Levántalo en <a className="rowlink" href={href('envs', env!)}>Entornos</a> o con <code>laru up {env}</code>.</span></div></section>
          : <div className="notice" role="alert"><CircleX />{m.error}</div>}
      </div>
    );
  }
  if (!d) return <div className="page wide">{head}<div className="mocks"><Skeleton lines={6} /><Skeleton lines={8} /></div></div>;

  const unsaved = canon(d.rules.faults) !== canon(d.spec.faults);
  const peers = [...new Set(Object.values(d.rules.peers))].filter((p) => p !== 'ks-tap').sort();

  return (
    <div className="page wide">
      {head}
      {unsaved && (
        <div className="notice warn">
          <Zap />
          <div className="grow"><b>Hay fallos en vivo que no están en envs/{env}.yaml.</b> El próximo arranque de {env} los pierde si no los guardas.</div>
          <ActionButton icon={Save} sm run={() => api('/api/mocks/save', { method: 'POST', body: { env } }).then(m.reload)} done={() => `Fallos guardados en envs/${env}.yaml`}>Guardar en el entorno</ActionButton>
        </div>
      )}
      {!d.routes.length ? (
        <section className="panel"><div className="empty">El interceptor de {env} no tiene ninguna dependencia delante. Se pone delante de cada servicio que otro llama por su nombre.</div></section>
      ) : (
        <div className="mocks">
          <nav className="env-list dep-list" aria-label="Dependencias">
            {d.routes.map((r) => {
              const mock = d.rules.mocks[r.svc];
              const n = d.rules.faults[r.svc]?.length ?? 0;
              const Icon = n ? Zap : mock ? Plug : ArrowLeftRight;
              return (
                <a key={r.svc} href={href('mocks', env!, r.svc)} aria-current={r === route ? 'page' : undefined}>
                  <Icon className={n ? 'ic-fault' : undefined} aria-hidden="true" />
                  <b className="mono">{r.svc}</b>
                  <span>{r.proto.toUpperCase()} · {mock ? `mock: ${MOCK_MODE[mock.mode]?.label.toLowerCase() ?? mock.mode}` : 'real'}{n ? ` · ${plural(n, 'fallo', 'fallos')}` : ''}</span>
                </a>
              );
            })}
          </nav>
          {route && <Dependency key={`${env}/${route.svc}`} env={env!} route={route} data={d} peers={peers} reload={m.reload} />}
        </div>
      )}
    </div>
  );
}

function Dependency({ env, route, data, peers, reload }: { env: string; route: TapRoute; data: MocksData; peers: string[]; reload: () => void }) {
  const svc = route.svc;
  const mock = data.rules.mocks[svc];
  const startMode = data.spec.mocks[svc]?.mode;
  return (
    <div style={{ minWidth: 0 }}>
      <div className="dep-head">
        <h2 className="mono">{svc}</h2>
        <span className="chip">{route.proto.toUpperCase()} {route.ports.map((p) => `:${p}`).join(' ')}</span>
        <span className="faint dep-up">Reenvía a <span className="mono">{route.upstream}</span></span>
      </div>

      <section className="panel block" aria-labelledby="mode-h">
        <header><h3 id="mode-h">Modo</h3><div className="meta">{mock ? (mock.dir ? <span>Contrato y grabaciones en <span className="mono">mocks/{mock.dir}</span></span> : null) : 'Sin mock'}</div></header>
        {mock?.mode === 'sink' ? (
          <div className="empty"><span>{MOCK_MODE.sink.hint}</span><span>Lo que recibe se ve en <a className="rowlink" href={href('mail', env)}>Correo y mensajes</a>.</span></div>
        ) : mock ? <ModeControl env={env} svc={svc} mode={mock.mode} startMode={startMode} reload={reload} /> : (
          <div className="empty">
            <span>Sin mock: el interceptor pasa cada petición a <span className="mono">{route.upstream}</span> y la registra.</span>
            <span>Para simularlo, añade <code>mocks.{svc}</code> a <span className="mono">envs/{env}.yaml</span> y vuelve a levantar {env}.</span>
          </div>
        )}
      </section>

      <FaultEditor env={env} svc={svc} live={data.rules.faults[svc] ?? []} peers={peers} onApplied={reload} sink={mock?.mode === 'sink' ? mock.sink : undefined} />
      <Live env={env} svc={svc} peers={data.rules.peers} />
    </div>
  );
}

/** Buttons, not a radio group: each one changes the tap at once, so moving through them must not. */
function ModeControl({ env, svc, mode, startMode, reload }: { env: string; svc: string; mode: string; startMode?: string; reload: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const set = async (to: string) => {
    if (busy || to === mode) return;
    setBusy(to);
    setError('');
    try { await api('/api/mocks/mode', { method: 'POST', body: { env, service: svc, mode: to } }); toast(`${svc} en modo ${MOCK_MODE[to].label.toLowerCase()}`); reload(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  return (
    <div className="body mode">
      <div className="seg" role="group" aria-label={`Modo del mock de ${svc}`}>
        {MODES.map((k) => <button key={k} type="button" aria-pressed={k === mode} aria-busy={busy === k || undefined} onClick={() => set(k)}>{MOCK_MODE[k].label}</button>)}
      </div>
      <p className="mode-hint" aria-live="polite">{MOCK_MODE[mode]?.hint}</p>
      {startMode && startMode !== mode && <p className="faint mode-hint">En vivo hasta el próximo arranque: <span className="mono">envs/{env}.yaml</span> arranca en {MOCK_MODE[startMode]?.label.toLowerCase() ?? startMode}.</p>}
      {error && <p className="form-err" role="alert">{error}</p>}
    </div>
  );
}

type Kind = 'latency' | 'status' | 'abort' | 'timeout' | 'bandwidth' | 'code';
const kindOf = (r: FaultRule): Kind => (r.latency !== undefined ? 'latency' : r.status !== undefined ? 'status' : r.code !== undefined ? 'code' : r.abort ? 'abort' : r.timeout ? 'timeout' : 'bandwidth');

/** What is wrong with a rule before the tap sees it, by field. */
function problems(r: FaultRule): Partial<Record<keyof FaultRule, string>> {
  const out: Partial<Record<keyof FaultRule, string>> = {};
  const k = kindOf(r);
  if (k === 'latency' && !(r.latency! > 0)) out.latency = 'Milisegundos, más que cero.';
  if (k === 'status' && !(r.status! >= 100 && r.status! <= 599)) out.status = 'Un estado HTTP, de 100 a 599.';
  if (k === 'bandwidth' && !(r.bandwidth! > 0)) out.bandwidth = 'Bytes por segundo, más que cero.';
  if (k === 'code' && !(Number.isInteger(r.code) && r.code! >= 1 && r.code! <= 99999)) out.code = 'El código del proveedor, por ejemplo 30003.';
  if (r.p !== undefined && !(r.p >= 0 && r.p <= 1)) out.p = 'De 0 a 100 %.';
  if (r.path) { try { new RegExp(r.path); } catch { out.path = 'No es una expresión regular válida.'; } }
  return out;
}

function FaultEditor({ env, svc, live, peers, onApplied, sink }: { env: string; svc: string; live: FaultRule[]; peers: string[]; onApplied: () => void; sink?: 'smtp' | 'twilio' }) {
  const [draft, setDraft] = useState<FaultRule[]>(live);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const focusRow = useRef<number | null>(null);
  const ids = useId();
  const liveKey = JSON.stringify(live);
  const dirty = JSON.stringify(draft) !== liveKey;
  // Applied (or changed from the CLI): the draft starts again from what the tap has, without remounting what has the focus.
  useEffect(() => { setDraft(live); setBusy(false); }, [liveKey]);
  const bad = draft.some((r) => Object.keys(problems(r)).length);

  // A row added or removed moves the focus on purpose: to the new row, or to what took the removed one's place.
  useEffect(() => {
    if (focusRow.current === null) return;
    const rows = box.current?.querySelectorAll<HTMLElement>('.fault');
    const row = rows?.[Math.min(focusRow.current, rows.length - 1)];
    const target = row?.querySelector<HTMLElement>('input') ?? box.current?.querySelector<HTMLElement>('.presets button');
    focusRow.current = null;
    target?.focus();
  }, [draft.length]);

  const put = (i: number, patch: Partial<FaultRule>) => setDraft((l) => l.map((r, j) => (j === i ? clean({ ...r, ...patch }) : r)));
  const apply = async () => {
    if (busy || !dirty) return;
    if (bad) { setError('Corrige los campos marcados antes de aplicar.'); return; }
    setBusy(true);
    setError('');
    try {
      await api('/api/mocks/faults', { method: 'POST', body: { env, service: svc, rules: draft } });
      toast(draft.length ? `${plural(draft.length, 'fallo aplicado', 'fallos aplicados')} a ${svc}, en vivo` : `${svc} sin fallos`);
      onApplied();
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };

  return (
    <section className="panel block" aria-labelledby={`${ids}-h`} ref={box}>
      <header>
        <h3 id={`${ids}-h`}>Fallos</h3>
        <div className="meta">{live.length ? `${plural(live.length, 'activo', 'activos')} ahora` : 'Ninguno activo'}</div>
      </header>
      <div className="presets toolbar" role="group" aria-label="Añadir un fallo">
        <span className="faint">Añadir</span>
        {sink ? SINK_PRESETS.filter(([, , k]) => k === sink).map(([label, rules]) => <button key={label} type="button" className="flt" onClick={() => { focusRow.current = draft.length; setDraft((l) => [...l, ...rules.map((r) => ({ ...r }))]); }}><Plus />{label}</button>)
          : PRESETS.map(([label, rule]) => <button key={label} type="button" className="flt" onClick={() => { focusRow.current = draft.length; setDraft((l) => [...l, { ...rule }]); }}><Plus />{label}</button>)}
      </div>
      {draft.length ? (
        <ol className="faults">
          {draft.map((r, i) => <FaultRow key={i} sink={sink} n={i + 1} r={r} peers={peers} peersId={`${ids}-peers`} ids={`${ids}-${i}`} put={(p) => put(i, p)} remove={() => { focusRow.current = i; setDraft((l) => l.filter((_, j) => j !== i)); }} />)}
        </ol>
      ) : <div className="empty">Sin fallos: {svc} responde como siempre. Añade uno arriba; nada cambia hasta «Aplicar en vivo».</div>}
      <datalist id={`${ids}-peers`}>{peers.map((p) => <option key={p} value={p} />)}</datalist>
      <footer className="fault-foot">
        <span className="faint grow" aria-live="polite">{error ? '' : dirty ? 'Cambios sin aplicar' : live.length ? 'Aplicado en vivo' : ''}</span>
        {error && <p className="form-err grow" role="alert">{error}</p>}
        <button type="button" className="btn sm" aria-disabled={!dirty || busy || undefined} onClick={() => { if (dirty && !busy) { setDraft(live); setError(''); } }}>Descartar</button>
        <button type="button" className="btn sm primary" aria-disabled={!dirty || busy || undefined} onClick={apply}><Zap className={busy ? 'spin' : undefined} />Aplicar en vivo</button>
      </footer>
    </section>
  );
}

/** Empty fields leave the rule, so the tap reads only what was set. */
function clean(r: FaultRule): FaultRule {
  return Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined && v !== '' && !(typeof v === 'number' && Number.isNaN(v)))) as FaultRule;
}
const num = (v: string) => (v === '' ? undefined : Number(v));

function FaultRow({ n, r, peers, peersId, ids, put, remove, sink }: { sink?: 'smtp' | 'twilio'; n: number; r: FaultRule; peers: string[]; peersId: string; ids: string; put: (p: Partial<FaultRule>) => void; remove: () => void }) {
  const k = kindOf(r);
  const bad = problems(r);
  const field = (key: keyof FaultRule, label: string, input: ReactNode) => (
    <div className={`fld${bad[key] ? ' bad' : ''}`}>
      <label className="l" htmlFor={`${ids}-${key}`}>{label}</label>
      {input}
      {bad[key] && <span className="h form-err" id={`${ids}-${key}-e`}>{bad[key]}</span>}
    </div>
  );
  const described = (key: keyof FaultRule) => (bad[key] ? { 'aria-invalid': true, 'aria-describedby': `${ids}-${key}-e` } : {});
  return (
    <li className="fault">
      <div className="fault-h">
        <span className="num faint">{n}</span>
        <b>{faultText(r)}</b>
        <button type="button" className="icon-btn" onClick={remove} aria-label={`Quitar el fallo ${n}: ${faultText(r)}`} title="Quitar"><Trash2 /></button>
      </div>
      <div className="fault-f">
        {k === 'latency' && field('latency', 'Latencia, ms', <input id={`${ids}-latency`} type="number" min={1} step={50} inputMode="numeric" value={r.latency ?? ''} onChange={(e) => put({ latency: num(e.target.value) ?? 0 })} {...described('latency')} />)}
        {k === 'status' && field('status', 'Responde', <input id={`${ids}-status`} type="number" min={100} max={599} inputMode="numeric" value={r.status ?? ''} onChange={(e) => put({ status: num(e.target.value) ?? 0 })} {...described('status')} />)}
        {k === 'bandwidth' && field('bandwidth', 'Bytes por segundo', <input id={`${ids}-bandwidth`} type="number" min={1} step={1024} inputMode="numeric" value={r.bandwidth ?? ''} onChange={(e) => put({ bandwidth: num(e.target.value) ?? 0 })} {...described('bandwidth')} />)}
        {k === 'bandwidth' && field('slowAfter', 'A partir del byte', <input id={`${ids}-slowAfter`} type="number" min={0} inputMode="numeric" value={r.slowAfter ?? ''} onChange={(e) => put({ slowAfter: num(e.target.value) })} />)}
        {field('p', 'Probabilidad, %', <input id={`${ids}-p`} type="number" min={0} max={100} inputMode="numeric" value={r.p === undefined ? '' : Math.round(r.p * 100)} placeholder="100" onChange={(e) => put({ p: e.target.value === '' ? undefined : Number(e.target.value) / 100 })} {...described('p')} />)}
        {k === 'code' && field('code', 'Código del proveedor', <input id={`${ids}-code`} type="number" min={1} max={99999} inputMode="numeric" value={r.code ?? ''} onChange={(e) => put({ code: num(e.target.value) ?? 0 })} {...described('code')} />)}
        {field('method', sink ? 'Etapa' : 'Método', <input id={`${ids}-method`} className="mono" value={r.method ?? ''} placeholder="Todos" autoComplete="off" spellCheck={false} onChange={(e) => put({ method: e.target.value.toUpperCase() || undefined })} />)}
        {field('path', sink ? 'Destinatario, expresión regular' : 'Ruta, expresión regular', <input id={`${ids}-path`} className="mono" value={r.path ?? ''} placeholder="Todas" autoComplete="off" spellCheck={false} onChange={(e) => put({ path: e.target.value || undefined })} {...described('path')} />)}
        {field('from', 'Desde el servicio', <input id={`${ids}-from`} className="mono" list={peers.length ? peersId : undefined} value={r.from ?? ''} placeholder="Cualquiera" autoComplete="off" spellCheck={false} onChange={(e) => put({ from: e.target.value || undefined })} />)}
      </div>
    </li>
  );
}

const time = (t: number) => { const d = new Date(t); return `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')}`; };

/** What reaches the dependency from now on, newest first. The stream starts at the end of the journal. */
function Live({ env, svc, peers }: { env: string; svc: string; peers: Record<string, string> }) {
  const [items, setItems] = useState<TrafficRecord[]>([]);
  const [paused, setPaused] = useState(false);
  const [said, setSaid] = useState('');
  const hold = useRef(false);
  hold.current = paused;
  useEffect(() => {
    setItems([]);
    const es = new EventSource(apiUrl(`/api/mocks/live?env=${encodeURIComponent(env)}&service=${encodeURIComponent(svc)}`));
    let first = true;
    es.onmessage = (m) => {
      if (hold.current) return;
      let r: TrafficRecord;
      try { r = JSON.parse(m.data) as TrafficRecord; } catch { return; }
      if (first) { first = false; setSaid(`Llegan peticiones a ${svc}`); }
      setItems((l) => [r, ...l].slice(0, KEEP));
    };
    return () => es.close();
  }, [env, svc]);
  return (
    <section className="panel" aria-labelledby="live-h">
      <header>
        <h3 id="live-h">Peticiones en vivo</h3>
        <div className="meta">
          <span className="sr-only" aria-live="polite">{said}</span>
          <span className="num">{items.length ? plural(items.length, 'petición', 'peticiones') : ''}{items.length >= KEEP ? ', las últimas' : ''}</span>
          <button className="btn sm" aria-pressed={paused} onClick={() => { setPaused((p) => !p); setSaid(paused ? 'Recibiendo de nuevo' : 'En pausa: lo que llegue ahora no se muestra'); }}>{paused ? <Play /> : <Pause />}{paused ? 'Seguir' : 'Pausar'}</button>
        </div>
      </header>
      {!items.length ? (
        <div className="empty"><span><Plug className="inline-ic" aria-hidden="true" /> {paused ? 'En pausa.' : `Esperando peticiones a ${svc}.`} Aparecen en cuanto alguien la llama: un flujo, el navegador u otro servicio.</span></div>
      ) : (
        <div className="scroll-x run-list">
          <table className="t">
            <thead><tr><th>Hora</th><th>Desde</th><th>Petición</th><th>Respuesta</th><th className="r">Duración</th></tr></thead>
            <tbody>
              {items.map((r) => {
                const ok = !r.error && (r.status === undefined || r.status < 500);
                return (
                  <tr key={r.id} className={ok ? undefined : 'bad'}>
                    <td className="num faint">{time(r.t0)}</td>
                    <td className="mono">{peers[r.from] ?? r.from}</td>
                    <td className="wrap mono req">{r.method ? <><span className={`m-${r.method.toLowerCase()}`}>{r.method}</span> {r.path ?? '/'}{r.query ? `?${r.query}` : ''}</> : <><Kind k={r.kind} />{r.kind === 'tcp' ? ` :${r.port}` : ''}</>}</td>
                    <td>
                      {r.error ? <Status state="err">{r.error}</Status> : r.status !== undefined ? (ok ? <HttpStatus n={r.status} /> : <Status state="err"><HttpStatus n={r.status} /></Status>) : <span className="faint">—</span>}
                      {r.fault && <span className="chip run"><Zap />{r.fault}</span>}
                      {r.mock && <span className="chip">mock: {r.mock}</span>}
                      {r.drift?.length ? <span className="chip err" title={r.drift.join('\n')}>fuera de contrato</span> : null}
                    </td>
                    <td className="r num faint">{r.t1 !== undefined ? secs(r.t1 - r.t0) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
