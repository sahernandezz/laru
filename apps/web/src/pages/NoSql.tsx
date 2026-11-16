/**
 * MongoDB and Redis in «Bases», read by each store's own client inside its container, every value masked.
 * MongoDB is read-only: databases, collections with their count and indexes, documents with a filter, sort, projection
 * and pages, and one document by its _id. Redis: keys by pattern with type and TTL, a value read by its type, and
 * deleting a key, which is its own operation and asks first, naming the key.
 */
import { ChevronLeft, ChevronRight, CircleX, Database, Layers, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api, useApi, useRecorded, type MongoCollection, type MongoDb, type MongoPage, type MongoStoreInfo, type RedisKey, type RedisStoreInfo, type RedisValue } from '../api.ts';
import { Code, CodeBlock, Dialog, Field, toast } from '../components/ui.tsx';
import { plural, redisNote, size } from '../lib/es.ts';
import { href, idOf, keyAddress, keyMasked, keyOf } from '../lib/route.ts';
import { langOf } from '../lib/syntax.ts';
import { tr, LOCALE } from '../lib/i18n.ts';

const nf = new Intl.NumberFormat(LOCALE);
const PAGE = 50;
const qs = (o: Record<string, string>) => new URLSearchParams(o).toString();
/** A value as text: a store's JSON that masking could not keep whole arrives as its masked text. */
const asText = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

const Bars = ({ widths = [70, 55, 80, 62] }: { widths?: number[] }) => <div style={{ display: 'grid', gap: 8, padding: 8 }} aria-hidden="true">{widths.map((w, i) => <div key={i} className="sk" style={{ height: 12, width: `${w}%` }} />)}</div>;

function Connect({ env, service, user, fields, note }: { env: string; service: string; user?: string; fields: Array<[string, string | undefined]>; note: string }) {
  return (
    <section aria-labelledby="conn-h">
      <h3 id="conn-h" className="aside-h">{tr('Conectar')}</h3>
      <span className="faint aside-sub">{service}{' '}{tr('en')}{' '}{env}{user ? <>{tr(', como')}{' '}<span className="mono">{user}</span></> : ''}</span>
      <div className="conn">{fields.map(([l, v]) => <Field key={l} label={l} value={v} />)}</div>
      <p className="faint aside-sub">{note}</p>
    </section>
  );
}

// ---------- MongoDB ----------

