/**
 * The databases of an env, one click away: schema tree, a grid with filters, sort and pages, a SQL editor that runs
 * as the read-only role, the connection to copy, and who writes each table (extracted from the code, observed in
 * runs). The only write is a row edit, and it shows the exact UPDATE before it runs. MongoDB and Redis stores are
 * listed with them and open in their own views (NoSql.tsx).
 */
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, CircleX, Columns3, Database, Download, GitBranch, PencilLine, Play, Plus, Search, Server, SquareTerminal, Table2, X } from 'lucide-react';
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { api, useApi, useRecorded, type Column, type EnvSummary, type Filter, type Indexed, type MongoStoreInfo, type QueryResult, type RedisStoreInfo, type StoreInfo, type Table } from '../api.ts';
import { MongoView, RedisView } from './NoSql.tsx';
import { CustomView, type CustomStoreInfo } from './Custom.tsx';
import { Code, CodeBlock, copy, Dialog, Field, Origin, Reveal, Segmented, Skeleton, Tabs, toast } from '../components/ui.tsx';
import { plural } from '../lib/es.ts';
import { useEnvList } from '../lib/useEnvs.ts';
import { href } from '../lib/route.ts';
import { suggest, toCsv } from '../lib/sql.ts';
import { tr, LOCALE } from '../lib/i18n.ts';

const PAGE = 100;
const nf = new Intl.NumberFormat(LOCALE);
const NUMERIC = /^(smallint|integer|bigint|numeric|decimal|real|double|int|tinyint|mediumint|float|serial|bigserial)/i;
const OPS: Array<[Filter['op'], string]> = [['=', '='], ['!=', '≠'], ['<', '<'], ['>', '>'], ['<=', '≤'], ['>=', '≥'], ['contains', tr('contiene')], ['null', tr('es NULL')], ['not-null', tr('no es NULL')]];
const opLabel = (op: Filter['op']) => OPS.find(([o]) => o === op)?.[1] ?? op;
const tableKey = (t: Table) => `${t.schema}.${t.name}`;
/** A declared kind that is messaging, not storage: shown in «Colas». */
export const MESSAGING = /queue|topic|stream|broker|messag|event|bus|cola|mensaj/i;

