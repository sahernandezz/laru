/**
 * A store explored the way laru.yaml says (`stores.<name>.explore`): any engine, through the command its own
 * container has. What there is to open comes from the declared `tables` input; opening one runs `table`; the console
 * sends what is typed. A CSV or TSV answer is a grid, anything else is text.
 */
import { CircleX, Play, Table2 } from 'lucide-react';
import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { api } from '../api.ts';
import { Code, Skeleton } from '../components/ui.tsx';
import { plural } from '../lib/es.ts';

export interface CustomStoreInfo { service: string; kind: string; container: string; tables: boolean }
interface Answer { columns?: string[]; rows?: Array<Array<string | null>>; text?: string; truncated?: boolean; ms: number }

const run = (env: string, service: string, what: 'query' | 'tables' | 'table', input?: string) =>
  api<Answer>(`/api/custom/run?env=${encodeURIComponent(env)}`, { method: 'POST', body: { env, service, what, input } });

/** What the `tables` answer lists: a grid's first column, or a text's non-empty lines. */
const namesOf = (a: Answer) => (a.rows ? a.rows.map((r) => String(r[0] ?? '')) : (a.text ?? '').split('\n').map((l) => l.trim())).filter(Boolean);

function Result({ state }: { state: { loading?: boolean; error?: string; data?: Answer } }) {
  const d = state.data;
  return (
    <>
      <div className="grid-wrap" aria-busy={state.loading} aria-live="polite" tabIndex={d ? 0 : undefined} aria-label="Resultado">
        {state.error ? <div className="notice" role="alert" style={{ margin: 12 }}><CircleX /><div className="mono pre-line"><Code text={state.error} lang="log" /></div></div>
          : state.loading && !d ? <Skeleton lines={5} />
          : d?.columns ? (
            <table className="dg">
              <thead><tr><th className="rn"><span className="sr-only">Fila</span></th>{d.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
              <tbody>{d.rows!.map((r, i) => <tr key={i}><td className="rn num">{i + 1}</td>{r.map((v, j) => <td key={j} className={v === null ? 'null' : undefined}>{v ?? 'NULL'}</td>)}</tr>)}</tbody>
            </table>
          ) : d ? <pre className="mono" style={{ margin: 12, whiteSpace: 'pre-wrap' }}>{d.text || '(sin salida)'}</pre>
          : <p className="empty">Escribe lo que entiende este almacén y ejecútalo.</p>}
      </div>
      {d && <div className="gridfoot"><span className="num">{d.rows ? plural(d.rows.length, 'fila', 'filas') + (d.truncated ? ', las primeras 1000' : '') : 'texto'}</span><span className="grow" /><span className="num">{d.ms} ms</span></div>}
    </>
  );
}

export function CustomView({ env, nav, store, tableArg, at }: { env: string; nav: ReactNode; store: CustomStoreInfo; tableArg?: string; at: (name: string) => string }) {
  const [names, setNames] = useState<{ list?: string[]; error?: string }>({});
  const [res, setRes] = useState<{ loading?: boolean; error?: string; data?: Answer }>({});
  const [input, setInput] = useState('');
  useEffect(() => {
    if (!store.tables) return;
    run(env, store.service, 'tables').then((a) => setNames({ list: namesOf(a) }), (e: Error) => setNames({ error: e.message }));
  }, [env, store.service, store.tables]);
  useEffect(() => {
    if (!tableArg) return;
    setRes({ loading: true });
    run(env, store.service, 'table', tableArg).then((data) => setRes({ data }), (e: Error) => setRes({ error: e.message }));
  }, [env, store.service, tableArg]);
  const send = () => {
    if (!input.trim() || res.loading) return;
    setRes({ loading: true });
    run(env, store.service, 'query', input).then((data) => setRes({ data }), (e: Error) => setRes({ error: e.message }));
  };
  const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send(); } };

  return (
    <div className="dbx">
      <aside className="schema" aria-label="Contenido">
        {nav}
        {store.tables && (
          <>
            <h4>Contenido</h4>
            {names.error ? <p className="form-err" style={{ padding: '0 8px' }}>{names.error}</p>
              : !names.list ? <Skeleton lines={4} />
              : names.list.length ? names.list.map((n) => <a key={n} href={at(n)} aria-current={n === tableArg ? 'true' : undefined}><Table2 /><span className="tn">{n}</span></a>)
              : <p className="faint" style={{ padding: '4px 8px', fontSize: 13 }}>No hay nada que abrir todavía.</p>}
          </>
        )}
      </aside>
      <div className="center">
        <div className="query">
          <div className="sql-box">
            <label className="sr-only" htmlFor="custom-in">Consulta</label>
            <textarea id="custom-in" className="sql-ed mono" rows={5} value={input} spellCheck={false} autoComplete="off" onChange={(e) => setInput(e.target.value)} onKeyDown={keys}
              placeholder={`Lo que entiende ${store.service} (${store.kind})`} style={{ position: 'static', color: 'inherit' }} />
            <div className="sql-bar">
              <span className="faint">Va a la orden de <span className="mono">explore.query</span> en laru.yaml, dentro del contenedor. <kbd>⌘</kbd>/<kbd>Ctrl</kbd> <kbd>↵</kbd> ejecuta.</span>
              <span className="grow" />
              <button className="btn sm primary" aria-disabled={!input.trim() || res.loading || undefined} onClick={send}><Play className={res.loading ? 'spin' : undefined} />Ejecutar</button>
            </div>
          </div>
          <Result state={res} />
        </div>
      </div>
    </div>
  );
}
