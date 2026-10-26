/**
 * Variables and secrets of one environment: every key against every level, the level that wins marked, and each value
 * in sight and editable where it is. Laru runs on the person's own machine, so a secret is shown like any value.
 */
import { CircleDashed, CircleX, FileDown, Info, Lock, Plus } from 'lucide-react';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { api, useApi, type EnvSummary, type Level, type VarIssue, type VarRow, type VarsData } from '../api.ts';
import { Dialog, Segmented, Skeleton, toast } from '../components/ui.tsx';
import { BLOCKS, importWarning, LEVEL, plural, varIssueText } from '../lib/es.ts';
import { flowOfEnv, useEnvList } from '../lib/useEnvs.ts';
import { href } from '../lib/route.ts';

/** Mirrors the runtime's SECRET_KEY: the web imports only types, and this only picks a default. */
const LOOKS_SECRET = /(^|[_.-])(SECRET|PASSWORD|PASSWD|KEY|TOKEN)S?([_.-]|$)/i;
const LEVELS: Level[] = ['app', 'env', 'service', 'personal'];

export function Vars({ env: selected, app, repos }: { env?: string; app: string; repos: string[] }) {
  const envs = useEnvList();
  const names = (envs.data ?? []).map((e) => e.env);
  const env = names.find((n) => n === selected) ?? (envs.data ?? []).find((e) => e.state === 'ready')?.env ?? names[0];
  const vars = useApi<VarsData>(env ? `/api/vars?env=${encodeURIComponent(env)}` : null);
  const [adding, setAdding] = useState<{ key: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const data = vars.data?.env === env ? vars.data : undefined;

  const services = [...new Set((data?.rows ?? []).flatMap((r) => [...r.compose, ...r.readers]))].sort();
  const errors = (data?.issues ?? []).filter((i) => i.level === 'error');
  const warnings = (data?.issues ?? []).filter((i) => i.level === 'warning');

  let body;
  if (envs.error || vars.error) body = <div className="notice" role="alert"><CircleX />{envs.error ?? vars.error}</div>;
  else if (envs.data && !env) body = (
    <section className="panel"><div className="empty">
      {flowOfEnv() ? <span>Este flujo todavía no tiene su entorno, y sus variables son solo de él. Aprovisiónalo desde «Probar en vivo».</span> : <span>Las variables se leen por entorno, y este workspace todavía no tiene ninguno. Crea uno con <code>laru env init local --from &lt;repo&gt;:&lt;compose&gt;</code>.</span>}
    </div></section>
  );
  else if (!data) body = <Skeleton lines={8} />;
  else body = (
    <>
      {!data.read && <div className="notice info"><Info /><div>El compose de {env} se lee en su primer arranque. Hasta entonces la tabla muestra lo que guarda el vault y quién lo lee según el código, pero no lo que el compose pide ni lo que falta.</div></div>}
      {errors.map((i) => <IssueNotice key={i.message} i={i} env={env!} fix={() => setAdding({ key: i.key })} />)}
      {warnings.length > 0 && <Warnings issues={warnings} env={env!} />}
      <section className="panel">
        <header>
          <h3>Claves de {env}</h3>
          <div className="meta">
            {names.length > 1 && (
              <nav className="seg" aria-label="Entorno">{names.map((n) => <a key={n} href={href('vars', n)} aria-current={n === env ? 'page' : undefined}>{n}</a>)}</nav>
            )}
            <span className="num">{plural(data.rows.length, 'clave', 'claves')}</span>
          </div>
        </header>
        {data.rows.length ? <VarTable env={env!} rows={data.rows} issues={data.issues} reload={vars.reload} /> : <div className="empty">Ninguna clave todavía. Añade una o importa el <code>.env.example</code> de un repositorio.</div>}
        <div className="legend">
          <span><i className="win-mark" aria-hidden="true" />La celda marcada es la que gana</span>
          <span><Lock />Secreto: se ve y se edita aquí; en disco va cifrado con AES-256-GCM</span>
          <span>Personal: <span className="mono">~/.laru/{app}/overrides.yaml</span>, no se versiona</span>
        </div>
      </section>
    </>
  );

  return (
    <div className="page wide">
      <div className="head">
        <div><h1>Variables y secretos</h1><p>Fuera de los repos. Cada clave dice qué nivel gana; haz clic en un valor para cambiarlo. Todo está en tu máquina: los secretos se ven y se editan como cualquier valor, y en disco van cifrados.</p></div>
        <div className="actions">
          <button className="btn" onClick={() => setImporting(true)}><FileDown />Importar .env.example</button>
          <button className="btn primary" disabled={!env} onClick={() => setAdding({ key: '' })}><Plus />Añadir variable</button>
        </div>
      </div>
      {body}
      {adding && env && <AddVar env={env} envs={names} services={services} initialKey={adding.key} onClose={() => setAdding(null)} onSaved={vars.reload} />}
      {importing && <ImportEnv repos={repos} onClose={() => setImporting(false)} onDone={vars.reload} />}
    </div>
  );
}

function IssueNotice({ i, env, fix }: { i: VarIssue; env: string; fix: () => void }) {
  const { title, text } = varIssueText(i, env);
  return (
    <div className="notice">
      <CircleX />
      <div className="grow"><b>{title}</b> {text}</div>
      {i.code !== 'plain-secret' && <button className="btn sm" onClick={fix}>Darle valor</button>}
    </div>
  );
}

/** Warnings stay one notice: a vault with many unused keys should not push the table off the screen. */
function Warnings({ issues, env }: { issues: VarIssue[]; env: string }) {
  const [open, setOpen] = useState(issues.length <= 3);
  const shown = open ? issues : issues.slice(0, 3);
  return (
    <div className="notice warn">
      <CircleDashed />
      <div className="grow">
        <ul className="issues">{shown.map((i) => { const { title, text } = varIssueText(i, env); return <li key={i.message}><b>{title}</b> {text}</li>; })}</ul>
        {issues.length > 3 && <button className="linkish" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? 'Ver menos' : `Ver los ${issues.length} avisos`}</button>}
      </div>
    </div>
  );
}

