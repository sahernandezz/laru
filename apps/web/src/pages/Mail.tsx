/**
 * Correo y mensajes: what an env's sinks received, in three panes like «Bases»: the list, the message, and where it came
 * from with its codes and links. Nothing here leaves the machine. The message's HTML is drawn in a frame with no scripts and
 * no network (its own document, its own policy); a code or a link with a token shows as it arrived, marked as such.
 */
import { CircleX, Copy, ExternalLink, Mail as MailIcon, MessageSquare, Paperclip, Send, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, apiUrl, useApi, type EnvSummary } from '../api.ts';
import { Dialog, Segmented, Skeleton, toast } from '../components/ui.tsx';
import { ago, plural } from '../lib/es.ts';
import { href } from '../lib/route.ts';
import { useEnvList } from '../lib/useEnvs.ts';

interface Row { id: string; kind: 'mail' | 'sms'; t: number; from: string; to: string; subject: string; attachments: number; codes: string[]; lints: string[]; status: string; service?: string; direction?: string }
interface Detected { name: string; kind: 'smtp' | 'sms' | 'http'; provider: string; via?: string; services: string[]; intercepted: boolean }
interface Plan { from: string; as: string; file: string; mocks: Record<string, { sink?: string }>; unserved: Detected[]; detected: Detected[]; notes: string[] }
interface MailInfo { env: string; state: string; sinks?: { hasSinks: boolean; egress?: 'open' | 'closed'; sinks: Array<{ name: string; kind: 'smtp' | 'twilio'; ports: Array<{ container: number; host: number }>; containerPorts: number[] }> }; plan: Plan; counts: { all: number; mail: number; sms: number }; messages: Row[] }
interface Link { url: string; text?: string; class: string; open?: string; rewritten?: boolean }
interface Message extends Row {
  envelope?: { from: string; rcpt: string[] }; headers: Array<[string, string]>; text?: string; links: Link[]; remote: Array<{ url: string; why: string }>;
  attachments_: Array<{ name: string; type: string; size: number; sha256: string; inline?: boolean }>; session?: Array<{ d: string; l: string }>;
  states?: Array<{ status: string; t: number; code?: number; callback?: { http?: number; ms?: number; skipped?: string; signed: boolean | string } }>; segments?: { n: number; encoding: string; chars: number };
}

const CLASS: Record<string, string> = { local: 'del entorno', external: 'externo', production: 'producción', tracking: 'rastreo', unsubscribe: 'baja', 'blocked-scheme': 'esquema no permitido' };
const LINT: Record<string, string> = { 'no-body': 'sin cuerpo', 'no-text-part': 'sin parte de texto', 'no-message-id': 'sin Message-ID', 'no-date': 'sin Date', 'line-over-998': 'línea de más de 998 bytes', 'bad-list-unsubscribe': 'List-Unsubscribe mal formado', 'production-link': 'enlace a producción', 'link-text-differs': 'el texto dice una cosa y el enlace va a otra' };
const SMS: Record<string, string> = { queued: 'en cola', sent: 'enviado', delivered: 'entregado', undelivered: 'no entregado', failed: 'fallido', received: 'recibido', accepted: 'aceptado', bounced: 'rebotado' };
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** The ones read in this browser only: a storage that is off just shows everything as read. */
const seenKey = (env: string) => `laru.mail.seen.${env}`;
const readSeen = (env: string): Set<string> => { try { return new Set(JSON.parse(localStorage.getItem(seenKey(env)) ?? '[]') as string[]); } catch { return new Set(); } };
const copy = (t: string) => void navigator.clipboard?.writeText(t).then(() => toast('Copiado'), () => toast('No se pudo copiar'));