export function MongoView({ env, nav, store, dbArg, collArg, idArg }: { env: string; nav: ReactNode; store: MongoStoreInfo; dbArg?: string; collArg?: string; idArg?: string }) {
  const svc = { env, service: store.service };
  const dbs = useApi<MongoDb[]>(`/api/mongo/dbs?${qs(svc)}`);
  const db = dbs.data?.find((d) => d.name === dbArg) ?? dbs.data?.find((d) => d.name !== 'admin') ?? dbs.data?.[0];
  const colls = useApi<MongoCollection[]>(db ? `/api/mongo/collections?${qs({ ...svc, db: db.name })}` : null);
  const coll = colls.data?.find((c) => c.name === collArg) ?? (collArg ? undefined : colls.data?.find((c) => !c.name.startsWith('system.')));
  const c = store.conn;

  return (
    <div className="dbx nosql">
      <aside className="schema" aria-label={tr('Bases de datos y colecciones')}>
        {nav}
        <h4>{tr('Bases de datos')}</h4>
        {dbs.error ? <p className="form-err aside-note" role="alert">{dbs.error}</p> : !dbs.data ? <Bars /> : !dbs.data.length ? <p className="faint aside-note">{tr('Este MongoDB no tiene bases de datos todavía.')}</p> : dbs.data.map((d) => (
          <div key={d.name}>
            <a href={href('data', env, store.service, d.name)} className={d === db ? 'open' : undefined} aria-current={d === db && !coll ? 'true' : undefined} title={d.empty ? tr('Vacía') : tr('{size} en disco', { size: size(d.sizeOnDisk) })}>
              <Database /><span className="tn">{d.name}</span><span className="c">{d.empty ? tr('vacía') : size(d.sizeOnDisk)}</span>
            </a>
            {d === db && (colls.error ? <p className="form-err aside-note" role="alert">{colls.error}</p> : !colls.data ? <Bars widths={[60, 72]} />
              : !colls.data.length ? <p className="faint aside-note sub">{tr('Sin colecciones.')}</p>
              : colls.data.map((x) => (
                <a key={x.name} className="sub" href={href('data', env, store.service, d.name, x.name)} aria-current={x === coll ? 'true' : undefined}
                  title={x.type === 'view' ? tr('Una vista: sin recuento ni índices propios') : x.count === null ? tr('Sin recuento') : x.count === 1 ? tr('Un documento') : tr('Unos {format} documentos', { format: nf.format(x.count) })}>
                  <Layers /><span className="tn">{x.name}</span><span className="c">{x.type === 'view' ? tr('vista') : x.count === null ? '—' : nf.format(x.count)}</span>
                </a>
              )))}
          </div>
        ))}
      </aside>

      <div className="center">
        {db && coll ? <Documents key={`${db.name}/${coll.name}`} env={env} store={store} db={db.name} coll={coll.name} idArg={idArg} />
          : db && colls.data ? <div className="empty">{collArg ? tr('{name} no tiene ninguna colección {collArg}.', { name: db.name, collArg }) : tr('{name} no tiene colecciones que leer.', { name: db.name })}</div>
          : dbs.data && !db ? <div className="empty">{tr('Sin bases de datos que mostrar.')}</div> : null}
      </div>

      <aside className="right" aria-label={tr('Documento, índices y conexión')}>
        {db && coll && idArg && <Doc key={idArg} env={env} store={store} db={db.name} coll={coll.name} id={idArg} />}
        {coll && (
          <section aria-labelledby="idx-h">
            <h3 id="idx-h" className="aside-h">{tr('Índices de')}{' '}<span className="mono">{coll.name}</span></h3>
            {coll.type === 'view' ? <p className="faint aside-sub">{tr('Es una vista: no tiene índices propios.')}</p>
              : !coll.indexes.length ? <p className="faint aside-sub">{tr('Sin índices.')}</p>
              : (
                <ul className="idx">
                  {coll.indexes.map((i) => <li key={i.name}><span className="mono">{i.name}</span>{i.unique && <span className="chip">{tr('único')}</span>}<code><Code text={JSON.stringify(i.key)} lang="json" /></code></li>)}
                </ul>
              )}
          </section>
        )}
        <Connect env={env} service={store.service} user={c.user} fields={[[tr('Host y puerto'), c.port ? `${c.host}:${c.port}` : undefined], [tr('Usuario'), c.user], ['URL', c.url], [tr('Shell en el contenedor'), c.shell]]}
          note={c.port ? (c.user ? tr('La URL no lleva la contraseña: es la del usuario root del entorno. Aquí se lee como ks_reader, que no puede escribir.') : tr('Este MongoDB no tiene control de acceso: entra sin usuario.')) : tr('Sin puerto publicado en esta máquina: entra con el shell del contenedor.')} />
      </aside>
    </div>
  );
}

const QUERY = [
  { k: 'filter', label: tr('Filtro'), hint: tr('{"status": "paid"}') },
  { k: 'sort', label: tr('Orden'), hint: tr('{"_id": -1}') },
  { k: 'projection', label: tr('Proyección'), hint: tr('{"items": 0}') },
] as const;
type Query = Record<(typeof QUERY)[number]['k'], string>;
const NONE: Query = { filter: '', sort: '', projection: '' };