export function Data({ parts, g }: { parts: string[]; g: Indexed | null }) {
  const [envArg, svcArg, a, b, c] = parts;
  const envs = useEnvList();
  // on a run's recording the env is the one recorded, on or off: what it shows is the run's
  const recorded = useRecorded();
  const list = envs.data ?? [];
  const env = recorded ? envArg : list.find((e) => e.env === envArg)?.env ?? list.find((e) => e.state === 'ready')?.env ?? list[0]?.env;
  const ready = Boolean(recorded) || list.find((e) => e.env === env)?.state === 'ready';
  const of = (path: string) => (env && ready ? `${path}?env=${encodeURIComponent(env)}` : null);
  const sql = useApi<StoreInfo[]>(of('/api/db/stores'));
  const mongos = useApi<MongoStoreInfo[]>(of('/api/mongo/stores'));
  const redises = useApi<RedisStoreInfo[]>(of('/api/redis/stores'));
  const customs = useApi<CustomStoreInfo[]>(of('/api/custom/stores'));
  // Relational first, then MongoDB and Redis: one list, each store opens in its own view.
  const all: Array<{ service: string; kind: string; sql?: StoreInfo; mongo?: MongoStoreInfo; redis?: RedisStoreInfo; custom?: CustomStoreInfo }> = [
    ...(sql.data ?? []).map((s) => ({ service: s.service, kind: s.kind, sql: s })),
    ...(mongos.data ?? []).map((s) => ({ service: s.service, kind: 'mongodb', mongo: s })),
    ...(redises.data ?? []).map((s) => ({ service: s.service, kind: 'redis', redis: s })),
    // any other engine laru.yaml explains (queues and brokers live in «Colas»)
    ...(customs.data ?? []).filter((s) => !MESSAGING.test(s.kind)).map((s) => ({ service: s.service, kind: s.kind, custom: s })),
  ];
  const store = all.find((s) => s.service === svcArg) ?? all[0];
  const lists = [{ r: sql, what: tr('relacionales') }, { r: mongos, what: 'MongoDB' }, { r: redises, what: 'Redis' }, { r: customs, what: tr('declaradas en laru.yaml') }];
  const failed = lists.filter((l) => l.r.error);

  const head = (
    <div className="head">
      <div><h1>{tr('Bases')}</h1><p>{recorded ? tr('Las bases como quedaron al terminar el run: relacionales, MongoDB y Redis. Se recorren, se filtran y se ordenan; no se cambian.') : tr('Las bases del entorno en marcha: relacionales, MongoDB y Redis. Se leen sin escribir; editar una fila enseña antes el UPDATE exacto, y borrar una clave de Redis pide confirmarlo.')}</p></div>
    </div>
  );
  const error = envs.error ?? (failed.length === lists.length ? failed[0].r.error : undefined);
  if (error) return <div className="page">{head}<div className="notice" role="alert"><CircleX />{error}</div></div>;
  if (!envs.data || (ready && lists.some((l) => !l.r.data && !l.r.error))) return <div className="page wide">{head}<Skeleton lines={6} /></div>;
  if (!env) return <div className="page">{head}<section className="panel"><div className="empty">{tr('Este workspace no tiene entornos. Crea uno en')}{' '}<a className="rowlink" href={href('envs')}>{tr('Entornos')}</a>{' '}{tr('y levántalo: las bases aparecen aquí.')}</div></section></div>;
  const switcher = !recorded && list.length > 1 && <nav className="seg" aria-label={tr('Entorno')}>{list.map((e) => <a key={e.env} href={href('data', e.env)} aria-current={e.env === env ? 'page' : undefined}>{e.env}</a>)}</nav>;
  if (!ready) return <div className="page">{head}{switcher}<section className="panel" style={{ marginTop: 12 }}><div className="empty"><span>{env}{' '}{tr('no está en marcha. Levántalo en')}{' '}<a className="rowlink" href={href('envs', env)}>{tr('Entornos')}</a>{' '}{tr('o con')}{' '}<code>laru up {env}</code>.</span></div></section></div>;
  const unread = failed.map((l) => <p key={l.what} className="form-err aside-note" role="alert">{tr('No se pudieron leer las bases')}{' '}{l.what}: {l.r.error}</p>);
  if (!store) return <div className="page">{head}{switcher}<section className="panel" style={{ marginTop: 12 }}><div className="empty">{env}{' '}{tr('no tiene ninguna base en marcha que Laru sepa leer. Postgres, MySQL, SQL Server, Oracle, MongoDB y Redis aparecen solas; cualquier otra aparece si laru.yaml dice cómo leerla, en')}{' '}<code>{tr('stores.<nombre>.explore')}</code>.</div></section>{unread}</div>;

  const nav = (
    <>
      {list.length > 1 && <nav className="seg dbx-envs" aria-label={tr('Entorno')}>{list.map((e) => <a key={e.env} href={href('data', e.env)} aria-current={e.env === env ? 'page' : undefined}>{e.env}</a>)}</nav>}
      <h4>{tr('Bases de')}{' '}{env}</h4>
      {all.map((s) => <a key={s.service} href={href('data', env, s.service)} aria-current={s === store ? 'true' : undefined}><Database /><span className="tn">{s.service}</span><span className="c">{s.kind}</span></a>)}
      {unread}
    </>
  );
  const key = `${env}/${store.service}`;
  return (
    <div className="page flush">
      <h1 className="sr-only">{tr('Bases de')}{' '}{env}</h1>
      {store.sql ? <StoreView key={key} env={env} nav={nav} store={store.sql} schemaArg={a} tableArg={b} g={g} />
        : store.custom ? <CustomView key={key} env={env} nav={nav} store={store.custom} tableArg={a} at={(n) => href('data', env, store.service, n)} />
        : store.mongo ? <MongoView key={key} env={env} nav={nav} store={store.mongo} dbArg={a} collArg={b} idArg={c} />
        : <RedisView key={key} env={env} nav={nav} store={store.redis!} keyArg={a} />}
    </div>
  );
}