const COLUMNS: Array<[string, (section: string, env: string) => boolean]> = [
  ['Aplicativo', (s) => s === 'app'],
  ['Entorno', (s, env) => s === `env.${env}`],
  ['Servicio', (s) => s.startsWith('service.')],
  ['Personal', (s) => s === 'personal'],
  ['Flujos', (s) => s === 'flows'],
];

/** Every level's value for this env, as the vault holds them: this is the person's own machine, so nothing is hidden. */
function useValues(env: string) {
  const [entries, setEntries] = useState<Array<{ section: string; key: string; secret: boolean; value: string }>>();
  const load = () => api<{ entries: NonNullable<typeof entries> }>('/api/vars/values', { method: 'POST', body: { env } }).then((r) => setEntries(r.entries), () => setEntries([]));
  useEffect(() => { setEntries(undefined); void load(); }, [env]); // eslint-disable-line react-hooks/exhaustive-deps
  return { value: (section: string, key: string) => entries?.find((e) => e.section === section && e.key === key)?.value, loaded: Boolean(entries), load };
}

/** A value on screen that can be changed where it is: click, type, Enter. Empty, it is a «+»; Esc leaves it as it was. */
function ValueCell({ keyName, secret, section, env, value, inherited, label, onSaved }: { keyName: string; secret: boolean; section: string; env: string; value?: string; /** what it has from a higher level, shown faint until it is set here */ inherited?: string; label?: string; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const level = (section.startsWith('env.') ? 'env' : section.startsWith('service.') ? 'service' : section) as Level;
  const scope = section.startsWith('env.') ? section.slice(4) : section.startsWith('service.') ? section.slice(8) : undefined;
  const save = async () => {
    try { await api('/api/vars/set', { method: 'POST', body: { key: keyName, value: draft, level, scope, secret: secret || LOOKS_SECRET.test(keyName) } }); setEditing(false); onSaved(); }
    catch (e) { toast((e as Error).message); }
  };
  const unset = async () => {
    try { await api('/api/vars/unset', { method: 'POST', body: { key: keyName, level, scope } }); setEditing(false); onSaved(); }
    catch (e) { toast((e as Error).message); }
  };
  if (editing) return (
    <form className="vedit" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <input className="mono" autoFocus value={draft} aria-label={`Valor de ${keyName}${label ? ` en ${label}` : ''}`} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false); }} spellCheck={false} autoComplete="off" />
      <button className="btn sm primary" type="submit">Guardar</button>
      {value !== undefined && <button className="btn sm" type="button" onClick={() => void unset()}>Quitar</button>}
    </form>
  );
  return (
    <button className={`vcell${value === undefined ? ' add' : ''}`} onClick={() => { setDraft(value ?? inherited ?? ''); setEditing(true); }} title={value === undefined ? 'Añadir un valor en este nivel' : 'Cambiar el valor'}>
      {label && <span className="faint">{label} </span>}
      {value === undefined && inherited !== undefined ? <span className="mono faint" title="Viene de un nivel superior: guardar aquí lo fija solo para este entorno">{inherited}</span> : value === undefined ? <Plus aria-label="Añadir valor" /> : value === '' ? <i className="faint">vacío</i> : <>{secret && <Lock aria-hidden="true" />}<span className="mono">{value}</span></>}
    </button>
  );
}