function Documents({ env, store, db, coll, idArg }: { env: string; store: MongoStoreInfo; db: string; coll: string; idArg?: string }) {
  const [form, setForm] = useState<Query>(NONE);
  const [query, setQuery] = useState<Query>(NONE);
  const [bad, setBad] = useState<{ k: string; msg: string } | null>(null);
  const [page, setPage] = useState(0);
  const [tick, setTick] = useState(0);
  const [res, setRes] = useState<{ data?: MongoPage; error?: string; loading: boolean }>({ loading: true });
  const ids = useId();

  useEffect(() => {
    let live = true;
    setRes((r) => ({ ...r, loading: true }));
    api<MongoPage>('/api/mongo/find', { method: 'POST', body: { env, service: store.service, db, collection: coll, ...query, limit: PAGE, skip: page * PAGE } })
      .then((data) => live && setRes({ data, loading: false }), (e: Error) => live && setRes({ error: e.message, loading: false }));
    return () => { live = false; };
  }, [env, store.service, db, coll, query, page, tick]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    for (const { k, label } of QUERY) {
      const v = form[k].trim();
      if (!v) continue;
      let ok = false;
      try { const o = JSON.parse(v); ok = Boolean(o) && typeof o === 'object' && !Array.isArray(o); } catch { /* said below */ }
      if (!ok) {
        setBad({ k, msg: tr('{label}: no es un objeto JSON. Va entre llaves, con las claves y los textos entre comillas dobles: {"role": "user"}.', { label }) });
        document.getElementById(`${ids}-${k}`)?.focus();
        return;
      }
    }
    setBad(null);
    setPage(0);
    setQuery({ ...form });
  };
  const data = res.data;
  const from = page * PAGE;
  const narrowed = QUERY.some(({ k }) => query[k].trim());
  // The back end says which _ids it masked: those cannot be asked for by what is shown.
  const maskedIds = new Set(data?.maskedIds);

  return (
    <>
      <form className="mq" onSubmit={submit} noValidate aria-label={tr('Buscar en {coll}', { coll })}>
        {QUERY.map(({ k, label, hint }) => (
          <label key={k} className={bad?.k === k ? 'bad' : undefined}>
            <span>{label}</span>
            <input id={`${ids}-${k}`} className="mono" value={form[k]} placeholder={hint} spellCheck={false} autoComplete="off" aria-invalid={bad?.k === k || undefined} aria-describedby={bad?.k === k ? `${ids}-err` : `${ids}-h`}
              onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} />
          </label>
        ))}
        <div className="acts">
          <button className="btn sm primary"><Search />{tr('Buscar')}</button>
          {narrowed && <button type="button" className="btn sm" onClick={() => { setForm(NONE); setQuery(NONE); setPage(0); setBad(null); }}>{tr('Quitar')}</button>}
        </div>
        {bad ? <p className="form-err" id={`${ids}-err`} role="alert">{bad.msg}</p>
          : <p className="faint" id={`${ids}-h`}>{tr('JSON extendido, como el de mongosh:')}{' '}<span className="mono">{tr('{"_id": {"$oid": "…"}}')}</span>{tr('. Viaja como dato, nunca como código, y se lee como')}{' '}<span className="mono">ks_reader</span>.</p>}
      </form>
      <div className="grid-wrap" aria-busy={res.loading} tabIndex={0} aria-label={tr('Documentos de {coll}', { coll })}>
        {res.error ? <div className="notice" role="alert" style={{ margin: 12 }}><CircleX /><div className="mono pre-line"><Code text={res.error} lang="log" /></div></div>
          : !data ? <Bars widths={[92, 80, 88, 70, 84, 76]} />
          : !data.docs.length ? <p className="empty">{narrowed ? tr('Ningún documento cumple la búsqueda.') : page ? tr('No hay más documentos.') : tr('{coll} está vacía.', { coll })}</p>
          : (
            <ol className="docs-list" start={from + 1}>
              {data.docs.map((d, i) => {
                const doc = d && typeof d === 'object' && !Array.isArray(d) ? d as Record<string, unknown> : undefined;
                const id = idOf(doc?._id);
                const { _id, ...restDoc } = doc ?? {};
                const preview = doc ? JSON.stringify(restDoc) : asText(d);
                const body = <><span className="n num" aria-hidden="true">{from + i + 1}</span>{id !== undefined && <span className="id"><Code text={id} lang="text" /></span>}<span className="prev"><Code text={preview} lang={langOf(preview)} /></span></>;
                return (
                  <li key={id ?? i}>
                    {id !== undefined && !maskedIds.has(i) ? <a href={href('data', env, store.service, db, coll, id)} aria-current={id === idArg ? 'true' : undefined} aria-label={tr('Documento {id}', { id })}>{body}</a> : <div className="row" title={id === undefined ? tr('Sin _id que pedir: se ve aquí entero') : tr('Su _id lleva un valor enmascarado: se ve aquí entero')}>{body}</div>}
                  </li>
                );
              })}
            </ol>
          )}
      </div>
      <div className="gridfoot">
        <span className="num" aria-live="polite">{data ? (data.docs.length ? tr('Documentos {format}–{format2}', { format: nf.format(from + 1), format2: nf.format(from + data.docs.length) }) : tr('Sin documentos')) : res.error ? tr('La búsqueda falló') : tr('Cargando documentos')}</span>
        <span className="hide-sm">{tr('Solo lectura')}</span>
        <span className="grow" />
        {data && <span className="num">{data.ms} ms</span>}
        <button className="btn sm" aria-label={tr('Volver a leer')} onClick={() => setTick((t) => t + 1)}><RefreshCw className={res.loading ? 'spin' : undefined} /></button>
        <button className="btn sm" aria-label={tr('Página anterior')} aria-disabled={page === 0 || undefined} onClick={() => page > 0 && setPage((p) => p - 1)}><ChevronLeft /></button>
        <button className="btn sm" aria-label={tr('Página siguiente')} aria-disabled={!data?.more || undefined} onClick={() => data?.more && setPage((p) => p + 1)}><ChevronRight /></button>
      </div>
    </>
  );
}