function StoreView({ env, nav, store, schemaArg, tableArg, g }: { env: string; nav: ReactNode; store: StoreInfo; schemaArg?: string; tableArg?: string; g: Indexed | null }) {
  const recorded = useRecorded();
  const schema = useApi<Table[]>(`/api/db/schema?env=${encodeURIComponent(env)}&service=${encodeURIComponent(store.service)}`);
  const tables = schema.data ?? [];
  const table = tables.find((t) => t.schema === schemaArg && t.name === tableArg) ?? tables[0];
  const [tab, setTab] = useState<'table' | 'query'>('table');
  const [q, setQ] = useState('');
  const ids = useId();
  useEffect(() => { if (tableArg) setTab('table'); }, [schemaArg, tableArg]);
  const shown = tables.filter((t) => tableKey(t).toLowerCase().includes(q.toLowerCase()));
  const bySchema = Map.groupBy(shown, (t) => t.schema);

  return (
    <div className="dbx">
      <aside className="schema" aria-label={tr('Esquema')}>
        {nav}
        <div className="tree-tools" style={{ marginTop: 12 }}>
          <input className="tree-filter" type="search" placeholder={tr('Filtrar tablas')} aria-label={tr('Filtrar tablas')} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {schema.error ? <p className="form-err" style={{ padding: '0 8px' }}>{schema.error}</p> : !schema.data ? <div style={{ display: 'grid', gap: 8, padding: 8 }}>{[70, 55, 80, 62, 75].map((w) => <div key={w} className="sk" style={{ height: 12, width: `${w}%` }} />)}</div> : (
          <>
            {[...bySchema].map(([s, ts]) => (
              <div key={s}>
                <h4>{s}</h4>
                {ts.map((t) => (
                  <a key={t.name} href={href('data', env, store.service, t.schema, t.name)} aria-current={t === table ? 'true' : undefined} title={t.rows === null ? tr('Filas sin estimar: la tabla no se ha analizado') : tr('Unas {format} filas', { format: nf.format(t.rows) })}>
                    <Table2 /><span className="tn">{t.name}</span><span className="c">{t.rows === null ? '—' : nf.format(t.rows)}</span>
                  </a>
                ))}
              </div>
            ))}
            {!shown.length && <p className="faint" style={{ padding: '4px 8px', fontSize: 13 }}>{tables.length ? tr('Ninguna tabla coincide.') : tr('Esta base no tiene tablas todavía.')}</p>}
          </>
        )}
      </aside>

      <div className="center">
        <Tabs id={ids} label={tr('Vista')} className="doc-tabs" value={tab} onChange={setTab}
          tabs={[{ key: 'table' as const, label: table ? tableKey(table) : tr('Tabla'), icon: Table2 }, ...(recorded ? [] : [{ key: 'query' as const, label: tr('Consulta'), icon: SquareTerminal }])]} />
        <div className="dbx-panel" role="tabpanel" id={`${ids}-panel`} aria-labelledby={`${ids}-tab-${tab}`}>
          {tab === 'query' && !recorded ? <Query env={env} store={store} tables={tables} />
            : table ? <Grid key={tableKey(table)} env={env} store={store} table={table} />
            : schema.data ? <div className="empty">{tr('Sin tablas que mostrar. Prueba la pestaña Consulta.')}</div> : null}
        </div>
      </div>

      <aside className="right" aria-label={tr('Conexión y uso')}>
        {!recorded && <Connect env={env} store={store} />}
        {table && <Writers table={table} g={g} />}
      </aside>
    </div>
  );
}

// ---------- grid ----------

