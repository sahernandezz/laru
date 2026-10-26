/**
 * The service's home page (`/`): every workspace this machine knows, and the machine itself — Docker, what runs now,
 * how many envs may run at once. Also «Añadir workspace», which the switcher opens too.
 */
import { ArrowRight, Check, ChevronDown, Cpu, FolderPlus, Plus, Square, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { api, useApi, type MachineInfo, type WorkspaceProbe, type WorkspaceRow } from '../api.ts';
import { Dialog, Dot, Logo, PathChip, Segmented, Skeleton, Status, tilde, toast } from '../components/ui.tsx';
import { ago, plural, probeText, RUN_DOT, RUN_STATUS, size, twinText, workspaceError } from '../lib/es.ts';
import { HOME, homeRedirect, wsPage } from '../lib/route.ts';
import { Destroy } from './Envs.tsx';

/** A workspace's colour, from its id: the same one every time, to tell the cards apart at a glance. */
const hue = (id: string) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

export function Home() {
  const rows = useApi<WorkspaceRow[]>('/api/workspaces');
  const [adding, setAdding] = useState(false);
  const [going, setGoing] = useState(false);
  useEffect(() => { document.title = 'Workspaces — Laru'; }, []);
  // The only workspace, or an address from before workspaces had paths: straight there.
  useEffect(() => { const to = rows.data && homeRedirect(location.hash, rows.data, location.search); if (to) { setGoing(true); location.replace(to); } }, [rows.data]);
  const list = rows.data ?? [];

  return (
    <div className="home">
      <header className="top">
        <a className="brand" href={HOME} aria-label="Laru, todos los workspaces"><Logo /><span>Laru</span></a>
        <span className="grow" />
        <span className="daemon" title="El servicio local escucha solo en 127.0.0.1"><Dot state="ok" /><span className="lbl">{location.host} · {plural(list.length, 'workspace', 'workspaces')}</span></span>
      </header>
      <main id="main" tabIndex={-1}>
        <div className="page">
          <div className="head">
            <div><h1>Workspaces</h1><p>Cada workspace es un aplicativo con sus proyectos. Este servicio los sirve todos, cada uno en su dirección.</p></div>
            <div className="actions"><button className="btn primary" onClick={() => setAdding(true)}><Plus />Añadir workspace</button></div>
          </div>
          {rows.error ? <div className="notice" role="alert">{rows.error}</div> : !rows.data || going ? <Skeleton lines={3} /> : !list.length ? (
            <section className="panel"><div className="empty">Todavía no hay workspaces. Crea uno o añade uno que ya tengas — o en la terminal: <code>laru init --app &lt;id&gt;</code></div></section>
          ) : (
            <div className="ws-cards" aria-label="Workspaces">
              {list.map((w) => !w.exists || !w.id ? (
                <div key={w.root} className="ws-card missing">
                  <div className="ws-card-h"><span className="ws-mark" aria-hidden="true">?</span><div><b>{w.root.split('/').pop()}</b><div className="faint mono">{tilde(w.root)}</div></div></div>
                  <Status state="err">No encontrado en esa carpeta</Status>
                  <button className="btn sm" onClick={() => api('/api/workspaces/remove', { method: 'POST', body: { root: w.root } }).then(rows.reload, (e: Error) => toast(e.message))}><Trash2 />Quitar de la lista</button>
                </div>
              ) : (
                <div key={w.root} className={`ws-card${w.envs?.length ? ' on' : ''}`}>
                  <div className="ws-card-h">
                    <span className="ws-mark" aria-hidden="true" style={{ ['--h' as string]: hue(w.id) }}>{(w.title ?? w.id).slice(0, 1).toUpperCase()}</span>
                    <div style={{ minWidth: 0 }}><a className="rowlink ws-title" href={wsPage(w.id)}>{w.title ?? w.id}</a><div className="faint mono ws-id">{w.id}</div></div>
                  </div>
                  {w.error ? <span className="faint">{w.error}</span> : <PathChip path={w.root} reveal={{ what: 'workspace' }} ws={w.id} />}
                  <dl className="ws-facts">
                    <div><dt>Proyectos</dt><dd className="num">{w.projects ?? '—'}</dd></div>
                    <div><dt>Entornos</dt><dd>{w.envs?.length ? <Status state="ok">{w.envs.join(', ')}</Status> : <span className="faint">parados</span>}</dd></div>
                    <div><dt>Último run</dt><dd>{w.lastRun ? <a className="rowlink" href={wsPage(w.id, `#/runs/${w.lastRun.id}`)}><Status state={RUN_DOT[w.lastRun.status] ?? 'idle'}>#{w.lastRun.id} · {ago(w.lastRun.startedAt)}</Status></a> : <span className="faint">ninguno</span>}</dd></div>
                    <div><dt>Disco</dt><dd className="num">{w.stateBytes !== undefined ? size(w.stateBytes) : '—'}</dd></div>
                  </dl>
                  <a className="btn sm ws-open" href={wsPage(w.id)}>Abrir<ArrowRight /></a>
                </div>
              ))}
            </div>
          )}
          <Machine rows={list} onChange={rows.reload} />
        </div>
      </main>
      {adding && <AddWorkspace onClose={() => setAdding(false)} />}
    </div>
  );
}

/** «Esta máquina»: Docker, maxEnvs, what runs now (with «Detener»), and what Laru keeps here. */
function Machine({ rows, onChange }: { rows: WorkspaceRow[]; onChange: () => void }) {
  const m = useApi<MachineInfo>('/api/machine');
  const [df, setDf] = useState<Array<{ Type: string; Size: string; Reclaimable: string }> | 'loading' | null>(null);
  const [stopping, setStopping] = useState<{ ws: string; env: string; label: string } | null>(null);
  const d = m.data;
  const setMax = (n: number) => api('/api/machine/config', { method: 'POST', body: { maxEnvs: n } }).then(() => { m.reload(); toast(`Ahora pueden correr ${plural(n, 'entorno', 'entornos')} a la vez`); }, (e: Error) => toast(e.message));
  const DF: Record<string, string> = { Images: 'Imágenes', Containers: 'Contenedores', 'Local Volumes': 'Volúmenes', 'Build Cache': 'Caché de construcción' };
  return (
    <section className="panel" aria-labelledby="machine-h" style={{ marginTop: 16 }}>
      <header><h3 id="machine-h">Esta máquina</h3></header>
      {m.error ? <div className="notice" role="alert" style={{ margin: 16 }}>{m.error}</div> : !d ? <div className="body"><div className="sk" style={{ height: 14, width: '60%' }} /></div> : <>
        <div className="machine-line">
          <span><Cpu size={14} aria-hidden="true" style={{ verticalAlign: -2, marginRight: 6 }} />{d.docker ? `Docker ${d.docker} · ${d.cpus} CPU · ${size(d.memBytes ?? 0).replace('GB', 'GiB')}` : 'Docker no está en marcha'}</span>
          <span className="grow" style={{ flex: 1 }} />
          <span className="lbl" id="max-l">Entornos a la vez</span>
          <MenuButton labelledBy="max-l" value={d.maxEnvs} options={[1, 2, 3]} onPick={setMax} />
        </div>
        {d.memBytes ? (() => {
          const used = d.running.reduce((n, r) => n + (r.memBytes ?? 0), 0);
          return (
            <div className="machine-line mem-line">
              <span className="lbl">Memoria</span>
              <div className="mem-bar" role="img" aria-label={`${size(used)} de ${size(d.memBytes)} en uso por Laru`}>
                {d.running.map((r) => <i key={`${r.key}/${r.env}`} style={{ width: `${((r.memBytes ?? 0) / d.memBytes!) * 100}%`, ['--h' as string]: hue(r.app) }} title={`${r.title ?? r.app} / ${r.env}: ${r.memBytes ? size(r.memBytes) : '—'}`} />)}
              </div>
              <span className="num faint">{size(used).replace('GB', 'GiB')} de {size(d.memBytes).replace('GB', 'GiB')} para Laru</span>
            </div>
          );
        })() : null}
        <div className="machine-line" style={{ display: 'block' }}>
          <div className="lbl" style={{ marginBottom: 6 }}>Corriendo ahora</div>
          {!d.running.length ? <span className="faint">Ningún entorno de Laru.</span> : (
            <div className="scroll-x">
              <table className="t machine-run">
                <tbody>
                  {d.running.map((r) => {
                    const row = rows.find((w) => w.key === r.key);
                    return (
                      <tr key={`${r.key}/${r.env}`}>
                        <td style={{ fontWeight: 500 }}>{row?.id ? <a className="rowlink" href={wsPage(row.id, `#/envs/${r.env}`)}>{r.title ?? r.app} / {r.env}</a> : <>{r.app} / {r.env} <span className="faint">sin registrar ({r.key.slice(0, 6)}…)</span></>}</td>
                        <td className="faint">{r.projects?.join(' · ') ?? ''}</td>
                        <td className="r num">{plural(r.services, 'servicio', 'servicios')}</td>
                        <td className="r num">{r.memBytes ? size(r.memBytes).replace('GB', 'GiB').replace('MB', 'MiB') : '—'}</td>
                        <td className="faint">desde {sinceText(r.since)}</td>
                        <td className="r">{r.ws && <button className="btn sm danger" onClick={() => setStopping({ ws: r.ws!, env: r.env, label: `${r.title ?? r.app}/${r.env}` })}><Square />Detener</button>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="machine-line">
          <span className="lbl">En disco</span>
          <PathChip path={d.home.path} reveal={{ what: 'home' }} /><span className="num">{size(d.home.bytes)}</span>
          <span className="faint">·</span>
          {df === null ? <button className="btn sm" onClick={() => { setDf('loading'); api<Array<{ Type: string; Size: string; Reclaimable: string }>>('/api/machine/docker').then(setDf, (e: Error) => { setDf(null); toast(e.message); }); }}>Calcular Docker</button>
            : df === 'loading' ? <span className="sk" style={{ height: 14, width: 220, display: 'inline-block' }} aria-label="Calculando lo que ocupa Docker" />
            : <span className="faint">Docker en total: {df.map((x) => `${DF[x.Type] ?? x.Type} ${x.Size}${x.Reclaimable && !x.Reclaimable.startsWith('0B') ? ` (${x.Reclaimable.replace(/ \(.*\)/, '')} recuperables)` : ''}`).join(' · ')}</span>}
        </div>
      </>}
      {stopping && <Destroy env={stopping.env} ws={stopping.ws} label={stopping.label} onClose={() => setStopping(null)} onStarted={() => { setTimeout(() => { m.reload(); onChange(); }, 1500); }} />}
    </section>
  );
}

const sinceText = (createdAt: string) => {
  // docker ps: «2026-10-23 08:28:46 -0500 -05»
  const m = /^(\S+) (\S+) ([+-]\d\d)(\d\d)/.exec(createdAt);
  const t = m ? Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`) : NaN;
  return Number.isNaN(t) ? createdAt : new Date(t).toDateString() === new Date().toDateString() ? new Date(t).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : ago(new Date(t).toISOString());
};

/** A small menu of choices that changes something (never a native select): Escape closes it and returns the focus. */
function MenuButton({ value, options, onPick, labelledBy }: { value: number; options: number[]; onPick: (n: number) => void; labelledBy: string }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null), list = useRef<HTMLUListElement>(null);
  useEffect(() => { if (open) list.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus(); }, [open]);
  const close = () => { setOpen(false); btn.current?.focus(); };
  return (
    <span className="menu-wrap" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}>
      <button ref={btn} className="btn sm" aria-haspopup="menu" aria-expanded={open} aria-labelledby={`${labelledBy} ${labelledBy}-v`} onClick={() => setOpen((o) => !o)}><span id={`${labelledBy}-v`} className="num">{value}</span><ChevronDown /></button>
      {open && (
        <ul className="menu" role="menu" ref={list} onKeyDown={(e) => {
          const items = [...(list.current?.querySelectorAll<HTMLElement>('button') ?? [])], i = items.indexOf(document.activeElement as HTMLElement);
          if (e.key === 'Escape') { e.preventDefault(); close(); }
          if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
          if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
        }}>
          {options.map((n) => <li key={n} role="none"><button role="menuitemradio" aria-checked={n === value} onClick={() => { close(); if (n !== value) onPick(n); }}>{n} {n === 1 ? 'entorno' : 'entornos'}</button></li>)}
        </ul>
      )}
    </span>
  );
}

/** «Añadir workspace»: open one that exists (a path, or one found in ~/laru or the folder from before the rename) or create one; then go to it. */
export function AddWorkspace({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<'open' | 'create'>('open');
  const [path, setPath] = useState(''), [probe, setProbe] = useState<WorkspaceProbe | null>(null);
  const [root, setRoot] = useState('~/laru/'), [app, setApp] = useState(''), [title, setTitle] = useState(''), [lang, setLang] = useState<'es' | 'en'>('es');
  const [errors, setErrors] = useState<Record<string, string>>({}), [busy, setBusy] = useState(false), [twin, setTwin] = useState<{ app: string; id: string; hash: string } | null>(null);
  const found = useApi<WorkspaceProbe[]>(mode === 'open' ? '/api/workspaces/found' : null);
  const ids = useId();
  useEffect(() => {
    if (mode !== 'open' || !path.trim()) { setProbe(null); return; }
    const t = setTimeout(() => api<WorkspaceProbe>(`/api/workspaces/probe?path=${encodeURIComponent(path.trim())}`).then(setProbe, () => setProbe(null)), 300);
    return () => clearTimeout(t);
  }, [mode, path]);
  const derived = root.replace(/\/+$/, '').split('/').pop()?.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') ?? '';
  const go = (r: { id: string; twin?: string }, hash: string) => { if (r.twin) setTwin({ app: r.twin, id: r.id, hash }); else location.href = wsPage(r.id, hash); };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErrors({});
    try {
      if (mode === 'open') go(await api<{ id: string; twin?: string }>('/api/workspaces/add', { method: 'POST', body: { root: path.trim() } }), '');
      else go(await api<{ id: string; twin?: string }>('/api/workspaces/init', { method: 'POST', body: { root: root.trim(), app: app || derived, title: title || undefined, docsLanguage: lang } }), '#/repos');
    } catch (err) { const { field, text } = workspaceError((err as Error).message); setErrors({ [field || 'form']: text }); setBusy(false); }
  };
  const err = (f: string) => errors[f] && <span className="form-err" role="alert" id={`${ids}-${f}-e`}>{errors[f]}</span>;
  if (twin) return (
    <Dialog title="Añadir workspace" onClose={onClose}>
      <div className="dlg-body"><p>{twinText(twin.app, twin.id)}</p></div>
      <footer><button className="btn primary" data-autofocus onClick={() => { location.href = wsPage(twin.id, twin.hash); }}>Ir al workspace</button></footer>
    </Dialog>
  );
  return (
    <Dialog title="Añadir workspace" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="dlg-body form">
          <Segmented label="Cómo" value={mode} onChange={(m) => { setMode(m); setErrors({}); }} options={[{ key: 'open', label: 'Abrir uno que ya existe' }, { key: 'create', label: 'Crear uno nuevo' }]} />
          {mode === 'open' ? <>
            <label className="fld"><span className="l">Carpeta</span>
              <input className="mono" data-autofocus required value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/laru/finanzas" autoComplete="off" spellCheck={false} aria-describedby={`${ids}-p ${ids}-root-e`} aria-invalid={Boolean(errors.root) || undefined} />
              <span className="h" id={`${ids}-p`} aria-live="polite">{probe && <>{probe.ok ? <Check size={12} aria-hidden="true" /> : null} {probeText(probe)}</>}</span>
              {err('root')}
            </label>
            {Boolean(found.data?.length) && <div className="fld"><span className="l">Encontrados en tu carpeta de workspaces</span>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>{found.data!.map((f) => <li key={f.root} style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 32 }}><span style={{ fontWeight: 500 }}>{f.app}</span><span className="mono faint" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{tilde(f.root ?? '')}</span><button type="button" className="btn sm" onClick={() => setPath(tilde(f.root ?? ''))}>Usar</button></li>)}</ul>
            </div>}
          </> : <>
            <label className="fld"><span className="l">Carpeta</span><input className="mono" data-autofocus required value={root} onChange={(e) => setRoot(e.target.value)} autoComplete="off" spellCheck={false} aria-invalid={Boolean(errors.root) || undefined} aria-describedby={`${ids}-root-e`} />{err('root')}</label>
            <div className="row2">
              <label className="fld"><span className="l">Id</span><input className="mono" value={app} placeholder={derived || 'mi-app'} onChange={(e) => setApp(e.target.value)} autoComplete="off" spellCheck={false} aria-describedby={`${ids}-id ${ids}-app-e`} aria-invalid={Boolean(errors.app) || undefined} /><span className="h" id={`${ids}-id`}>Minúsculas y guiones</span>{err('app')}</label>
              <label className="fld"><span className="l">Título</span><input value={title} placeholder="Mi aplicativo" onChange={(e) => setTitle(e.target.value)} autoComplete="off" /></label>
            </div>
            <div className="fld"><span className="l" id={`${ids}-lang`}>Idioma de la documentación</span><Segmented label="Idioma de la documentación" value={lang} onChange={setLang} options={[{ key: 'es', label: 'Español' }, { key: 'en', label: 'Inglés' }]} /></div>
            <p className="faint" style={{ margin: 0 }}><FolderPlus size={13} aria-hidden="true" style={{ verticalAlign: -2 }} /> Se crea con su propio git. Los proyectos se añaden después.</p>
          </>}
          {err('form')}
        </div>
        <footer>
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn primary" aria-disabled={busy || undefined} disabled={busy || (mode === 'open' && probe !== null && !probe.ok)}>{mode === 'open' ? 'Añadir' : 'Crear'}</button>
        </footer>
      </form>
    </Dialog>
  );
}