function Doc({ env, store, db, coll, id }: { env: string; store: MongoStoreInfo; db: string; coll: string; id: string }) {
  const d = useApi<{ doc: unknown }>(`/api/mongo/doc?${qs({ env, service: store.service, db, collection: coll, id })}`);
  const text = d.data && d.data.doc !== null ? asText(d.data.doc) : '';
  return (
    <section aria-labelledby="doc-h" className="preview">
      <h3 id="doc-h" className="aside-h">{tr('Documento')}{' '}<span className="mono">{id}</span></h3>
      {d.error ? <p className="form-err" role="alert">{d.error}</p>
        : !d.data ? <div className="sk" style={{ height: 160 }} aria-hidden="true" />
        : d.data.doc === null ? <p className="faint aside-sub">{tr('Ese documento ya no está en')}{' '}{coll}.</p>
        : <CodeBlock className="json obj-text" text={text} lang={langOf(text)} format label={tr('Documento {id} de {coll}', { id, coll })} />}
      <a className="rowlink aside-sub" href={href('data', env, store.service, db, coll)}>{tr('Cerrar el documento')}</a>
    </section>
  );
}

// ---------- Redis ----------

/** 45 s, 12 min, 3 h, 2 d; a key without one, none. */
const ttlText = (t: number) => (t < 0 ? tr('sin caducidad') : t < 60 ? `${t} s` : t < 3600 ? `${Math.round(t / 60)} min` : t < 86400 ? `${Math.round(t / 3600)} h` : `${Math.round(t / 86400)} d`);
const MAX_KEYS = 500;

/** A key's name as text; an empty one says so, or it would be nothing to see or click. */
const KeyName = ({ name }: { name: string }) => (name ? <Code text={name} lang="text" /> : <span className="faint">{tr('(sin nombre)')}</span>);