function Grid({ env, store, table }: { env: string; store: StoreInfo; table: Table }) {
  const [filters, setFilters] = useState<Filter[]>([]);
  const [sort, setSort] = useState<{ column: string; desc: boolean } | null>(null);
  const [page, setPage] = useState(0);
  const [res, setRes] = useState<{ data?: QueryResult; error?: string; loading: boolean }>({ loading: true });
  const [sel, setSel] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [filtering, setFiltering] = useState(false);
  const [tick, setTick] = useState(0);
  const pk = table.columns.filter((c) => c.pk);
  const cols = new Map(table.columns.map((c) => [c.name, c]));

  useEffect(() => {
    let live = true;
    setRes((r) => ({ ...r, loading: true }));
    api<QueryResult>('/api/db/rows', { method: 'POST', body: { env, service: store.service, browse: { schema: table.schema, table: table.name, filters, sort: sort ?? undefined, page, pageSize: PAGE } } })
      .then((data) => live && setRes({ data, loading: false }), (e: Error) => live && setRes({ error: e.message, loading: false }));
    return () => { live = false; };
  }, [env, store.service, table, filters, sort, page, tick]);
  useEffect(() => setSel(null), [filters, sort, page]);

  const data = res.data;
  const sortBy = (c: string) => { setPage(0); setSort((s) => (s?.column !== c ? { column: c, desc: false } : s.desc ? null : { column: c, desc: true })); };
  const from = page * PAGE;
  const total = table.rows === null ? '' : tr(' de unas {format}', { format: nf.format(table.rows) });
  // a recording is looked at, never written: no row of it is edited
  const recorded = useRecorded();
  const canEdit = pk.length > 0 && !recorded;
  const edit = (i: number) => { setSel(i); setEditing(i); };

  return (
    <>
      <div className="toolbar">
        {filters.map((f, i) => (
          <button key={i} className="flt on" aria-label={tr('Quitar el filtro {column} {opLabel} {p2}', { column: f.column, opLabel: opLabel(f.op), p2: f.value ?? '' })} onClick={() => { setFilters((l) => l.filter((_, j) => j !== i)); setPage(0); }}>
            <b>{f.column}</b> {opLabel(f.op)}{f.op !== 'null' && f.op !== 'not-null' ? <> <span className="mono">{f.value === '' ? "''" : f.value}</span></> : null}<X />
          </button>
        ))}
        <button className="flt" onClick={() => setFiltering(true)}><Plus />{tr('Añadir filtro')}</button>
        {sort && <button className="flt on" aria-label={tr('Quitar el orden por {column}', { column: sort.column })} onClick={() => setSort(null)}>{sort.desc ? <ArrowDown /> : <ArrowUp />}<b>{sort.column}</b> {sort.desc ? tr('descendente') : tr('ascendente')}<X /></button>}
        <span className="grow" />
        <button className="btn sm" aria-disabled={!canEdit || sel === null || undefined} title={!canEdit ? tr('Sin clave primaria: una fila se edita por su clave') : sel === null ? tr('Elige una fila') : undefined}
          onClick={() => canEdit && sel !== null && setEditing(sel)}><PencilLine />{tr('Fila')}</button>
        <button className="btn sm" aria-disabled={!data?.rows.length || undefined} onClick={() => data?.rows.length && download(`${table.name}-${from + 1}.csv`, toCsv(data.columns, data.rows))}><Download />{tr('Exportar')}</button>
      </div>
      <div className="grid-wrap" aria-busy={res.loading} tabIndex={0} aria-label={tr('Filas de {tableKey}', { tableKey: tableKey(table) })}>
        {res.error ? <div className="notice" role="alert" style={{ margin: 12 }}><CircleX />{res.error}</div> : !data ? (
          <div style={{ display: 'grid', gap: 10, padding: 16 }}>{Array.from({ length: 8 }, (_, i) => <div key={i} className="sk" style={{ height: 14, width: `${[92, 80, 88, 70][i % 4]}%` }} />)}</div>
        ) : (
          <table className="dg">
            <thead>
              <tr>
                <th className="rn"><span className="sr-only">{tr('Fila')}</span></th>
                {data.columns.map((c) => {
                  const col = cols.get(c), on = sort?.column === c;
                  return (
                    <th key={c} aria-sort={on ? (sort!.desc ? 'descending' : 'ascending') : undefined}>
                      <button className="th-sort" onClick={() => sortBy(c)} title={tr('Ordenar')}>
                        <span>{c}{col?.pk && <span className="pk" title={tr('Clave primaria')}>{' '}{tr('· PK')}</span>}</span>
                        {on ? (sort!.desc ? <ArrowDown /> : <ArrowUp />) : null}
                      </button>
                      {col && <small>{col.type}{col.nullable ? '' : tr(', not null')}</small>}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r, i) => (
                <tr key={from + i} className={sel === i ? 'sel' : undefined} onClick={() => setSel(i)} onDoubleClick={() => canEdit && edit(i)}>
                  <td className="rn num">{canEdit ? <button className="rn-btn" aria-label={tr('Editar la fila {p0}', { p0: from + i + 1 })} onClick={(e) => { e.stopPropagation(); edit(i); }}>{from + i + 1}</button> : from + i + 1}</td>
                  {r.map((v, j) => <Cell key={j} v={v} col={cols.get(data.columns[j])} />)}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data && !data.rows.length && !res.error && <p className="empty">{filters.length ? tr('Ninguna fila cumple los filtros.') : tr('La tabla está vacía.')}</p>}
      </div>
      <div className="gridfoot">
        <span className="num" aria-live="polite">{data ? (data.rows.length ? tr('Filas {format}–{format2}{total}', { format: nf.format(from + 1), format2: nf.format(from + data.rows.length), total }) : tr('Sin filas')) : tr('Cargando filas')}</span>
        <span className="hide-sm">{recorded ? tr('Grabado: las filas como quedaron, sin editar') : canEdit ? tr('Editar una fila enseña antes el UPDATE') : tr('Sin clave primaria: no se edita')}</span>
        <span className="grow" />
        {data && <span className="num">{data.ms} ms</span>}
        <button className="btn sm" aria-label={tr('Página anterior')} aria-disabled={page === 0 || undefined} onClick={() => page > 0 && setPage((p) => p - 1)}><ChevronLeft /></button>
        <button className="btn sm" aria-label={tr('Página siguiente')} aria-disabled={!data?.truncated || undefined} onClick={() => data?.truncated && setPage((p) => p + 1)}><ChevronRight /></button>
      </div>
      {filtering && <AddFilter columns={table.columns} onClose={() => setFiltering(false)} onAdd={(f) => { setFilters((l) => [...l, f]); setPage(0); }} />}
      {editing !== null && data?.rows[editing] && (
        <EditRow env={env} store={store} table={table} columns={data.columns} row={data.rows[editing]} onClose={() => setEditing(null)} onDone={() => setTick((t) => t + 1)} />
      )}
    </>
  );
}

function Cell({ v, col }: { v: string | null; col?: Column }) {
  if (v === null) return <td className="null">{tr('NULL')}</td>;
  if (v === '') return <td className="blank"><span className="sr-only">{tr('vacío')}</span></td>;
  return <td className={col && NUMERIC.test(col.type) ? 'r' : undefined} title={v.length > 60 ? v : undefined}>{v.length > 120 ? `${v.slice(0, 120)}…` : v}</td>;
}

function download(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function AddFilter({ columns, onClose, onAdd }: { columns: Column[]; onClose: () => void; onAdd: (f: Filter) => void }) {
  const [column, setColumn] = useState(columns[0]?.name ?? '');
  const [op, setOp] = useState<Filter['op']>('=');
  const [value, setValue] = useState('');
  const ids = useId();
  const needsValue = op !== 'null' && op !== 'not-null';
  const known = columns.some((c) => c.name === column);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!known) return;
    onAdd({ column, op, value: needsValue ? value : undefined });
    onClose();
  };
  return (
    <Dialog title={tr('Añadir filtro')} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="dlg-body form">
          <div className="fld">
            <label className="l" htmlFor={`${ids}-c`}>{tr('Columna')}</label>
            <input id={`${ids}-c`} className="mono" data-autofocus list={`${ids}-cols`} value={column} onChange={(e) => setColumn(e.target.value)} required autoComplete="off" spellCheck={false} aria-invalid={!known} aria-describedby={known ? undefined : `${ids}-ce`} />
            <datalist id={`${ids}-cols`}>{columns.map((c) => <option key={c.name} value={c.name}>{c.type}</option>)}</datalist>
            {!known && column && <span className="h form-err" id={`${ids}-ce`}>{tr('La tabla no tiene esa columna.')}</span>}
          </div>
          <div className="fld">
            <span className="l" aria-hidden="true">{tr('Condición')}</span>
            <Segmented label={tr('Condición')} value={op} onChange={setOp} options={OPS.map(([o, l]) => ({ key: o, label: l }))} />
          </div>
          {needsValue && (
            <div className="fld">
              <label className="l" htmlFor={`${ids}-v`}>{tr('Valor')}</label>
              <input id={`${ids}-v`} className="mono" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" spellCheck={false} aria-describedby={`${ids}-vh`} />
              <span className="h" id={`${ids}-vh`}>{tr('Se compara como texto y viaja como parámetro, nunca dentro del SQL.')}</span>
            </div>
          )}
        </div>
        <footer>
          <button type="button" className="btn" onClick={onClose}>{tr('Cancelar')}</button>
          <button className="btn primary" disabled={!known}>{tr('Filtrar')}</button>
        </footer>
      </form>
    </Dialog>
  );
}

/** Edit, then review the exact UPDATE (values shown), then apply as the owner. Nothing runs before «Aplicar». */
function EditRow({ env, store, table, columns, row, onClose, onDone }: { env: string; store: StoreInfo; table: Table; columns: string[]; row: Array<string | null>; onClose: () => void; onDone: () => void }) {
  const cols = new Map(table.columns.map((c) => [c.name, c]));
  const [vals, setVals] = useState<Array<string | null>>(row);
  const [review, setReview] = useState<{ preview: string; as: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ids = useId();
  const key = Object.fromEntries(columns.flatMap((c, i) => (cols.get(c)?.pk ? [[c, row[i] ?? '']] : [])));
  const set = Object.fromEntries(columns.flatMap((c, i) => (!cols.get(c)?.pk && vals[i] !== row[i] ? [[c, vals[i]]] : [])));
  const update = { schema: table.schema, table: table.name, key, set };
  const changed = Object.keys(set).length;
  const put = (i: number, v: string | null) => setVals((l) => l.map((x, j) => (j === i ? v : x)));
  // The button that switched the step is gone: focus goes to the new step's first thing.
  const box = useRef<HTMLDivElement>(null);
  const stepped = useRef(false);
  useEffect(() => {
    if (stepped.current) box.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    stepped.current = true;
  }, [review]);

  const toReview = async (e: FormEvent) => {
    e.preventDefault();
    if (!changed || busy) return;
    setBusy(true);
    setError('');
    try { setReview(await api<{ preview: string; as: string }>('/api/db/update/preview', { method: 'POST', body: { env, service: store.service, update } })); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const apply = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await api<{ ms: number }>('/api/db/update/apply', { method: 'POST', body: { env, service: store.service, update } });
      toast(tr('Fila actualizada en {ms} ms', { ms: r.ms }));
      onDone();
      onClose();
    } catch (err) { setError((err as Error).message); setBusy(false); }
  };

  return (
    <Dialog title={review ? tr('Revisa el UPDATE') : tr('Editar una fila de {name}', { name: table.name })} onClose={onClose} wide>
      <div ref={box}>
      {review ? (
        <>
          <div className="dlg-body">
            <p>{tr('Esto es exactamente lo que se ejecutará en')}{' '}<span className="mono">{store.db}</span>{' '}{tr('de')}{' '}{env}{tr(', como')}{' '}<span className="mono">{review.as}</span>:</p>
            <CodeBlock className="ctx sql-preview" text={review.preview} lang="sql" label={tr('El UPDATE')} autoFocus />
            <p className="faint">{tr('Cambia')}{' '}{plural(changed, tr('columna'), tr('columnas'))}{' '}{tr('de una sola fila, elegida por su clave primaria. No hay deshacer: «Resetear datos» en Entornos devuelve la base a su instantánea.')}</p>
            {error && <p className="form-err" role="alert">{error}</p>}
          </div>
          <footer>
            <button type="button" className="btn" onClick={() => setReview(null)}>{tr('Volver')}</button>
            <button type="button" className="btn destroy" aria-disabled={busy || undefined} onClick={apply}>{tr('Aplicar')}</button>
          </footer>
        </>
      ) : (
        <form onSubmit={toReview}>
          <div className="dlg-body form row-form">
            {columns.map((c, i) => {
              const col = cols.get(c);
              const isNull = vals[i] === null;
              return (
                <div className="fld" key={c}>
                  <label className="l" htmlFor={`${ids}-${i}`}><span className="mono">{c}</span> <span className="faint">{col?.type}{col?.pk ? tr(', clave primaria') : ''}</span></label>
                  <div className="row-in">
                    <input id={`${ids}-${i}`} className="mono" value={vals[i] ?? ''} placeholder={isNull ? tr('NULL') : undefined} readOnly={col?.pk} disabled={isNull} data-autofocus={i === columns.findIndex((x) => !cols.get(x)?.pk) || undefined}
                      onChange={(e) => put(i, e.target.value)} autoComplete="off" spellCheck={false} />
                    {col?.nullable && !col.pk && (
                      <label className="check"><input type="checkbox" checked={isNull} onChange={(e) => put(i, e.target.checked ? null : row[i] ?? '')} /><span>{tr('NULL')}</span></label>
                    )}
                  </div>
                </div>
              );
            })}
            {error && <p className="form-err" role="alert">{error}</p>}
          </div>
          <footer>
            <span className="faint grow" aria-live="polite">{changed ? tr('{plural} sin aplicar', { plural: plural(changed, tr('cambio'), tr('cambios')) }) : tr('Sin cambios')}</span>
            <button type="button" className="btn" onClick={onClose}>{tr('Cancelar')}</button>
            <button className="btn primary" aria-disabled={!changed || busy || undefined}>{tr('Revisar el UPDATE')}</button>
          </footer>
        </form>
      )}
      </div>
    </Dialog>
  );
}

// ---------- query ----------

const HISTORY = 20;
const historyKey = (env: string, s: string) => `laru:sql:${env}/${s}`;
function readHistory(k: string): string[] {
  try { const v = JSON.parse(localStorage.getItem(k) ?? '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; }
}

function Query({ env, store, tables }: { env: string; store: StoreInfo; tables: Table[] }) {
  const hk = historyKey(env, store.service);
  const [history, setHistory] = useState(() => readHistory(hk));
  const [sql, setSql] = useState(() => history[0] ?? '');
  const [res, setRes] = useState<{ data?: QueryResult; error?: string; loading: boolean }>({ loading: false });
  const [sug, setSug] = useState<{ from: number; items: string[] } | null>(null);
  const [active, setActive] = useState(0);
  const ed = useRef<HTMLTextAreaElement>(null);
  const ids = useId();
  const mac = useMemo(() => /Mac|iPhone|iPad/.test(navigator.platform), []);

  const run = async () => {
    const text = sql.trim();
    if (!text || res.loading) return;
    setRes((r) => ({ ...r, loading: true }));
    try {
      const data = await api<QueryResult>('/api/db/query', { method: 'POST', body: { env, service: store.service, sql: text, limit: 500 } });
      setRes({ data, loading: false });
    } catch (e) { setRes({ error: (e as Error).message, loading: false }); }
    const next = [text, ...history.filter((h) => h !== text)].slice(0, HISTORY);
    setHistory(next);
    try { localStorage.setItem(hk, JSON.stringify(next)); } catch { /* private window: history lives only in this tab */ }
  };
  // the colours may trail the typing by a frame on a long text; the typing never waits for them
  const shown = useDeferredValue(sql);
  const hl = useRef<HTMLPreElement>(null);
  const update = (value: string, caret: number) => { setSql(value); setSug(suggest(value, caret, tables)); setActive(0); };
  const accept = (item: string) => {
    if (!sug || !ed.current) return;
    const caret = ed.current.selectionStart;
    const next = sql.slice(0, sug.from) + item + sql.slice(caret);
    const at = sug.from + item.length;
    setSql(next);
    setSug(null);
    requestAnimationFrame(() => { ed.current?.focus(); ed.current?.setSelectionRange(at, at); });
  };
  const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); setSug(null); run(); return; }
    if (!sug) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + sug.items.length) % sug.items.length); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); accept(sug.items[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); setSug(null); }
  };
  const data = res.data;

  return (
    <div className="query">
      <div className="sql-box">
        <label className="sr-only" htmlFor={`${ids}-sql`}>SQL</label>
        {/* the colours are a layer under a transparent textarea: the same text in the same box, so the caret, the selection and the keyboard are the browser's own */}
        <div className="sql-field">
        <pre ref={hl} className="sql-hl" aria-hidden="true"><Code text={`${shown}\n`} lang="sql" /></pre>
        <textarea id={`${ids}-sql`} ref={ed} className="sql-ed" value={sql} onScroll={(e) => { if (hl.current) { hl.current.scrollTop = e.currentTarget.scrollTop; hl.current.scrollLeft = e.currentTarget.scrollLeft; } }} spellCheck={false} autoComplete="off" rows={6}
          placeholder={tr('SELECT * FROM {p0} LIMIT 50', { p0: tables[0] ? tableKey(tables[0]) : tr('tabla') })}
          role="combobox" aria-autocomplete="list" aria-expanded={Boolean(sug)} aria-controls={`${ids}-sug`} aria-activedescendant={sug ? `${ids}-o${active}` : undefined}
          aria-describedby={`${ids}-hint`}
          onChange={(e) => update(e.target.value, e.target.selectionStart)} onKeyDown={keys} onBlur={() => setSug(null)} />
        </div>
        {sug && (
          <ul className="suggest" role="listbox" id={`${ids}-sug`} aria-label={tr('Sugerencias del esquema')}>
            {sug.items.map((s, i) => (
              <li key={s} id={`${ids}-o${i}`} role="option" aria-selected={i === active} onMouseDown={(e) => { e.preventDefault(); accept(s); }} onMouseEnter={() => setActive(i)}>
                {tables.some((t) => s === tableKey(t) || s === t.name) ? <Table2 /> : s.endsWith('.') ? <Database /> : <Columns3 />}<span className="mono">{s}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="sql-bar">
          <span className="faint" id={`${ids}-hint`}>{tr('Como')}{' '}<span className="mono">ks_reader</span>{tr(', de solo lectura.')}{' '}<kbd>{mac ? '⌘' : tr('Ctrl')}</kbd> <kbd>↵</kbd>{' '}{tr('ejecuta;')}{' '}<kbd>↑</kbd> <kbd>↓</kbd>{' '}{tr('y')}{' '}<kbd>Tab</kbd>{' '}{tr('eligen una sugerencia.')}</span>
          <span className="grow" />
          <button className="btn sm" aria-disabled={!data?.rows.length || undefined} onClick={() => data?.rows.length && download(tr('consulta.csv'), toCsv(data.columns, data.rows))}><Download />CSV</button>
          <button className="btn sm primary" aria-disabled={!sql.trim() || res.loading || undefined} onClick={run}><Play className={res.loading ? 'spin' : undefined} />{tr('Ejecutar')}</button>
        </div>
      </div>
      <div className="grid-wrap" aria-busy={res.loading} aria-live="polite" tabIndex={data ? 0 : undefined} aria-label={tr('Resultado')}>
        {res.error ? <div className="notice" role="alert" style={{ margin: 12 }}><CircleX /><div className="mono pre-line"><Code text={res.error} lang="log" /></div></div>
          : data ? (
            data.columns.length ? (
              <table className="dg">
                <thead><tr><th className="rn"><span className="sr-only">{tr('Fila')}</span></th>{data.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
                <tbody>{data.rows.map((r, i) => <tr key={i}><td className="rn num">{i + 1}</td>{r.map((v, j) => <Cell key={j} v={v} />)}</tr>)}</tbody>
              </table>
            ) : <p className="empty">{tr('La consulta no devolvió columnas.')}</p>
          ) : history.length ? (
            <div className="history">
              <h4>{tr('Historial en este navegador')}</h4>
              <ul>{history.map((h) => <li key={h}><button onClick={() => { setSql(h); ed.current?.focus(); }} title={h}><Search /><span className="mono">{h.replace(/\s+/g, ' ')}</span></button></li>)}</ul>
            </div>
          ) : <p className="empty">{tr('Escribe una consulta y ejecútala. Las tablas y columnas del esquema se sugieren al escribir.')}</p>}
      </div>
      {data && (
        <div className="gridfoot">
          <span className="num">{plural(data.rows.length, tr('fila'), tr('filas'))}{data.truncated ? tr(', las primeras 500') : ''}</span>
          <span className="grow" />
          <span className="num">{data.ms} ms</span>
          {history.length > 0 && <button className="btn sm" onClick={() => setRes({ loading: false })}>{tr('Historial')}</button>}
        </div>
      )}
    </div>
  );
}

// ---------- connection and writers ----------

function Connect({ env, store }: { env: string; store: StoreInfo }) {
  const c = store.conn;
  const fields: Array<[string, string | undefined]> = [
    [tr('Host y puerto'), c.port ? `${c.host}:${c.port}` : undefined],
    [tr('Base de datos'), c.db],
    [tr('Usuario'), c.user],
    ['JDBC', c.jdbc],
    ['URL', c.url],
    [tr('Shell en el contenedor'), c.shell],
  ];
  return (
    <section aria-labelledby="conn-h">
      <h3 id="conn-h" className="aside-h">{tr('Conectar')}</h3>
      <span className="faint aside-sub">{store.service}{' '}{tr('en')}{' '}{env}{tr(', con el usuario del entorno')}</span>
      <div className="conn">
        {fields.slice(0, 3).map(([l, v]) => <Field key={l} label={l} value={v} />)}
        <span className="lbl">{tr('Contraseña')}</span>
        <div className="f">
          <Reveal name={tr('la contraseña de {service}', { service: store.service })} masked load={() => api<{ value: string | null }>('/api/db/password', { method: 'POST', body: { env, service: store.service } })
            .then((r) => { if (r.value === null) toast(tr('{service} arrancó sin contraseña', { service: store.service })); return r.value; })} />
        </div>
        {fields.slice(3).map(([l, v]) => <Field key={l} label={l} value={v} />)}
      </div>
      {!c.port && <p className="faint aside-sub">{tr('Sin puerto publicado en esta máquina: entra con el shell del contenedor.')}</p>}
      {c.intellij && <button className="btn wide-btn" onClick={() => copy(c.intellij!, tr('Fuente de datos copiada: pégala en la vista Database de IntelliJ'))}><Database />{tr('Copiar fuente de datos IntelliJ')}</button>}
    </section>
  );
}

const REL: Record<string, { verb: string; order: number }> = {
  writes: { verb: tr('La escribe'), order: 0 },
  'maps-table': { verb: tr('La mapea como entidad'), order: 1 },
  reads: { verb: tr('La lee'), order: 2 },
  'defines-table': { verb: tr('La define'), order: 3 },
};

/** Who writes the table: what the code says (extracted) and what runs saw (observed, with the run and how many). */
function Writers({ table, g }: { table: Table; g: Indexed | null }) {
  const ids = [`tbl:${table.schema}.${table.name}`.toLowerCase(), ...(table.schema === 'public' ? [`tbl:${table.name}`.toLowerCase()] : [])];
  const facts = (g ? ids.flatMap((id) => g.in(id)) : []).filter((f) => f.p in REL).sort((a, b) => REL[a.p].order - REL[b.p].order);
  const bySubject = Map.groupBy(facts, (f) => f.s);
  return (
    <section aria-labelledby="writers-h">
      <h3 id="writers-h" className="aside-h">{tr('Quién escribe en')}{' '}{table.name}</h3>
      {!g ? <p className="faint aside-sub">{tr('El mapa no se ha leído: pulsa «Releer el código» en Proyectos.')}</p> : !facts.length ? (
        <p className="faint aside-sub">{tr('Ningún servicio la mapea en el código ni se ha visto escribirla en un run. Ejecuta un flujo que la toque y aparecerá aquí.')}</p>
      ) : (
        <ul className="writers">
          {[...bySubject].map(([s, fs]) => {
            const node = g.nodes.get(s);
            const name = node?.name ?? s.replace(/^\w+:/, '');
            const repo = s.startsWith('repo:');
            return (
              <li key={s}>
                <div>
                  {repo ? <GitBranch /> : <Server />}
                  <a className="rowlink mono" href={repo ? href('repos', name) : href('map', s)}>{name}</a>
                </div>
                {fs.map((f) => (
                  <p key={f.p + (f.anchor?.path ?? '')}>
                    <Origin of={f.origin} label={false} /> {REL[f.p].verb}
                    {f.seen ? tr(': vista en {plural}, el último el {run}', { plural: plural(f.seen.count, 'run', 'runs'), run: f.seen.run }) : f.anchor ? <>{' '}{tr('en')}{' '}<span className="mono" title={`${f.anchor.repo}:${f.anchor.path}${f.anchor.line ? `:${f.anchor.line}` : ''}`}>{f.anchor.path.split('/').pop()}{f.anchor.line ? `:${f.anchor.line}` : ''}</span></> : ''}
                  </p>
                ))}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
