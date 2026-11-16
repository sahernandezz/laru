/**
 * Queues: the env's Kafka and RabbitMQ, read through their own tools, with a switch when it has both. Kafka: each topic
 * with its partitions and how far behind each consumer group is, and the last messages (masked). RabbitMQ: each queue
 * with what is ready, unacknowledged and who consumes it, its bindings, and a read that puts the messages back (marked
 * redelivered, and refused where that could drop one). Publishing shows exactly what goes out before it does.
 */
import { CircleX, Eye, RefreshCw, Send } from 'lucide-react';
import { Fragment, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { api, recordedRun, useApi, useRecorded, type BrokerInfo, type SqsMessageInfo, type SqsQueueInfo, type TopicContract, type EnvSummary, type KafkaLine, type MocksData, type QueuesData, type RabbitData, type RabbitMessage, type RabbitRoute } from '../api.ts';
import { Code, CodeBlock, Dialog, Segmented, Skeleton, Status, toast } from '../components/ui.tsx';
import { langOf } from '../lib/syntax.ts';
import { ago, bindingMatch, isDefaultExchange, plural, rabbitText, routeText } from '../lib/es.ts';
import { useEnvList } from '../lib/useEnvs.ts';
import { href } from '../lib/route.ts';
import { CustomView, type CustomStoreInfo } from './Custom.tsx';
import { MESSAGING } from './Data.tsx';
import { tr, LOCALE } from '../lib/i18n.ts';

const nf = new Intl.NumberFormat(LOCALE);
type Group = QueuesData['groups'][number];

/** A group's lag on one topic: the sum over partitions that have a committed offset; null when none has. */
function lagOf(rows: Group[]): number | null {
  const known = rows.filter((r) => r.lag !== null);
  return known.length ? known.reduce((s, r) => s + r.lag!, 0) : null;
}

export function Queues({ parts }: { parts: string[] }) {
  // #/queues/<env>/<broker>/<topic or queue>; an address without the broker (#/queues/<env>/<topic>) is Kafka's.
  const [envArg, a, b] = parts;
  const brokerArg = a === 'kafka' || a === 'rabbitmq' || a === 'sqs' || a?.startsWith('custom:') ? a : undefined;
  const nameArg = brokerArg ? b : a;
  const envs = useEnvList();
  const list = envs.data ?? [];
  // on a run's recording the env is the one recorded, on or off: what it shows is the run's
  const recorded = useRecorded();
  const env = recorded ? envArg : list.find((e) => e.env === envArg)?.env ?? list.find((e) => e.state === 'ready')?.env ?? list[0]?.env;
  const ready = Boolean(recorded) || list.find((e) => e.env === env)?.state === 'ready';
  const known = useApi<BrokerInfo[]>(env && ready ? `/api/brokers?env=${encodeURIComponent(env)}` : null);
  // any other broker laru.yaml explains (`stores.<name>.explore`), after the ones Laru reads itself
  const customs = useApi<CustomStoreInfo[]>(env && ready ? `/api/custom/stores?env=${encodeURIComponent(env)}` : null);
  const declared = (customs.data ?? []).filter((s) => MESSAGING.test(s.kind));
  const brokers = { ...known, data: known.data && (customs.data || customs.error) ? [...known.data, ...declared.map((s) => ({ kind: `custom:${s.service}`, service: s.service }) as unknown as BrokerInfo)] : undefined };
  const broker = brokers.data?.find((x) => x.kind === brokerArg) ?? brokers.data?.[0];
  const custom = broker?.kind.startsWith('custom:') ? declared.find((s) => `custom:${s.service}` === broker.kind) : undefined;

  const head = (
    <div className="head">
      <div><h1>{tr('Colas')}</h1><p>{tr('Los brokers del entorno: los temas de Kafka con lo que lleva cada consumidor de retraso, y las colas de RabbitMQ con sus enlaces. Publicar enseña antes el mensaje exacto.')}</p></div>
      <div className="actions">
        {!recorded && list.length > 1 && <nav className="seg" aria-label={tr('Entorno')}>{list.map((e) => <a key={e.env} href={href('queues', e.env)} aria-current={e.env === env ? 'page' : undefined}>{e.env}</a>)}</nav>}
        {env && broker && (brokers.data?.length ?? 0) > 1 && (
          <Segmented label={tr('Broker')} value={broker.kind} onChange={(k) => { location.hash = href('queues', env, k); }}
            options={brokers.data!.map((x) => ({ key: x.kind, label: <>{x.kind === 'kafka' ? 'Kafka' : x.kind === 'sqs' ? tr('SQS') : x.kind === 'rabbitmq' ? 'RabbitMQ' : declared.find((s) => `custom:${s.service}` === x.kind)?.kind ?? x.kind} <span className="mono faint">{x.service}</span></> }))} />
        )}
      </div>
    </div>
  );
  if (envs.error) return <div className="page wide">{head}<div className="notice" role="alert"><CircleX />{envs.error}</div></div>;
  if (!envs.data) return <div className="page wide">{head}<Skeleton lines={5} /></div>;
  if (!env) return <div className="page wide">{head}<section className="panel"><div className="empty">{tr('Este workspace no tiene entornos. Crea uno en')}{' '}<a className="rowlink" href={href('envs')}>{tr('Entornos')}</a>{tr(': sus colas aparecen aquí al levantarlo.')}</div></section></div>;
  if (!ready) return <div className="page wide">{head}<section className="panel"><div className="empty"><span>{env}{' '}{tr('no está en marcha. Levántalo en')}{' '}<a className="rowlink" href={href('envs', env)}>{tr('Entornos')}</a>{' '}{tr('o con')}{' '}<code>laru up {env}</code>.</span></div></section><TopicContracts /></div>;
  if (brokers.error) return <div className="page wide">{head}<div className="notice" role="alert"><CircleX />{brokers.error}</div></div>;
  if (!brokers.data) return <div className="page wide">{head}<Skeleton lines={5} /><div style={{ height: 16 }} /><Skeleton lines={6} /></div>;
  if (!broker) return <div className="page wide">{head}<section className="panel"><div className="empty">{env}{' '}{tr('no tiene colas en marcha que Laru sepa leer. Kafka, Redpanda, RabbitMQ y SQS aparecen solos; cualquier otro broker aparece si laru.yaml dice cómo leerlo, en')}{' '}<code>{tr('stores.<nombre>.explore')}</code>.</div></section><TopicContracts /></div>;
  return (
    <div className="page wide">
      {head}
      {custom ? <CustomView key={`${env}/${custom.service}`} env={env} nav={null} store={custom} tableArg={nameArg} at={(n) => href('queues', env, broker.kind, n)} />
        : broker.kind === 'kafka' ? <KafkaView key={env} env={env} topicArg={nameArg} /> : broker.kind === 'sqs' ? <SqsView key={env} env={env} queueArg={nameArg} /> : <RabbitView key={env} env={env} queueArg={nameArg} />}
      <TopicContracts />
    </div>
  );
}

function KafkaView({ env, topicArg }: { env: string; topicArg?: string }) {
  const q = useApi<QueuesData>(`/api/queues?env=${encodeURIComponent(env)}`);
  // The tap knows which container IP is which service: consumers read better by name. Optional.
  const tap = useApi<MocksData>(`/api/mocks?env=${encodeURIComponent(env)}`);
  const who = (host?: string) => (host ? tap.data?.rules.peers[host] ?? host : undefined);
  const d = q.data;
  const topic = d?.topics.find((t) => t.name === topicArg) ?? d?.topics[0];
  if (q.error) return <div className="notice" role="alert"><CircleX />{q.error}</div>;
  if (!d) return <><Skeleton lines={5} /><div style={{ height: 16 }} /><Skeleton lines={6} /></>;

  return (
    <>
      <section className="panel block" aria-labelledby="topics-h">
        <header>
          <h3 id="topics-h">{plural(d.topics.length, tr('tema'), tr('temas'))}{' '}{tr('en')}{' '}<span className="mono">{d.broker}</span></h3>
          <div className="meta"><button className="btn sm" onClick={q.reload} aria-busy={q.loading || undefined}><RefreshCw className={q.loading ? 'spin' : undefined} />{tr('Actualizar')}</button></div>
        </header>
        {!d.topics.length ? <div className="empty">{tr('El broker no tiene temas todavía. Se crean con el primer mensaje que alguien publica.')}</div> : (
          <div className="scroll-x">
            <table className="t">
              <thead><tr><th>{tr('Tema@@Kafka')}</th><th className="r">{tr('Particiones')}</th><th className="r">{tr('Mensajes')}</th><th>{tr('Consumidores y su retraso')}</th></tr></thead>
              <tbody>
                {d.topics.map((t) => {
                  const groups = Map.groupBy(d.groups.filter((g) => g.topic === t.name), (g) => g.group);
                  return (
                    <tr key={t.name} className={t === topic ? 'sel' : undefined}>
                      <td><a className="rowlink mono" href={href('queues', env, 'kafka', t.name)} aria-current={t === topic ? 'true' : undefined} style={{ fontWeight: 500 }}>{t.name}</a></td>
                      <td className="r num">{t.partitions.length}</td>
                      <td className="r num">{nf.format(t.messages)}</td>
                      <td className="wrap">
                        <span className="lags">
                          {[...groups].map(([g, rows]) => { const lag = lagOf(rows); return <span key={g} className={`chip${lag ? ' run' : ''}`} title={`${g}: ${lag === null ? tr('sin offset confirmado') : tr('{lag} por leer', { lag })}`}>{g} · {lag === null ? tr('sin confirmar') : lag ? tr('{format} por leer', { format: nf.format(lag) }) : tr('al día')}</span>; })}
                          {!groups.size && <span className="faint">{tr('Nadie lo consume')}</span>}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {topic && <TopicView key={`${env}/${topic.name}`} env={env} topic={topic.name} groups={d.groups.filter((g) => g.topic === topic.name)} who={who} onPublished={q.reload} />}
    </>
  );
}

function TopicView({ env, topic, groups, who, onPublished }: { env: string; topic: string; groups: Group[]; who: (h?: string) => string | undefined; onPublished: () => void }) {
  const peek = useApi<KafkaLine[]>(`/api/queue/peek?env=${encodeURIComponent(env)}&topic=${encodeURIComponent(topic)}&limit=20`);
  const [publishing, setPublishing] = useState(false);
  const byGroup = Map.groupBy(groups, (g) => g.group);
  return (
    <div className="grid cols-2 topic-view">
      <section className="panel" aria-labelledby="groups-h">
        <header><h3 id="groups-h">{tr('Quién lee')}{' '}<span className="mono">{topic}</span></h3><div className="meta">{plural(byGroup.size, tr('grupo'), tr('grupos'))}</div></header>
        {!groups.length ? <div className="empty">{tr('Ningún grupo de consumidores lee este tema: lo publicado se queda sin leer.')}</div> : (
          <div className="scroll-x">
            <table className="t">
              <thead><tr><th>{tr('Grupo')}</th><th>{tr('Consumidor')}</th><th className="r">{tr('Partición')}</th><th className="r">{tr('Leído')}</th><th className="r">{tr('Retraso')}</th></tr></thead>
              <tbody>
                {[...byGroup].flatMap(([g, rows]) => rows.sort((a, b) => a.partition - b.partition).map((r, i) => {
                  // Each partition says who reads it; a repeat of the row above is said only to screen readers.
                  const reader = who(r.host) ?? <span className="faint">{tr('sin consumidor activo')}</span>;
                  const again = i > 0 && rows[i - 1].host === r.host;
                  return (
                    <tr key={`${g}/${r.partition}`}>
                      <td className="mono wrap">{i === 0 ? g : <span className="sr-only">{g}</span>}</td>
                      <td className="mono wrap">{again ? <span className="sr-only">{reader}</span> : reader}</td>
                      <td className="r num">{r.partition}</td>
                      <td className="r num">{r.current ?? <span className="faint">—</span>} <span className="faint">{tr('de')}{' '}{r.end}</span></td>
                      <td className="r num">{r.lag === null ? <span className="faint" title={tr('El grupo no ha confirmado ningún offset en esta partición')}>{tr('sin confirmar')}</span> : r.lag ? <Status state="run">{nf.format(r.lag)}</Status> : <span className="faint">0</span>}</td>
                    </tr>
                  );
                }))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel" aria-labelledby="msgs-h">
        <header>
          <h3 id="msgs-h">{tr('Últimos mensajes')}</h3>
          <div className="meta">
            <button className="btn sm" onClick={peek.reload} aria-busy={peek.loading || undefined}><RefreshCw className={peek.loading ? 'spin' : undefined} />{tr('Actualizar')}</button>
            {!recordedRun() && <button className="btn sm" onClick={() => setPublishing(true)}><Send />{tr('Publicar')}</button>}
          </div>
        </header>
        {peek.error ? <div className="notice" role="alert" style={{ margin: 12 }}><CircleX />{peek.error}</div>
          : !peek.data ? <div className="body" style={{ display: 'grid', gap: 10 }}>{[80, 64, 72].map((w) => <div key={w} className="sk" style={{ height: 14, width: `${w}%` }} />)}</div>
          : !peek.data.length ? <div className="empty">{tr('El tema no tiene mensajes en el registro del broker.')}</div>
          : (
            <ol className="msgs" aria-label={tr('Últimos mensajes de {topic}', { topic })}>
              {peek.data.map((m) => (
                <li key={`${m.partition}/${m.offset}`}>
                  <div className="msg-h">
                    <span className="mono faint">{tr('p')}{m.partition} · {m.offset}</span>
                    {m.key && <span className="mono key" title={m.key}>{m.key}</span>}
                    <span className="grow" />
                    <span className="faint" title={new Date(m.t).toLocaleString(LOCALE)}>{ago(new Date(m.t).toISOString())}</span>
                  </div>
                  {m.value ? <CodeBlock className="json msg-v" text={m.value} lang={langOf(m.value)} format label={tr('Valor del mensaje {offset}', { offset: m.offset })} /> : <span className="faint">{tr('Sin valor')}</span>}
                </li>
              ))}
            </ol>
          )}
      </section>
      {publishing && <Publish env={env} topic={topic} readers={[...byGroup.keys()]} onClose={() => setPublishing(false)} onDone={() => { peek.reload(); onPublished(); }} />}
    </div>
  );
}

/** Two steps: write, then read exactly what goes out and to whom. Nothing is sent before «Publicar». */
function Publish({ env, topic, readers, onClose, onDone }: { env: string; topic: string; readers: string[]; onClose: () => void; onDone: () => void }) {
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [review, setReview] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ids = useId();
  const box = useRef<HTMLDivElement>(null);
  const stepped = useRef(false);
  // The button that switched the step is gone: focus goes to the new step's first thing.
  useEffect(() => {
    if (stepped.current) box.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    stepped.current = true;
  }, [review]);

  const toReview = (e: FormEvent) => {
    e.preventDefault();
    let line = value.trim();
    try { line = JSON.stringify(JSON.parse(line)); } catch { /* not JSON: sent as typed */ }
    if (!line) { setError(tr('Escribe el valor del mensaje.')); return; }
    if (/[\r\n]/.test(line)) { setError(tr('Un mensaje es una sola línea. Si es JSON, revisa que sea válido: así se compacta solo.')); return; }
    if (/[\t\r\n]/.test(key)) { setError(tr('La clave no puede llevar tabuladores ni saltos de línea.')); return; }
    setError('');
    setReview(line);
  };
  const publish = async () => {
    if (busy || review === null) return;
    setBusy(true);
    setError('');
    try {
      await api('/api/queue/publish', { method: 'POST', body: { env, topic, value: review, key: key || undefined } });
      toast(tr('Publicado en {topic}', { topic }));
      onDone();
      onClose();
    } catch (err) { setError((err as Error).message); setBusy(false); }
  };

  return (
    <Dialog title={review === null ? tr('Publicar en {topic}', { topic }) : tr('Revisa el mensaje')} onClose={onClose} wide>
      <div ref={box}>
        {review === null ? (
          <form onSubmit={toReview} noValidate>
            <div className="dlg-body form">
              <div className="fld">
                <label className="l" htmlFor={`${ids}-k`}>{tr('Clave, si lleva')}</label>
                <input id={`${ids}-k`} className="mono" data-autofocus value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" spellCheck={false} aria-describedby={`${ids}-kh`} />
                <span className="h" id={`${ids}-kh`}>{tr('Kafka reparte por clave: los mensajes con la misma clave van a la misma partición.')}</span>
              </div>
              <div className="fld">
                <label className="l" htmlFor={`${ids}-v`}>{tr('Valor')}</label>
                <textarea id={`${ids}-v`} className="mono" rows={7} value={value} onChange={(e) => setValue(e.target.value)} spellCheck={false} aria-describedby={`${ids}-vh`} />
                <span className="h" id={`${ids}-vh`}>{tr('Una línea por mensaje. Un JSON se compacta en una línea antes de enviarlo.')}</span>
              </div>
              {error && <p className="form-err" role="alert">{error}</p>}
            </div>
            <footer>
              <button type="button" className="btn" onClick={onClose}>{tr('Cancelar')}</button>
              <button className="btn primary" aria-busy={busy || undefined}>{tr('Revisar')}</button>
            </footer>
          </form>
        ) : (
          <>
            <div className="dlg-body">
              <p>{tr('Se publicará un mensaje en')}{' '}<span className="mono">{topic}</span>{' '}{tr('de')}{' '}{env}{key ? <>{tr(', con la clave')}{' '}<span className="mono">{key}</span></> : tr(', sin clave')}:</p>
              <CodeBlock className="ctx sql-preview" text={review} lang={langOf(review)} label={tr('El mensaje')} autoFocus />
              <p className="faint">{readers.length ? tr('Lo leerán {join}, como si lo hubiera publicado un servicio.', { join: readers.join(', ') }) : tr('Ningún grupo lee este tema ahora: se quedará en el broker.')}{' '}{tr('No se puede retirar.')}</p>
              {error && <p className="form-err" role="alert">{error}</p>}
            </div>
            <footer>
              <button type="button" className="btn" onClick={() => setReview(null)}>{tr('Volver')}</button>
              <button type="button" className="btn destroy" aria-disabled={busy || undefined} onClick={publish}><Send className={busy ? 'spin' : undefined} />{tr('Publicar')}</button>
            </footer>
          </>
        )}
      </div>
    </Dialog>
  );
}

// ---------- RabbitMQ ----------

type Binding = RabbitData['bindings'][number];
const PEEK = 5;
const exchangeName = (x: string) => x || tr('(por defecto)');

function RabbitView({ env, queueArg }: { env: string; queueArg?: string }) {
  const r = useApi<RabbitData>(`/api/rabbit/queues?env=${encodeURIComponent(env)}`);
  const [publishing, setPublishing] = useState(false);
  if (r.error) return <div className="notice" role="alert"><CircleX />{r.error}</div>;
  if (!r.data) return <><Skeleton lines={5} /><div style={{ height: 16 }} /><Skeleton lines={6} /></>;
  const d = r.data;
  const queues = [...d.queues].sort((x, y) => x.name.localeCompare(y.name));
  const queue = queues.find((q) => q.name === queueArg) ?? queues[0];

  return (
    <>
      <section className="panel block" aria-labelledby="rq-h">
        <header>
          <h3 id="rq-h">{plural(queues.length, tr('cola'), tr('colas'))}{' '}{tr('en')}{' '}<span className="mono">{d.broker}</span></h3>
          <div className="meta">
            <button className="btn sm" onClick={r.reload} aria-busy={r.loading || undefined}><RefreshCw className={r.loading ? 'spin' : undefined} />{tr('Actualizar')}</button>
            {!recordedRun() && <button className="btn sm" onClick={() => setPublishing(true)}><Send />{tr('Publicar')}</button>}
          </div>
        </header>
        {!queues.length ? <div className="empty">{tr('RabbitMQ no tiene colas todavía. Se declaran cuando un servicio arranca y las pide.')}</div> : (
          <div className="scroll-x">
            <table className="t">
              <thead><tr><th>{tr('Cola')}</th><th>{tr('Tipo')}</th><th className="r">{tr('Listos')}</th><th className="r" title={tr('Entregados a un consumidor que aún no los ha confirmado')}>{tr('Sin confirmar')}</th><th className="r">{tr('Consumidores')}</th></tr></thead>
              <tbody>
                {queues.map((q) => (
                  <tr key={q.name} className={q === queue ? 'sel' : undefined}>
                    <td className="wrap"><a className="rowlink mono" href={href('queues', env, 'rabbitmq', q.name)} aria-current={q === queue ? 'true' : undefined} style={{ fontWeight: 500 }}>{q.name}</a></td>
                    <td><span className="kind">{q.type}</span></td>
                    <td className="r num">{q.messages_ready ? nf.format(q.messages_ready) : <span className="faint">0</span>}</td>
                    <td className="r num">{q.messages_unacknowledged ? <Status state="run">{nf.format(q.messages_unacknowledged)}</Status> : <span className="faint">0</span>}</td>
                    <td className="r num">{q.consumers ? nf.format(q.consumers) : <span className="faint" title={tr('Nadie la consume: lo publicado se queda en la cola')}>0</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {queue && <QueueView key={`${env}/${queue.name}`} env={env} queue={queue.name} type={queue.type} bindings={d.bindings.filter((b) => b.destination_kind === 'queue' && b.destination_name === queue.name)} typeOf={(x) => d.exchanges.find((e) => e.name === x)?.type} onRead={r.reload} />}
      {publishing && <RabbitPublish env={env} exchanges={[...new Set(d.bindings.map((b) => b.source_name).filter(Boolean))].sort()} routingKey={queue?.name ?? ''} onClose={() => setPublishing(false)} onDone={r.reload} />}
    </>
  );
}

/**
 * How messages reach the queue, and a read that is an explicit operation: it puts them back, marked redelivered. A
 * quorum queue puts them back at its end, so the read changes its order: that asks first, saying so. A stream has none.
 */
function QueueView({ env, queue, type, bindings, typeOf, onRead }: { env: string; queue: string; type: string; bindings: Binding[]; typeOf: (exchange: string) => string | undefined; onRead: () => void }) {
  const [peek, setPeek] = useState<{ data?: RabbitMessage[]; error?: string; loading: boolean }>({ loading: false });
  const [asking, setAsking] = useState(false);
  const stream = type === 'stream', quorum = type === 'quorum';
  const read = async () => {
    if (peek.loading) return;
    setPeek((p) => ({ ...p, loading: true }));
    try { setPeek({ data: await api<RabbitMessage[]>('/api/rabbit/get', { method: 'POST', body: { env, queue, count: PEEK, reorder: quorum } }), loading: false }); onRead(); } catch (e) { setPeek({ error: rabbitText((e as Error).message), loading: false }); }
  };
  return (
    <div className="grid cols-2 topic-view">
      <section className="panel" aria-labelledby="bind-h">
        <header><h3 id="bind-h">{tr('Cómo llega a')}{' '}<span className="mono">{queue}</span></h3><div className="meta">{plural(bindings.length, tr('enlace'), tr('enlaces'))}</div></header>
        {!bindings.length ? <div className="empty">{tr('Ningún intercambio la enlaza.')}</div> : (
          <div className="scroll-x">
            <table className="t">
              <thead><tr><th>{tr('Intercambio')}</th><th>{tr('Clave de enrutado')}</th></tr></thead>
              <tbody>
                {bindings.map((b, i) => {
                  const match = bindingMatch(typeOf(b.source_name), b.routing_key);
                  return (
                    <tr key={i}>
                      <td className="mono wrap">{b.source_name ? b.source_name : <span className="faint">{tr('(por defecto)')}</span>}</td>
                      <td className="mono wrap">{match ? <span className="faint" title={match.hint}>{match.label}</span> : <Code text={b.routing_key} lang="text" />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel" aria-labelledby="rmsgs-h">
        <header>
          <h3 id="rmsgs-h">{tr('Mensajes')}</h3>
          {!stream && !recordedRun() && <div className="meta"><button className="btn sm" onClick={() => (quorum ? setAsking(true) : read())} aria-busy={peek.loading || undefined}><Eye className={peek.loading ? 'spin' : undefined} />{peek.data ? tr('Leer otra vez') : tr('Leer los primeros {PEEK}', { PEEK })}</button></div>}
        </header>
        {stream ? <p className="faint peek-note">{tr('Es una cola stream: un consumidor de streams la lee desde un offset, y nada saca un mensaje para devolverlo. Desde aquí no se lee; usa un consumidor propio.')}</p>
          : quorum ? <p className="faint peek-note">{tr('Es una cola quorum: leer saca los primeros')}{' '}{PEEK}{' '}{tr('mensajes y RabbitMQ los devuelve al final de la cola, detrás de los demás. El orden cambia y quedan marcados como reentregados, así que pide confirmación. Donde devolverlos cuenta como una entrega hacia un límite, no se leen.')}</p>
          : <p className="faint peek-note">{tr('Leer saca los primeros')}{' '}{PEEK}{' '}{tr('mensajes y los devuelve a la cola al momento, en su sitio: RabbitMQ los marca como reentregados, y un consumidor que mire esa marca puede tratarlos distinto.')}</p>}
        {peek.error ? <div className="notice" role="alert" style={{ margin: '0 16px 16px' }}><CircleX />{peek.error}</div>
          : peek.data && !peek.data.length ? <div className="empty">{tr('La cola está vacía: no había nada que leer.')}</div>
          : peek.data && (
            <ol className="msgs" aria-label={tr('Primeros mensajes de {queue}', { queue })}>
              {peek.data.map((m, i) => (
                <li key={i}>
                  <div className="msg-h">
                    <span className="mono faint">{exchangeName(m.exchange)} →</span>
                    <span className="mono key"><Code text={m.routing_key} lang="text" /></span>
                    <span className="grow" />
                    {m.binary && <span className="chip" title={tr('No era texto: se ven sus bytes imprimibles')}>{tr('binario')}</span>}
                    {m.truncated && <span className="chip">{tr('primeros 50 KB')}</span>}
                    {m.redelivered && <span className="chip run" title={tr('Ya se había entregado antes de esta lectura')}>{tr('ya reentregado')}</span>}
                  </div>
                  {m.payload ? <CodeBlock className="json msg-v" text={m.payload} lang={m.binary ? 'text' : langOf(m.payload)} format={!m.binary} label={tr('Mensaje {p0} de {queue}', { p0: i + 1, queue })} /> : <span className="faint">{tr('Sin contenido')}</span>}
                </li>
              ))}
            </ol>
          )}
      </section>
      {asking && (
        <Dialog title={tr('¿Leer y cambiar el orden de la cola?')} onClose={() => setAsking(false)}>
          <div className="dlg-body">
            <p><span className="mono">{queue}</span>{' '}{tr('es una cola quorum. Leer saca sus primeros')}{' '}{PEEK}{' '}{tr('mensajes y RabbitMQ los devuelve al final de la cola, detrás de todos los demás: el orden de la cola cambia, y quedan marcados como reentregados.')}</p>
            <p className="faint">{tr('Sus consumidores los recibirán después de los que ahora van detrás, y cada lectura les cuenta como una entrega más.')}</p>
          </div>
          <footer>
            <button type="button" className="btn" data-autofocus onClick={() => setAsking(false)}>{tr('Cancelar')}</button>
            <button type="button" className="btn destroy" onClick={() => { setAsking(false); void read(); }}><Eye />{tr('Leer y reordenar')}</button>
          </footer>
        </Dialog>
      )}
    </div>
  );
}

/** Two steps, as Kafka's: write, then read exactly what goes out and where. Nothing is sent before «Publicar». */
function RabbitPublish({ env, exchanges, routingKey, onClose, onDone }: { env: string; exchanges: string[]; routingKey: string; onClose: () => void; onDone: () => void }) {
  const [exchange, setExchange] = useState('');
  const [key, setKey] = useState(routingKey);
  const [payload, setPayload] = useState('');
  const [review, setReview] = useState<RabbitRoute | null>(null);
  const reviewing = review !== null;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ids = useId();
  const box = useRef<HTMLDivElement>(null);
  const stepped = useRef(false);
  // The button that switched the step is gone: focus goes to the new step's first thing.
  useEffect(() => {
    if (stepped.current) box.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    stepped.current = true;
  }, [reviewing]);

  // The review asks the broker where the message would go now; an exchange that does not exist stops here.
  const toReview = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!key.trim() && isDefaultExchange(exchange.trim())) { setError(tr('Escribe la clave de enrutado: en el intercambio por defecto es el nombre de la cola.')); return; }
    if (new TextEncoder().encode(key).length > 255) { setError(tr('La clave de enrutado tiene como mucho 255 bytes.')); return; }
    if (!payload) { setError(tr('Escribe el mensaje.')); return; }
    setBusy(true);
    setError('');
    try {
      const { route } = await api<{ route: RabbitRoute | null }>('/api/rabbit/route', { method: 'POST', body: { env, exchange: exchange.trim(), routingKey: key } });
      if (route) setReview(route); else setError(tr('No existe el intercambio {trim}. Elige uno de la lista, o déjalo vacío para el de por defecto.', { trim: exchange.trim() }));
    } catch (err) { setError(rabbitText((err as Error).message)); }
    setBusy(false);
  };
  const publish = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await api<{ routed: boolean }>('/api/rabbit/publish', { method: 'POST', body: { env, exchange: exchange.trim(), routingKey: key, payload } });
      toast(r.routed ? tr('Publicado en {exchangeName}', { exchangeName: exchangeName(exchange.trim()) }) : tr('RabbitMQ lo aceptó, pero ninguna cola lo recibió'));
      onDone();
      onClose();
    } catch (err) { setError(rabbitText((err as Error).message)); setBusy(false); }
  };

  return (
    <Dialog title={review ? tr('Revisa el mensaje') : tr('Publicar en RabbitMQ')} onClose={onClose} wide>
      <div ref={box}>
        {!review ? (
          <form onSubmit={toReview} noValidate>
            <div className="dlg-body form">
              <div className="fld">
                <label className="l" htmlFor={`${ids}-x`}>{tr('Intercambio')}</label>
                <input id={`${ids}-x`} className="mono" list={`${ids}-xs`} value={exchange} placeholder={tr('(por defecto)')} onChange={(e) => setExchange(e.target.value)} autoComplete="off" spellCheck={false} aria-describedby={`${ids}-xh`} />
                <datalist id={`${ids}-xs`}>{exchanges.map((x) => <option key={x} value={x} />)}</datalist>
                <span className="h" id={`${ids}-xh`}>{tr('Vacío (o amq.default), el intercambio por defecto: entrega en la cola que se llama como la clave.')}</span>
              </div>
              <div className="fld">
                <label className="l" htmlFor={`${ids}-k`}>{tr('Clave de enrutado')}</label>
                <input id={`${ids}-k`} className="mono" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" spellCheck={false} />
              </div>
              <div className="fld">
                <label className="l" htmlFor={`${ids}-v`}>{tr('Mensaje')}</label>
                <textarea id={`${ids}-v`} className="mono" data-autofocus rows={7} value={payload} onChange={(e) => setPayload(e.target.value)} spellCheck={false} aria-describedby={`${ids}-vh`} />
                <span className="h" id={`${ids}-vh`}>{tr('Se envía tal cual, como texto.')}</span>
              </div>
              {error && <p className="form-err" role="alert">{error}</p>}
            </div>
            <footer>
              <button type="button" className="btn" onClick={onClose}>{tr('Cancelar')}</button>
              <button className="btn primary" aria-busy={busy || undefined}>{tr('Revisar')}</button>
            </footer>
          </form>
        ) : (
          <>
            <div className="dlg-body">
              <p>{tr('Se publicará un mensaje en el intercambio')}{' '}<span className="mono">{exchangeName(exchange.trim())}</span>{' '}{tr('de')}{' '}{env}{tr(', con la clave')}{' '}<span className="mono">{key || tr('(vacía)')}</span>:</p>
              <CodeBlock className="ctx sql-preview" text={payload} lang={langOf(payload)} label={tr('El mensaje')} autoFocus />
              <p className="faint">{routeText(exchange.trim(), key, review).map((x, i) => <Fragment key={i}>{typeof x === 'string' ? x : <span className="mono"><Code text={x.code} lang="text" /></span>}</Fragment>)}</p>
              {error && <p className="form-err" role="alert">{error}</p>}
            </div>
            <footer>
              <button type="button" className="btn" onClick={() => setReview(null)}>{tr('Volver')}</button>
              <button type="button" className="btn destroy" aria-disabled={busy || undefined} onClick={publish}><Send className={busy ? 'spin' : undefined} />{tr('Publicar')}</button>
            </footer>
          </>
        )}
      </div>
    </Dialog>
  );
}

const VERDICT: Record<TopicContract['verdict'], [string, 'ok' | 'err' | 'run' | 'idle']> = {
  agrees: [tr('El contrato y el código coinciden'), 'ok'],
  differs: [tr('El contrato y el código difieren'), 'err'],
  'declared-not-in-code': [tr('Declarado, pero el código no lo usa'), 'err'],
  'code-not-declared': [tr('El código lo usa y ningún contrato lo declara'), 'run'],
  'only-seen': [tr('Solo lo vieron los runs'), 'run'],
};
const SAYS: Record<'publishes' | 'consumes', string> = { publishes: tr('publica'), consumes: tr('consume') };

/**
 * Each topic against its contracts, the code and the runs, read from files: it is the same with every env stopped.
 * What a contract says (who publishes, who consumes, what it carries) next to what the map found and what the last
 * traces saw, and where they differ.
 */
function TopicContracts() {
  const d = useApi<{ topics: TopicContract[]; facts: number }>('/api/queue/contracts');
  if (d.error) return <div className="notice" role="alert" style={{ marginTop: 16 }}><CircleX />{d.error}</div>;
  if (!d.data) return <section className="panel" style={{ marginTop: 16 }}><div className="body"><Skeleton lines={3} /></div></section>;
  if (!d.data.topics.length) return null;
  return (
    <section className="panel" style={{ marginTop: 16 }} aria-labelledby="qc-h">
      <header><h3 id="qc-h">{tr('Contratos de los temas')}</h3><div className="meta">{plural(d.data.topics.length, tr('tema'), tr('temas'))} · {plural(d.data.facts, tr('hecho del código'), tr('hechos del código'))}{' '}{tr('· se lee de los archivos, con el entorno parado también')}</div></header>
      <div className="scroll-x">
        <table className="t">
          <thead><tr><th>{tr('Tema@@Kafka')}</th><th>{tr('Contrato')}</th><th>{tr('Código')}</th><th>{tr('Visto en runs')}</th></tr></thead>
          <tbody>
            {d.data.topics.map((t) => {
              const [text, dot] = VERDICT[t.verdict];
              return (
                <tr key={t.topic}>
                  <td className="wrap"><span className="mono">{t.topic}</span><div><Status state={dot}>{text}</Status></div>
                    {(t.missing?.length || t.extra?.length) ? <div className="faint sub">{t.missing?.length ? tr('El contrato dice y el código no: {join}. ', { join: t.missing.join(', ') }) : ''}{t.extra?.length ? tr('El código hace y el contrato no dice: {join}.', { join: t.extra.join(', ') }) : ''}</div> : null}</td>
                  <td className="wrap">{t.declared.length ? t.declared.map((e, i) => <div key={i}><span className="mono">{e.service.replace(/^svc:/, '')}</span> {SAYS[e.direction]}{e.payload ? <span className="faint"> · {e.payload}</span> : null} <a className="rowlink" href={href('docs', e.piece)}>{e.title}</a></div>) : <span className="faint">{tr('Ningún contrato lo declara')}</span>}</td>
                  <td className="wrap">{t.code.length ? t.code.map((c, i) => <div key={i}><span className="mono">{c.service.replace(/^svc:/, '')}</span> {SAYS[c.direction]}</div>) : <span className="faint">{tr('El código no lo usa')}</span>}</td>
                  <td className="wrap">{t.seen ? <><a className="rowlink" href={href('runs', t.seen.run, t.seen.flow)}>run {t.seen.run}</a> · {plural(t.seen.count, tr('mensaje'), tr('mensajes'))}{' '}{tr('en')}{' '}{t.seen.flow}{t.sample ? <details><summary className="faint">{tr('El último mensaje')}</summary><CodeBlock className="json obj-text" text={t.sample.value} lang={langOf(t.sample.value, 'application/json')} format label={tr('Último mensaje de {topic}', { topic: t.topic })} /></details> : null}</> : <span className="faint">{tr('Ningún run lo vio')}</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** SQS (ElasticMQ, LocalStack), read only: the queues with what waits, is in flight and is delayed, and a look at the messages that hides none. */
function SqsView({ env, queueArg }: { env: string; queueArg?: string }) {
  const list = useApi<SqsQueueInfo[]>(`/api/sqs/queues?env=${encodeURIComponent(env)}`);
  const queue = list.data?.find((q) => q.name === queueArg) ?? list.data?.[0];
  const msgs = useApi<SqsMessageInfo[]>(queue ? `/api/sqs/peek?env=${encodeURIComponent(env)}&queue=${encodeURIComponent(queue.name)}` : null);
  if (list.error) return <div className="notice" role="alert"><CircleX />{list.error}</div>;
  if (!list.data) return <Skeleton lines={5} />;
  if (!list.data.length) return <section className="panel"><div className="empty">{tr('El servicio SQS de')}{' '}{env}{' '}{tr('no tiene colas todavía.')}</div></section>;
  return (
    <div className="two-col">
      <section className="panel" aria-labelledby="sqs-q">
        <header><h3 id="sqs-q">{tr('Colas')}</h3><div className="meta">{tr('solo lectura')}</div></header>
        <ul className="feed">
          {list.data.map((q) => (
            <li key={q.name}><a className="main rowlink mono" aria-current={q.name === queue?.name ? 'true' : undefined} href={href('queues', env, 'sqs', q.name)}>{q.name}</a>
              <span className="faint num">{nf.format(q.visible)}{' '}{tr('esperando')}{q.inFlight ? tr(', {format} en vuelo', { format: nf.format(q.inFlight) }) : ''}{q.delayed ? tr(', {format} con retraso', { format: nf.format(q.delayed) }) : ''}{q.deadLetter ? tr(' · muertos en {deadLetter}', { deadLetter: q.deadLetter }) : ''}</span></li>
          ))}
        </ul>
      </section>
      <section className="panel" aria-labelledby="sqs-m">
        <header><h3 id="sqs-m">{tr('Mensajes de')}{' '}<span className="mono">{queue?.name}</span></h3><div className="meta">{tr('se miran sin esconderlos a nadie: no se borra, no se envía')}</div></header>
        {msgs.error ? <div className="notice" role="alert" style={{ margin: 12 }}><CircleX />{msgs.error}</div>
          : !msgs.data ? <div className="body"><Skeleton lines={3} /></div>
          : !msgs.data.length ? <div className="empty">{tr('La cola no tiene mensajes ahora.')}</div>
          : <ul className="feed">{msgs.data.map((m) => (
            <li key={m.id}><div className="main"><CodeBlock className="json obj-text" text={m.body} lang={langOf(m.body, 'application/json')} format label={tr('Mensaje {id}', { id: m.id })} />
              <span className="faint">{m.sentAt ? tr('enviado {ago}', { ago: ago(m.sentAt) }) : ''}{m.receiveCount ? ` · ${plural(m.receiveCount, tr('lectura'), tr('lecturas'))}` : ''}</span></div></li>
          ))}</ul>}
      </section>
    </div>
  );
}