export function RedisView({ env, nav, store, keyArg }: { env: string; nav: ReactNode; store: RedisStoreInfo; keyArg?: string }) {
  const name = keyArg === undefined ? undefined : keyOf(keyArg);
  const [pattern, setPattern] = useState('*');
  const [applied, setApplied] = useState('*');
  // After a delete the value's buttons are gone: the focus goes back to the search.
  const input = useRef<HTMLInputElement>(null);
  const deleted = useRef(false);
  useEffect(() => { if (deleted.current && name === undefined) { deleted.current = false; input.current?.focus(); } }, [name]);
  const keys = useApi<{ service: string; keys: RedisKey[] }>(`/api/redis/keys?${qs({ env, service: store.service, pattern: applied })}`);
  const list = keys.data?.keys ?? [];
  // The names the back end flagged as masked, kept across lists; and whether a list has loaded, or failed, once.
  const flagged = useRef(new Set<string>());
  const listed = useRef(false);
  if (keys.data || keys.error) listed.current = true;
  // every list that loads teaches its flags, whether a key is open or not
  for (const k of list) if (k.masked) flagged.current.add(k.key);
  const masked = name === undefined ? undefined : keyMasked(name, list, flagged.current);
  const c = store.conn;
  const search = (e: FormEvent) => { e.preventDefault(); const p = pattern.trim() || '*'; if (p === applied) keys.reload(); else setApplied(p); };

  return (
    <div className="dbx nosql">
      <aside className="schema" aria-label={tr('Bases')}>{nav}</aside>
      <div className="center">
        <form className="toolbar" onSubmit={search} role="search" aria-label={tr('Claves de {service}', { service: store.service })}>
          <label className="search-in"><Search /><span className="sr-only">{tr('Patrón de claves')}</span>
            <input ref={input} type="search" className="mono" value={pattern} placeholder="user:*" spellCheck={false} autoComplete="off" onChange={(e) => setPattern(e.target.value)} />
          </label>
          <button className="btn sm"><RefreshCw className={keys.loading ? 'spin' : undefined} />{tr('Buscar')}</button>
          <span className="grow" />
          <span className="faint num" aria-live="polite">{keys.data ? (list.length >= MAX_KEYS ? tr('Las primeras {MAX_KEYS} claves', { MAX_KEYS }) : plural(list.length, tr('clave'), tr('claves'))) : ''}</span>
        </form>
        <div className="grid-wrap" tabIndex={0} aria-label={tr('Claves de {service} que cumplen {applied}', { service: store.service, applied })} aria-busy={keys.loading}>
          {keys.error ? <div className="notice" role="alert" style={{ margin: 12 }}><CircleX />{keys.error}</div>
            : !keys.data ? <Bars widths={[88, 72, 80, 66, 90]} />
            : !list.length ? <p className="empty">{applied === '*' ? tr('{service} no tiene claves.', { service: store.service }) : tr('Ninguna clave cumple {applied}.', { applied })}</p>
            : (
              <table className="t keys">
                <thead><tr><th>{tr('Clave')}</th><th>{tr('Tipo')}</th><th className="r">{tr('TTL')}</th></tr></thead>
                <tbody>
                  {list.map((k) => (
                    <tr key={k.key} className={k.key === name ? 'sel' : undefined}>
                      <td className="wrap"><a className="obj mono" href={href('data', env, store.service, keyAddress(k.key))} aria-current={k.key === name ? 'true' : undefined}><span><KeyName name={k.key} /></span></a></td>
                      <td><span className="kind">{k.type}</span></td>
                      <td className={`r num${k.ttl < 0 ? ' faint' : ''}`}>{ttlText(k.ttl)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>
        <div className="gridfoot"><span>{tr('Patrón de Redis:')}{' '}<span className="mono">*</span>{' '}{tr('cualquier cosa,')}{' '}<span className="mono">?</span>{' '}{tr('un carácter,')}{' '}<span className="mono">[ab]</span>{' '}{tr('uno de ellos')}</span><span className="grow" /><span className="mono">{applied}</span></div>
      </div>
      <aside className="right" aria-label={tr('Valor y conexión')}>
        {name !== undefined ? <Value key={name} env={env} store={store} name={name} masked={masked} ready={listed.current} onDeleted={() => { deleted.current = true; keys.reload(); location.hash = href('data', env, store.service); }} />
          : <p className="faint aside-note">{tr('Elige una clave para ver su valor.')}</p>}
        <Connect env={env} service={store.service} fields={[[tr('Host y puerto'), c.port ? `${c.host}:${c.port}` : undefined], ['URL', c.url], [tr('Shell en el contenedor'), c.shell]]}
          note={c.port ? tr('La URL no lleva la contraseña; el shell entra con la del propio contenedor, si tiene una.') : tr('Sin puerto publicado en esta máquina: entra con el shell del contenedor, que usa su contraseña si tiene una.')} />
      </aside>
    </div>
  );
}

const Rows = ({ head, rows }: { head: [string, string]; rows: Array<[string, string]> }) => (
  <table className="t vt">
    <thead><tr><th>{head[0]}</th><th>{head[1]}</th></tr></thead>
    <tbody>{rows.map(([a, b], i) => <tr key={i}><td><Code text={a} lang="text" /></td><td><Code text={b} lang={langOf(b)} /></td></tr>)}</tbody>
  </table>
);

/** A value by its type: a string as text (formatted when it is JSON), a hash and a sorted set as tables, a list and a set as lists, a stream by entry. */
function ValueBody({ v }: { v: RedisValue }) {
  const x = v.value;
  const label = tr('Valor de {key}', { key: v.key });
  if (v.type === 'string' || typeof x === 'string') { const t = asText(x); return <CodeBlock className="json obj-text" text={t} lang={langOf(t)} format label={label} />; }
  if ((v.type === 'list' || v.type === 'set') && Array.isArray(x)) return x.length ? <Rows head={[v.type === 'list' ? tr('Posición') : '#', v.type === 'list' ? tr('Elemento') : tr('Miembro')]} rows={x.map((e, i) => [String(i), asText(e)])} /> : <p className="faint aside-sub">{tr('Vacía.')}</p>;
  if (v.type === 'hash' && x && typeof x === 'object') return <Rows head={[tr('Campo'), tr('Valor')]} rows={Object.entries(x).map(([k, e]) => [k, asText(e)])} />;
  if (v.type === 'zset' && x && typeof x === 'object') return <Rows head={[tr('Miembro'), tr('Puntuación')]} rows={Object.entries(x).sort((a, b) => Number(a[1]) - Number(b[1])).map(([k, e]) => [k, asText(e)])} />;
  if (v.type === 'stream' && x && typeof x === 'object') return (
    <ol className="msgs stream" aria-label={label}>
      {Object.entries(x as Record<string, Record<string, unknown>>).map(([id, fields]) => (
        <li key={id}>
          <div className="msg-h"><span className="mono">{id}</span><span className="grow" /><span className="faint">{new Date(Number(id.split('-')[0])).toLocaleString(LOCALE)}</span></div>
          <Rows head={[tr('Campo'), tr('Valor')]} rows={Object.entries(fields ?? {}).map(([k, e]) => [k, asText(e)])} />
        </li>
      ))}
    </ol>
  );
  const t = asText(x);
  return <CodeBlock className="json obj-text" text={t} lang={langOf(t)} format label={label} />;
}

/**
 * `masked`: a list flagged this name as masked, so the key cannot be asked for by it; false when the list has it
 * unflagged, undefined when no list says. `ready`: a list has loaded, so a name it does not flag is read by its name.
 */
function Value({ env, store, name, masked, ready, onDeleted }: { env: string; store: RedisStoreInfo; name: string; masked?: boolean; ready: boolean; onDeleted: () => void }) {
  const recorded = useRecorded();
  const marked = masked === true;
  const v = useApi<RedisValue>(ready && !marked ? `/api/redis/key?${qs({ env, service: store.service, key: name })}` : null);
  const [asking, setAsking] = useState(false);
  const gone = v.data?.type === 'none';
  const shown = v.data?.value && typeof v.data.value === 'object' ? Object.keys(v.data.value).length : 0;
  const size = v.data?.size;
  return (
    <section aria-labelledby="val-h" className="preview">
      <h3 id="val-h" className="aside-h mono"><KeyName name={name} /></h3>
      {marked ? <p className="faint aside-sub">{tr('Su nombre lleva un valor enmascarado: no se puede pedir desde aquí. Léela o bórrala con el shell del contenedor.')}</p>
        : v.error ? <p className="form-err" role="alert">{v.error}</p>
        : !v.data ? <div className="sk" style={{ height: 160 }} aria-hidden="true" />
        : gone ? <p className="faint aside-sub">{masked === false ? tr('Esta clave ya no existe.') : tr('Ninguna clave se llama así. Si su nombre lleva un valor enmascarado, no se puede pedir desde aquí: búscala en la lista o léela con el shell del contenedor.')}</p>
        : (
          <>
            <dl className="meta-list">
              <div><dt>{tr('Tipo')}</dt><dd><span className="kind">{v.data.type}</span></dd></div>
              <div><dt>{tr('Caduca')}</dt><dd>{v.data.ttl < 0 ? <span className="faint">{tr('Sin caducidad')}</span> : tr('En {ttlText}', { ttlText: ttlText(v.data.ttl) })}</dd></div>
              {size !== undefined && <div><dt>{v.data.type === 'stream' ? tr('Entradas') : tr('Elementos')}</dt><dd className="num">{shown < size ? tr('{format} de {format2}', { format: nf.format(shown), format2: nf.format(size) }) : nf.format(size)}</dd></div>}
            </dl>
            {v.data.truncated && <p className="faint aside-sub">{redisNote(v.data, shown)}</p>}
            <ValueBody v={v.data} />
          </>
        )}
      {ready && !marked && !gone && (
        <div className="val-acts">
          <button className="btn sm" onClick={v.reload} aria-busy={v.loading || undefined}><RefreshCw className={v.loading ? 'spin' : undefined} />{tr('Volver a leer')}</button>
          {!recorded && <button className="btn sm destroy" onClick={() => setAsking(true)}><Trash2 />{tr('Borrar la clave')}</button>}
        </div>
      )}
      {asking && <Delete env={env} store={store} name={name} ttl={v.data?.ttl} onClose={() => setAsking(false)} onDone={onDeleted} />}
    </section>
  );
}

/** Nothing is deleted before «Borrar la clave» inside the dialog, which says which key, where, and that it cannot be undone. */
function Delete({ env, store, name, ttl, onClose, onDone }: { env: string; store: RedisStoreInfo; name: string; ttl?: number; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await api<{ ok: boolean }>('/api/redis/del', { method: 'POST', body: { env, service: store.service, key: name } });
      toast(r.ok ? tr('Clave borrada') : tr('La clave ya no existía'));
      onClose();
      onDone();
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <Dialog title={tr('¿Borrar la clave?')} onClose={onClose}>
      <div className="dlg-body">
        <p>{tr('Se borrará esta clave de')}{' '}<span className="mono">{store.service}</span>{' '}{tr('en')}{' '}{env}{tr(', con su valor')}{ttl !== undefined && ttl >= 0 ? tr(' y su caducidad') : ''}:</p>
        <p className="mono dlg-key"><KeyName name={name} /></p>
        <p className="faint">{tr('No hay deshacer. Si un servicio la espera, tendrá que volver a crearla.')}</p>
        {error && <p className="form-err" role="alert">{error}</p>}
      </div>
      <footer>
        <button type="button" className="btn" data-autofocus onClick={onClose}>{tr('Cancelar')}</button>
        <button type="button" className="btn destroy" aria-disabled={busy || undefined} onClick={run}><Trash2 className={busy ? 'spin' : undefined} />{tr('Borrar la clave')}</button>
      </footer>
    </Dialog>
  );
}