/** A flow's environment is isolated: one value per key, written for that environment alone. */
function FlowVarTable({ env, rows, issues, reload }: { env: string; rows: VarRow[]; issues: VarIssue[]; reload: () => void }) {
  const missing = new Set(issues.filter((i) => BLOCKS.has(i.code)).map((i) => i.key));
  const vals = useValues(env);
  const saved = () => { void vals.load(); reload(); };
  const mine = `env.${env}`;
  return (
    <div className="scroll-x">
      <table className="t vt">
        <thead><tr><th>Clave</th><th>Valor en {env}</th><th>Lo leen</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.key} className={missing.has(r.key) ? 'missing' : undefined}>
            <td className="key">{r.key}{r.secret && <Lock aria-label="Secreto" style={{ marginLeft: 6 }} />}</td>
            <td className="cell set"><ValueCell keyName={r.key} secret={r.secret} section={mine} env={env} value={r.levels.includes(mine) ? vals.value(mine, r.key) ?? (vals.loaded ? undefined : '…') : undefined}
              inherited={r.effective && r.effective !== 'compose' && r.effective !== mine ? vals.value(r.effective, r.key) : undefined} onSaved={saved} /></td>
            <td className="readers">{r.readers.length ? r.readers.join(', ') : <span className="faint">Nadie, según el código</span>}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

type TableProps = { env: string; rows: VarRow[]; issues: VarIssue[]; reload: () => void };
const VarTable = (p: TableProps) => (flowOfEnv() ? <FlowVarTable {...p} /> : <GlobalVarTable {...p} />);

function GlobalVarTable({ env, rows, issues, reload }: TableProps) {
  const missing = new Set(issues.filter((i) => BLOCKS.has(i.code)).map((i) => i.key));
  const unused = new Set(issues.filter((i) => i.code === 'unused-var').map((i) => i.key));
  const vals = useValues(env);
  // A change moves what wins and which levels are set: both the values and the rows are read again.
  const saved = () => { void vals.load(); reload(); };
  return (
    <div className="scroll-x">
      <table className="t vt">
        <thead><tr><th>Clave</th><th>Compose</th>{COLUMNS.map(([l]) => <th key={l}>{l}</th>)}<th>Lo leen</th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const composeWins = r.effective === 'compose';
            return (
              <tr key={r.key} className={missing.has(r.key) ? 'missing' : unused.has(r.key) ? 'unused' : undefined}>
                <td className="key">{r.key}{r.secret && <Lock aria-label="Secreto" style={{ marginLeft: 6 }} />}</td>
                <td className={`cell${r.compose.length ? ' set' : ''}${composeWins ? ' win' : ''}`} title={r.compose.join(', ') || undefined}>
                  {r.compose.length === 0 ? '—' : r.compose.length === 1 ? r.compose[0] : plural(r.compose.length, 'servicio', 'servicios')}
                  {composeWins && <span className="sr-only"> (gana)</span>}
                </td>
                {COLUMNS.map(([l, match]) => {
                  const set = r.levels.filter((sec) => match(sec, env));
                  const wins = r.effective !== null && set.includes(r.effective);
                  const one = l === 'Aplicativo' ? 'app' : l === 'Entorno' ? `env.${env}` : l === 'Personal' ? 'personal' : l === 'Flujos' ? 'flows' : '';
                  return (
                    <td key={l} className={`cell${set.length ? ' set' : ''}${wins ? ' win' : ''}`}>
                      {l === 'Servicio'
                        ? (set.length ? set.map((sec) => <ValueCell key={sec} keyName={r.key} secret={r.secret} section={sec} env={env} value={vals.value(sec, r.key)} label={sec.slice(8)} onSaved={saved} />) : '—')
                        : <ValueCell keyName={r.key} secret={r.secret} section={one} env={env} value={set.length ? vals.value(one, r.key) ?? (vals.loaded ? undefined : '…') : undefined} onSaved={saved} />}
                      {wins && <span className="sr-only"> (gana)</span>}
                    </td>
                  );
                })}
                <td className="readers">{r.readers.length ? r.readers.join(', ') : <span className="faint">Nadie, según el código</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const LEVEL_HINT: Record<string, string> = {
  app: 'Para todos los entornos y servicios. Se versiona en vault/vars.yaml.',
  env: 'Solo en un entorno.',
  service: 'Solo para un servicio, en todos los entornos.',
  personal: 'Solo en esta máquina, en ~/.laru; no se versiona.',
};

function AddVar({ env, envs, services, initialKey, onClose, onSaved }: { env: string; envs: string[]; services: string[]; initialKey: string; onClose: () => void; onSaved: () => void }) {
  const [key, setKey] = useState(initialKey);
  const [level, setLevel] = useState<Level>('app');
  const [scope, setScope] = useState('');
  const [value, setValue] = useState('');
  const [secret, setSecret] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ids = useId();
  const isSecret = secret ?? LOOKS_SECRET.test(key);
  const scoped = level === 'env' || level === 'service';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/vars/set', { method: 'POST', body: { key, value, level, scope: scoped ? scope : undefined, secret: isSecret } });
      toast(`${key} guardada${isSecret ? ' como secreto' : ''} en ${LEVEL[level].toLowerCase()}${scoped ? ` ${scope}` : ''}`);
      onSaved();
      onClose();
    } catch (err) { setError((err as Error).message); setBusy(false); }
  };

  return (
    <Dialog title="Añadir variable" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="dlg-body form">
          <label className="fld">
            <span className="l">Clave</span>
            <input className="mono" data-autofocus required value={key} onChange={(e) => setKey(e.target.value)} pattern="[A-Za-z_][A-Za-z0-9_]*"
              title="Letras, números y _, sin empezar por un número" autoComplete="off" spellCheck={false} />
          </label>
          <div className="fld">
            <span className="l" aria-hidden="true">Nivel</span>
            <Segmented label="Nivel" value={level} onChange={(l) => { setLevel(l); setScope(l === 'env' ? env : ''); }} options={LEVELS.map((l) => ({ key: l, label: LEVEL[l] }))} />
            <span className="h" aria-live="polite">{LEVEL_HINT[level]}</span>
          </div>
          {scoped && (
            <label className="fld">
              <span className="l">{level === 'env' ? 'Entorno' : 'Servicio'}</span>
              <input className="mono" required list={`${ids}-scopes`} value={scope} onChange={(e) => setScope(e.target.value)} autoComplete="off" spellCheck={false} />
              <datalist id={`${ids}-scopes`}>{(level === 'env' ? envs : services).map((s) => <option key={s} value={s} />)}</datalist>
            </label>
          )}
          <div className="fld">
            <label className="l" htmlFor={`${ids}-v`}>Valor</label>
            <input id={`${ids}-v`} type="password" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="new-password" spellCheck={false} aria-describedby={`${ids}-vh`} />
            <span className="h" id={`${ids}-vh`}>No se muestra al escribirlo ni pasa por la línea de comandos.</span>
          </div>
          <label className="check">
            <input type="checkbox" checked={isSecret} onChange={(e) => setSecret(e.target.checked)} />
            <span>Secreto: se cifra en vault/secrets.enc y no aparece nunca en claro</span>
          </label>
          {error && <p className="form-err" role="alert">{error}</p>}
        </div>
        <footer>
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn primary" disabled={busy}>Guardar</button>
        </footer>
      </form>
    </Dialog>
  );
}

interface Imported { imported: Array<{ key: string; secret: boolean }>; skipped: string[]; warnings: string[] }

/** Warnings are worth reading (a secret too short to mask): they stay in the dialog instead of a passing toast. */
function ImportEnv({ repos, onClose, onDone }: { repos: string[]; onClose: () => void; onDone: () => void }) {
  const [from, setFrom] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Imported | null>(null);
  const ids = useId();
  const summary = (r: Imported) => {
    const secrets = r.imported.filter((x) => x.secret).length;
    return [
      r.imported.length ? `Importadas ${plural(r.imported.length, 'clave', 'claves')}${secrets ? `, ${secrets} como secreto` : ''}` : 'Nada nuevo que importar',
      r.skipped.length ? `${r.skipped.length} ya tenían valor` : '',
    ].filter(Boolean).join('; ');
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<Imported>('/api/vars/import', { method: 'POST', body: { from } });
      onDone();
      if (r.warnings.length) { setResult(r); setBusy(false); return; }
      toast(summary(r));
      onClose();
    } catch (err) { setError((err as Error).message); setBusy(false); }
  };
  if (result) return (
    <Dialog title="Importado, con avisos" onClose={onClose}>
      <div className="dlg-body" role="status">
        <p>{summary(result)}.</p>
        {result.imported.length > 0 && <p className="mono faint">{result.imported.map((x) => x.key + (x.secret ? ' (secreto)' : '')).join(', ')}</p>}
        <ul className="issues warn-list">{result.warnings.map((w) => <li key={w}>{importWarning(w)}</li>)}</ul>
      </div>
      <footer><button type="button" className="btn primary" data-autofocus onClick={onClose}>Cerrar</button></footer>
    </Dialog>
  );
  return (
    <Dialog title="Importar .env.example" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="dlg-body form">
          <div className="fld">
            <label className="l" htmlFor={`${ids}-f`}>Fichero</label>
            <input id={`${ids}-f`} className="mono" data-autofocus required value={from} onChange={(e) => setFrom(e.target.value)} placeholder={`${repos[0] ?? 'repo'}:.env.example`}
              pattern="[a-z0-9][a-z0-9\-]*:.+" title="<repo>:<ruta>" autoComplete="off" spellCheck={false} aria-describedby={`${ids}-h`} />
            <span className="h" id={`${ids}-h`}>Se lee tal como está en la rama de referencia, sin tocar tu copia. Las claves que parecen secretas se guardan cifradas, y las que ya tienen valor en el aplicativo se conservan.</span>
          </div>
          {error && <p className="form-err" role="alert">{error}</p>}
        </div>
        <footer>
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn primary" disabled={busy}>Importar</button>
        </footer>
      </form>
    </Dialog>
  );
}