export function Mail({ parts }: { parts: string[] }) {
  const [envArg, idArg] = parts;
  const envs = useEnvList();
  const list = envs.data ?? [];
  const env = list.find((e) => e.env === envArg)?.env ?? list.find((e) => e.state === 'ready')?.env ?? list[0]?.env;
  const head = (right?: React.ReactNode) => (
    <div className="head">
      <div><h1>Correo y mensajes de texto</h1><p>Lo que la aplicación envía en este entorno llega aquí y no sale de tu máquina: el correo por SMTP y los SMS por la API de Twilio.</p></div>
      <div className="actions">
        {list.length > 1 && <nav className="seg" aria-label="Entorno">{list.map((e: EnvSummary) => <a key={e.env} href={href('mail', e.env)} aria-current={e.env === env ? 'page' : undefined}>{e.env}</a>)}</nav>}
        {right}
      </div>
    </div>
  );
  if (envs.error) return <div className="page wide">{head()}<div className="notice" role="alert"><CircleX />{envs.error}</div></div>;
  if (!envs.data) return <div className="page wide">{head()}<Skeleton lines={6} /></div>;
  if (!env) return <div className="page wide">{head()}<section className="panel"><div className="empty">Este workspace no tiene entornos. Crea uno en <a className="rowlink" href={href('envs')}>Entornos</a>.</div></section></div>;
  return <Box key={env} env={env} idArg={idArg} head={head} />;
}

function Box({ env, idArg, head }: { env: string; idArg?: string; head: (right?: React.ReactNode) => React.ReactNode }) {
  const [tab, setTab] = useState<'all' | 'mail' | 'sms'>('all');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 250); return () => clearTimeout(t); }, [q]);
  const data = useApi<MailInfo>(`/api/mail?env=${encodeURIComponent(env)}&kind=${tab}&q=${encodeURIComponent(debounced)}`);
  const [seen, setSeen] = useState(() => readSeen(env));
  const [announce, setAnnounce] = useState('');
  const known = useRef<number>(-1);
  const search = useRef<HTMLInputElement>(null);

  // the journal grows → ask again; a message that was not here before is said aloud and marked unread
  useEffect(() => {
    const es = new EventSource(apiUrl(`/api/mail/live?env=${encodeURIComponent(env)}`));
    es.onmessage = () => data.reload();
    return () => es.close();
  }, [env]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = data.data?.counts.all ?? -1;
  useEffect(() => {
    if (known.current >= 0 && total > known.current) setAnnounce(`${plural(total - known.current, 'mensaje nuevo', 'mensajes nuevos')}`);
    if (total >= 0) known.current = total;
  }, [total]);
  const rows = data.data?.messages ?? [];
  const sel = rows.find((r) => r.id === idArg);
  const open = (id?: string) => { location.hash = id ? href('mail', env, id) : href('mail', env); };
  const markSeen = (id: string) => setSeen((s) => { if (s.has(id)) return s; const n = new Set(s).add(id); try { localStorage.setItem(seenKey(env), JSON.stringify([...n].slice(-500))); } catch { /* not kept */ } return n; });
  useEffect(() => { if (idArg) markSeen(idArg); }, [idArg]); // eslint-disable-line react-hooks/exhaustive-deps

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, textarea, select')) { if (e.key === 'Escape') (e.target as HTMLElement).blur(); return; }
    const i = rows.findIndex((r) => r.id === idArg);
    if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); open(rows[Math.min(rows.length - 1, i + 1)]?.id); }
    else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); open(rows[Math.max(0, i - 1)]?.id); }
    else if (e.key === 'Escape') open();
    else if (e.key === '/') { e.preventDefault(); search.current?.focus(); }
  };

  const [clearing, setClearing] = useState(false);
  const clear = async () => {
    try { await api('/api/mail/clear', { method: 'POST', body: { env } }); toast('Buzón vaciado'); setClearing(false); open(); data.reload(); } catch (e) { toast((e as Error).message); }
  };

  const state = data.data?.state;
  const hasSinks = data.data?.sinks?.hasSinks;
  const right = hasSinks && (data.data?.counts.all ?? 0) > 0 ? <button type="button" className="btn" onClick={() => setClearing(true)}><Trash2 />Vaciar buzón</button> : undefined;
  if (data.error) return <div className="page wide">{head()}<div className="notice" role="alert"><CircleX />{data.error}</div></div>;
  if (!data.data) return <div className="page wide">{head()}<Skeleton lines={6} /></div>;
  const d = data.data;
  if (state !== 'ready' && state !== 'starting') {
    return <div className="page wide">{head()}<section className="panel"><div className="empty"><span>{env} no está en marcha. Un entorno parado no tiene buzón: se vacía al parar. Levántalo en <a className="rowlink" href={href('envs', env)}>Estado y servicios</a> para recibir correo y SMS.</span></div></section></div>;
  }
  if (!hasSinks) return <div className="page wide">{head()}<Detection env={env} info={d} reload={data.reload} /></div>;
  const smtp = d.sinks!.sinks.find((s) => s.kind === 'smtp');
  const port = smtp?.ports.find((p) => p.container === 587)?.host ?? smtp?.ports[0]?.host;
  return (
    <div className="page flush" onKeyDown={onKey}>
      <div className="mbx-head">{head(right)}
        <p className="faint mbx-line">{d.sinks!.sinks.map((s) => s.kind === 'smtp' ? `SMTP ${s.name} ${s.containerPorts.join(' ')}` : `SMS ${s.name} (Twilio)`).join(' · ')} · Salida a internet: {d.sinks!.egress === 'closed' ? 'cerrada' : 'abierta'}</p>
      </div>
      <div className="mbx">
        <aside className="mbx-list" aria-label="Mensajes">
          <div className="mbx-tools">
            <Segmented label="Tipo" value={tab} onChange={setTab} options={[{ key: 'all', label: `Todo ${d.counts.all}` }, { key: 'mail', label: `Correo ${d.counts.mail}` }, { key: 'sms', label: `SMS ${d.counts.sms}` }]} />
            <input ref={search} type="search" className="tree-filter" placeholder="Buscar: de:ana asunto:pedido tiene:adjunto" aria-label="Buscar mensajes" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div aria-live="polite" className="sr-only">{announce}</div>
          {d.counts.all === 0 ? (
            <div className="empty">
              <span>Aún no ha llegado nada. Usa la aplicación: cada correo o SMS que envíe aparece aquí.</span>
              {port && <p className="faint">Para probar sin ella: <code className="mono">swaks --server 127.0.0.1:{port} --to ana@x.test --from yo@x.test --body hola</code> <button type="button" className="icon" aria-label="Copiar" onClick={() => copy(`swaks --server 127.0.0.1:${port} --to ana@x.test --from yo@x.test --body hola`)}><Copy /></button></p>}
            </div>
          ) : rows.length === 0 ? <div className="empty"><span>Ningún mensaje coincide con la búsqueda.</span></div> : (
            <ul role="listbox" aria-label="Mensajes">
              {rows.map((r) => (
                <li key={r.id} role="option" aria-selected={r.id === idArg}>
                  <a href={href('mail', env, r.id)} className={`mbx-row${r.id === idArg ? ' on' : ''}${seen.has(r.id) ? '' : ' unread'}`}>
                    <span className="mbx-ico">{r.kind === 'mail' ? <MailIcon /> : <MessageSquare />}</span>
                    <span className="mbx-main"><b>{r.kind === 'sms' ? (r.direction === 'inbound' ? r.from : r.to) : r.subject || '(sin asunto)'}</b>
                      <span className="faint">{r.kind === 'sms' ? r.subject.slice(0, 60) : r.to}{r.attachments ? ` · ${r.attachments} adj.` : ''}</span>
                      {r.lints.length > 0 && <span className="mbx-warn">{LINT[r.lints[0]] ?? r.lints[0]}{r.lints.length > 1 ? ` y ${r.lints.length - 1} más` : ''}</span>}
                    </span>
                    <time className="faint" dateTime={new Date(r.t).toISOString()}>{ago(new Date(r.t).toISOString())}</time>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </aside>
        {sel ? <View key={sel.id} env={env} id={sel.id} reload={data.reload} /> : <div className="mbx-empty"><span>{d.counts.all ? 'Elige un mensaje.' : ''}</span></div>}
      </div>
      {clearing && (
        <Dialog title="Vaciar el buzón" onClose={() => setClearing(false)}>
          <p>Se borran los {d.counts.all} mensajes de {env}. Lo que importa de ellos ya está copiado, enmascarado, en los runs.</p>
          <div className="actions"><button type="button" className="btn" onClick={() => setClearing(false)}>Cancelar</button><button type="button" className="btn danger" onClick={() => void clear()}>Vaciar buzón</button></div>
        </Dialog>
      )}
    </div>
  );
}

function View({ env, id, reload }: { env: string; id: string; reload: () => void }) {
  const m = useApi<Message>(`/api/mail/message?env=${encodeURIComponent(env)}&id=${encodeURIComponent(id)}`);
  const [tab, setTab] = useState('view');
  const [width, setWidth] = useState<'375' | '768' | '1200'>('768');
  const [source, setSource] = useState<string>();
  useEffect(() => { if (tab === 'source' && source === undefined && m.data?.kind === 'mail') void fetch(apiUrl(`/api/mail/eml?env=${encodeURIComponent(env)}&id=${id}`)).then((r) => r.text()).then((t) => setSource(t.slice(0, 256 * 1024)), () => setSource('(no se pudo leer el original)')); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps
  if (m.error) return <div className="mbx-view"><div className="notice" role="alert"><CircleX />{m.error}</div></div>;
  if (!m.data) return <div className="mbx-view"><Skeleton lines={6} /></div>;
  const x = m.data;
  const mark = async (status: string, code?: number) => { try { await api('/api/mail/sms-status', { method: 'POST', body: { env, id, status, code } }); toast('Estado enviado a la aplicación'); setTimeout(() => { m.reload(); reload(); }, 800); } catch (e) { toast((e as Error).message); } };
  return (
    <>
      <section className="mbx-view" aria-label={x.kind === 'mail' ? x.subject : x.to}>
        {x.kind === 'mail' ? (
          <>
            <h2>{x.subject || '(sin asunto)'}</h2>
            <dl className="mbx-hdr">
              <dt>De</dt><dd>{x.from}</dd>
              <dt>Para</dt><dd>{x.to}</dd>
              {x.envelope && x.envelope.rcpt.filter((r) => !x.to.includes(r)).length > 0 && <><dt>Cco</dt><dd>{x.envelope.rcpt.filter((r) => !x.to.includes(r)).join(', ')} <span className="faint">(solo en el sobre)</span></dd></>}
            </dl>
            <nav className="seg mbx-tabs" aria-label="Partes del mensaje">
              {[['view', 'Vista'], ['text', 'Texto'], ['source', 'Fuente'], ['headers', 'Cabeceras'], ['att', `Adjuntos ${x.attachments_.length}`]].map(([k, l]) => <button key={k} type="button" aria-current={tab === k ? 'page' : undefined} onClick={() => setTab(k)}>{l}</button>)}
            </nav>
            {tab === 'view' && (
              <div className="mbx-frame">
                <Segmented label="Ancho" value={width} onChange={setWidth} className="seg mbx-width" options={[{ key: '375', label: '375' }, { key: '768', label: '768' }, { key: '1200', label: '1200' }]} />
                <iframe title="Mensaje" sandbox="" referrerPolicy="no-referrer" src={apiUrl(`/api/mail/html?env=${encodeURIComponent(env)}&id=${encodeURIComponent(id)}&width=${width}`)} style={{ width: `min(100%, ${width}px)` }} />
                {x.remote.length > 0 && <p className="faint">Intentó cargar {x.remote.map((r) => `${new URL(r.url, 'http://x').host} (${r.why})`).join(', ')}: no se cargó.</p>}
              </div>
            )}
            {tab === 'text' && <pre className="mbx-text">{x.text || '(sin parte de texto)'}</pre>}
            {tab === 'source' && <pre className="mbx-text">{source ?? 'Leyendo…'}</pre>}
            {tab === 'headers' && (
              <div className="mbx-text">
                <dl className="mbx-hdr">{x.headers.map(([k, v], i) => <div key={i} className="contents"><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
                {x.envelope && <p><b>Sobre</b> MAIL FROM {x.envelope.from || '<>'} · RCPT TO {x.envelope.rcpt.join(', ')}</p>}
                {x.session && x.session.length > 0 && <><b>Sesión SMTP</b><pre>{x.session.map((l) => `${l.d === 'c' ? 'C' : 'S'}: ${l.l}`).join('\n')}</pre></>}
              </div>
            )}
            {tab === 'att' && (x.attachments_.length === 0 ? <p className="faint">Sin adjuntos.</p> : (
              <ul className="mbx-att">{x.attachments_.map((a, i) => <li key={i}><Paperclip /><span>{a.name}</span><span className="faint">{a.type} · {size(a.size)}</span>{!a.inline && <a className="btn" href={apiUrl(`/api/mail/part?env=${encodeURIComponent(env)}&id=${encodeURIComponent(id)}&n=${i}`)} download>Descargar</a>}</li>)}</ul>
            ))}
          </>
        ) : <Thread env={env} x={x} mark={mark} reload={() => { m.reload(); reload(); }} />}
      </section>
      <aside className="mbx-origin" aria-label="Origen, códigos y enlaces">
        <h3>Origen</h3>
        <dl className="mbx-hdr"><dt>Servicio</dt><dd>{x.service ?? '—'}</dd><dt>Hora</dt><dd>{new Date(x.t).toLocaleTimeString('es')}</dd>{x.kind === 'mail' && <><dt>Estado</dt><dd>{SMS[x.status] ?? x.status}</dd></>}</dl>
        {x.lints.length > 0 && <ul className="mbx-lints">{x.lints.map((l) => <li key={l}>{LINT[l] ?? l}</li>)}</ul>}
        {x.codes.length > 0 && <><h3>Códigos <span className="faint">sin enmascarar</span></h3><ul className="mbx-codes">{x.codes.map((c) => <li key={c}><code className="mono">{c}</code><button type="button" className="btn" onClick={() => copy(c)}>Copiar</button></li>)}</ul></>}
        {x.links.length > 0 && (
          <><h3>Enlaces <span className="faint">sin enmascarar</span></h3>
            <ul className="mbx-links">{x.links.map((l, i) => (
              <li key={i}><span className={`tag ${l.class}`}>{CLASS[l.class] ?? l.class}</span> <span className="mono mbx-url">{l.url}</span>
                {l.text && /^https?:\/\//i.test(l.text) && l.text !== l.url && <span className="mbx-warn">el texto dice una cosa y el enlace va a otra</span>}
                <span className="mbx-act">{l.open && /^https?:\/\//.test(l.open) && <a className="btn" href={l.open} target="_blank" rel="noreferrer noopener"><ExternalLink />{l.rewritten ? 'Abrir reescrito' : 'Abrir'}</a>}<button type="button" className="btn" onClick={() => copy(l.url)}>Copiar</button></span>
              </li>))}
            </ul></>
        )}
      </aside>
    </>
  );
}

function Thread({ env, x, mark, reload }: { env: string; x: Message; mark: (s: string, code?: number) => void; reload: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const last = x.states?.filter((s) => s.status).at(-1)?.status ?? 'queued';
  const reply = async () => {
    setBusy(true);
    try { const r = await api<{ http?: number; skipped?: string }>('/api/mail/sms-reply', { method: 'POST', body: { env, from: x.direction === 'inbound' ? x.from : x.to, body: text } }); toast(r.skipped ?? `La aplicación respondió ${r.http}`); setText(''); setTimeout(reload, 500); } catch (e) { toast((e as Error).message); }
    setBusy(false);
  };
  const seg = x.segments;
  return (
    <>
      <h2>{x.direction === 'inbound' ? x.from : x.to}</h2>
      <div className={`mbx-bubble${x.direction === 'inbound' ? ' in' : ''}`}>
        <p>{x.text}</p>
        {seg && <small className={seg.n > 1 || seg.encoding === 'UCS-2' ? 'mbx-warn' : 'faint'} title="Un carácter fuera de GSM-7 cambia todo el mensaje a UCS-2: 70 por segmento">{plural(seg.n, 'segmento', 'segmentos')} · {seg.encoding} · {plural(seg.chars, 'carácter', 'caracteres')}</small>}
      </div>
      <ol className="mbx-states" aria-label="Estados">
        {(x.states ?? []).filter((s) => !s.callback).map((s, i) => <li key={i}>{SMS[s.status] ?? s.status} <time className="faint">{new Date(s.t).toLocaleTimeString('es')}</time></li>)}
        {(x.states ?? []).filter((s) => s.callback).map((s, i) => <li key={`c${i}`} className="faint">aviso a la app ({SMS[s.status] ?? s.status}): {s.callback!.skipped ? `no enviado, ${s.callback!.skipped}` : `HTTP ${s.callback!.http} en ${s.callback!.ms} ms`}{s.callback!.signed === false ? ' · sin firma válida' : s.callback!.signed === 'unverifiable' ? ' · aún sin token para firmar' : ''}</li>)}
      </ol>
      {x.direction !== 'inbound' && last !== 'delivered' && last !== 'undelivered' && <div className="actions"><button type="button" className="btn" onClick={() => mark('delivered')}>Marcar entregado</button><button type="button" className="btn" onClick={() => mark('undelivered', 30003)}>Marcar fallido (30003)</button></div>}
      <form className="mbx-reply" onSubmit={(e) => { e.preventDefault(); if (text.trim()) void reply(); }}>
        <label>Responder como {x.direction === 'inbound' ? x.from : x.to}<input className="tree-filter" value={text} onChange={(e) => setText(e.target.value)} placeholder="STOP" /></label>
        <button type="submit" className="btn" disabled={busy || !text.trim()}><Send />Enviar a la app</button>
      </form>
    </>
  );
}

/** An env with no sink: what the map says the app sends, and what «Interceptar» would write before it does. */
function Detection({ env, info, reload }: { env: string; info: MailInfo; reload: () => void }) {
  const [plan, setPlan] = useState(false);
  const [name, setName] = useState('correo');
  const p = info.plan;
  const found = p?.detected ?? [];
  const serve = found.filter((d) => d.kind !== 'http');
  const apply = async () => {
    try { await api('/api/mail/enable', { method: 'POST', body: { env, as: name, confirm: true } }); toast(`envs/${name}.yaml escrito. Levanta ${name} para recibir.`); setPlan(false); reload(); } catch (e) { toast((e as Error).message); }
  };
  return (
    <section className="panel mbx-detect">
      {found.length === 0 ? <div className="empty"><span>Esta aplicación no envía correo ni SMS, según el mapa. Si algo los envía, declara un sumidero en <code className="mono">envs/{env}.yaml</code>: <code className="mono">mocks: {'{'} smtp: {'{'} mode: sink, sink: smtp {'}'} {'}'}</code>.</span></div> : (
        <>
          <h2>{env} no tiene buzón</h2>
          <ul>{found.map((d) => <li key={d.name}><b>{d.services.join(', ')}</b> envía {d.kind === 'sms' ? 'SMS' : 'correo'} ({d.provider}{d.via ? `, ${d.via}` : ''}).{' '}
            {d.kind === 'http' ? <span className="mbx-warn">Lo envía por la API de {d.provider}, que el buzón no sirve; puede salir correo real. Usa SMTP en local.</span> : d.intercepted ? <span>Recibido aquí.</span> : <span className="mbx-warn">Puede salir correo real mientras no se intercepte.</span>}</li>)}</ul>
          {serve.length > 0 && <button type="button" className="btn primary" onClick={() => setPlan(true)}>Interceptar</button>}
        </>
      )}
      {plan && (
        <Dialog title="Interceptar" onClose={() => setPlan(false)}>
          <p>Se crea <code className="mono">envs/{name}.yaml</code>, que parte de {env} y recibe en vez de enviar:</p>
          <ul>{Object.entries(p.mocks).map(([n, m]) => <li key={n}><code className="mono">{n}</code> → {m.sink === 'smtp' ? 'buzón SMTP (25, 465, 587, 1025, 2525)' : 'buzón de SMS de Twilio'}</li>)}</ul>
          <label>Nombre del entorno <input className="tree-filter" value={name} onChange={(e) => setName(e.target.value.replace(/[^a-z0-9-]/g, ''))} /></label>
          <p className="faint">Nada se levanta ni se borra: después lo arrancas tú.</p>
          <div className="actions"><button type="button" className="btn" onClick={() => setPlan(false)}>Cancelar</button><button type="button" className="btn primary" disabled={!name} onClick={() => void apply()}>Escribir envs/{name}.yaml</button></div>
        </Dialog>
      )}
    </section>
  );
}
