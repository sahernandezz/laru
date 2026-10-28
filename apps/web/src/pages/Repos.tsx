/**
 * Projects: git repos by URL and branch, or plain folders. Where each one stands, where it lives on this machine, and
 * the sheet extracted from what the map read (a repo's reference branch, a folder's content now).
 */
import { useEffect, useId, useState, type FormEvent } from 'react';
import { FileCode, Folder, FolderOpen, GitBranch, Plus, RefreshCw, ScanText, Server, TriangleAlert } from 'lucide-react';
import { api, useApi, type DiskReport, type EnvSummary, type Indexed, type RepoStatus } from '../api.ts';
import { ActionButton, CopyButton, Dialog, Origin, PathChip, Segmented, Skeleton, Status, toast } from '../components/ui.tsx';
import { STATE_DOT } from '../lib/es.ts';
import { href } from '../lib/route.ts';
import { ago, ENV_STATE, size } from '../lib/es.ts';

const ROLE: Record<string, string> = { service: 'Servicio', frontend: 'Front', library: 'Librería', infra: 'Infraestructura', docs: 'Documentación' };

/** A path as people read it: the home folder as ~. */
const tilde = (p: string | null | undefined, home?: string) => (p && home && p.startsWith(home + '/') ? `~${p.slice(home.length)}` : p ?? '');

export function Repos({ g, selected, reloadMap }: { g: Indexed | null; selected?: string; reloadMap: () => void }) {
  const repos = useApi<RepoStatus[]>('/api/repos');
  const envs = useApi<EnvSummary[]>('/api/envs'), disk = useApi<DiskReport>('/api/disk');
  const list = repos.data ?? [];
  const sel = list.find((r) => r.name === selected) ?? list[0];
  const [adding, setAdding] = useState(false);
  const home = list.map((r) => r.checkout?.match(/^(\/Users\/[^/]+|\/home\/[^/]+)/)?.[1]).find(Boolean);

  return (
    <div className="page wide">
      <div className="head">
        <div>
          <h1>Proyectos</h1>
          <p>Cada proyecto es un repositorio git o una carpeta. Laru solo los lee: dónde está cada uno en esta máquina es un dato local que no se versiona.</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => setAdding(true)}><Plus />Añadir proyecto</button>
          <ActionButton icon={RefreshCw} run={async () => { await api('/api/repos/sync', { method: 'POST' }); repos.reload(); }} done={() => 'Proyectos sincronizados'}>Sincronizar</ActionButton>
          <ActionButton icon={ScanText} primary run={() => api<{ ms: number }>('/api/map/refresh', { method: 'POST' }).then((r) => { reloadMap(); repos.reload(); return r; })} done={(r) => `Código releído en ${(r as { ms: number }).ms} ms`}>Releer el código</ActionButton>
        </div>
      </div>

      {repos.loading && !repos.data ? <Skeleton lines={5} /> : repos.error ? <div className="notice">{repos.error}</div> : !list.length ? (
        <section className="panel"><div className="empty">Este workspace no tiene proyectos. Añade un repositorio o una carpeta — <code>laru repo add &lt;url|carpeta&gt;</code></div></section>
      ) : (
        <section className="panel">
          <div className="scroll-x">
            <table className="t">
              <thead><tr><th>Proyecto</th><th>Origen</th><th>Dónde está</th><th>Referencia</th><th className="r">Cambios</th><th>Servicios</th></tr></thead>
              <tbody>
                {list.map((r) => {
                  const services = g ? g.out(`repo:${r.name}`).filter((f) => f.p === 'contains').map((f) => g.nodes.get(f.o)!).filter(Boolean) : [];
                  const folder = r.source === 'folder';
                  const own = (envs.data ?? []).filter((e) => !e.join?.length && e.projects?.length === 1 && e.projects[0] === r.name);
                  const warnings = [...(r.nested ?? []).map((d) => `subcarpeta con su propio git: ${d}/ — no se incluye`), ...(r.skipped ?? []).map((f) => `más de 50 MB: ${f} — no se incluye`)];
                  return (
                    <tr key={r.name} className={list.length > 1 && r === sel ? 'sel' : undefined}>
                      <td>
                        <a className="rowlink" href={href('repos', r.name)} style={{ display: 'inline-flex', gap: 8, alignItems: 'center', fontWeight: 500 }}>{folder ? <FolderOpen /> : <GitBranch />}{r.name}</a>{' '}
                        <span className="chip">{ROLE[r.role] ?? r.role}</span>
                        {r.title && r.title !== r.name && <div className="faint" style={{ fontSize: 12 }}>{r.title}</div>}
                        {warnings.map((w) => <div key={w} className="faint" style={{ fontSize: 11.5, display: 'flex', gap: 4, alignItems: 'center' }}><TriangleAlert size={12} aria-label="Aviso" />{w}</div>)}
                      </td>
                      <td className="wrap" style={{ overflowWrap: 'anywhere', minWidth: 160 }}>
                        <span className="chip">{folder ? 'carpeta' : `git · ${r.branch}`}</span>
                        <div className="faint mono" style={{ fontSize: 11.5 }}>{folder ? 'sin git' : r.url}</div>
                      </td>
                      <td className="mono wrap" style={{ minWidth: 200 }}>
                        {r.checkout ? <PathChip path={r.checkout} reveal={{ what: 'project', id: r.name }} /> : <span className="faint">{r.problem}</span>}
                        {r.checkout && <div className="faint" style={{ fontSize: 11.5, fontFamily: 'var(--sans)' }}>{folder ? 'tu carpeta' : r.managed ? 'clon de Laru' : 'tu clon'}</div>}
                      </td>
                      <td className="mono">
                        {folder ? <>{r.tree ? <>árbol <span className="faint">{r.tree.slice(0, 7)}</span></> : <span className="faint">sin leer</span>}<div className="faint" style={{ fontSize: 11.5, fontFamily: 'var(--sans)' }}>{r.readAt ? `leído ${ago(r.readAt)}` : 'pulsa «Releer el código»'}</div></>
                          : <>{r.refName ?? r.branch} <span className="faint">{r.ref?.slice(0, 7)}</span><div className={`${r.sinceVerified ? 'ahead' : 'faint'}`} style={{ fontSize: 11.5, fontFamily: 'var(--sans)' }}>{r.sinceVerified === null ? 'Sin verificar' : r.sinceVerified ? `+${r.sinceVerified} commits desde lo verificado` : 'Al día'}</div></>}
                      </td>
                      <td className={`r num ${(folder ? r.changed : r.dirty) ? '' : 'faint'}`}>
                        {folder ? (r.changed ? `${r.changed} fich.` : '—') : r.problem ? '' : <>{r.dirty ? `${r.dirty} sin commitear` : '—'}{r.localBranch !== r.branch && <div className="chip accent">{r.localBranch ?? 'detached'}</div>}{r.ahead || r.behind ? <div className="faint">{r.ahead}↑ {r.behind}↓</div> : null}</>}
                      </td>
                      <td className="wrap" style={{ minWidth: 280 }}>{services.length ? services.map((s) => <a key={s.id} className="chip" href={href('map', s.id)} style={{ marginRight: 4 }}>{s.name}</a>) : <span className="faint">{r.role === 'library' ? 'No se despliega' : 'Ninguno detectado'}</span>}
                        {own.length > 0 && <div className="faint" style={{ fontSize: 11.5, display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>Entorno propio: {own.map((e) => <a key={e.env} href={href('envs', e.env)} title={ENV_STATE[e.state]}><Status state={STATE_DOT[e.state]}>{e.env}</Status></a>)}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {sel && g && <RepoSheet g={g} repo={sel} snapshots={(disk.data?.snapshots ?? []).filter((s) => s.repo === sel.name)} />}
      {adding && <AddProject onClose={() => setAdding(false)} onDone={() => { repos.reload(); toast('Añadido. Pulsa «Releer el código»'); }} />}
    </div>
  );
}

interface Probe { exists: boolean; isGit: boolean; origin: string | null; files: number; overlap?: string; wide?: true }
const kebab = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');

/** «Añadir proyecto»: a git repo (cloned by Laru or one you have) or a folder, probed as you type its path. */
function AddProject({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState<'git' | 'folder'>('git');
  const [url, setUrl] = useState(''), [branch, setBranch] = useState(''), [name, setName] = useState(''), [title, setTitle] = useState(''), [role, setRole] = useState('service');
  const [clone, setClone] = useState<'laru' | 'mine'>('laru'), [path, setPath] = useState(''), [ignore, setIgnore] = useState('');
  const [probe, setProbe] = useState<Probe | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const ids = useId();
  const local = kind === 'folder' || clone === 'mine';
  useEffect(() => {
    if (!local || !path.trim()) { setProbe(null); return; }
    const t = setTimeout(() => api<Probe>(`/api/repos/probe?path=${encodeURIComponent(path.trim())}${kind === 'folder' && ignore.trim() ? `&ignore=${encodeURIComponent(ignore)}` : ''}`).then(setProbe, () => setProbe(null)), 300);
    return () => clearTimeout(t);
  }, [local, path, kind, ignore]);
  const probeText = !probe ? '' : !probe.exists ? 'No existe esa carpeta' : probe.wide ? 'Es demasiado amplia para ser un proyecto: elige la carpeta del proyecto' : probe.overlap ? `Se solapa con ${probe.overlap}` : probe.origin ? `Es un clon de ${probe.origin}: se añade como repositorio git` : `${probe.files >= 20000 ? '20.000+ ficheros: añade «Ignorar además» para lo generado' : `${probe.files.toLocaleString('es-ES')} ficheros`}${probe.isGit ? ', git sin remoto' : ', sin git'}`;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await api<{ name: string; cloning?: boolean }>('/api/repos/add', { method: 'POST', body: kind === 'folder'
        ? { source: path.trim(), name: name || undefined, title: title || undefined, role, ignore: ignore.split(',').map((x) => x.trim()).filter(Boolean) }
        : { source: url.trim(), branch: branch || undefined, name: name || undefined, role, ...(clone === 'mine' ? { link: path.trim() } : {}) } });
      if (r.cloning) toast(`Clonando ${r.name}…`);
      onDone(); onClose();
    } catch (err) { setError((err as Error).message); setBusy(false); }
  };
  const roles = Object.entries(ROLE).map(([key, label]) => ({ key, label }));
  return (
    <Dialog title="Añadir proyecto" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="dlg-body form">
          <Segmented label="Tipo de proyecto" value={kind} onChange={(k) => { setKind(k); setProbe(null); }} options={[{ key: 'git', label: 'Repositorio git' }, { key: 'folder', label: 'Carpeta' }]} />
          {kind === 'git' ? <>
            <label className="fld"><span className="l">URL</span><input className="mono" data-autofocus required value={url} onChange={(e) => { setUrl(e.target.value); if (!name) setName(''); }} placeholder="git@github.com:org/payments.git" autoComplete="off" spellCheck={false} /></label>
            <label className="fld"><span className="l">Rama</span><input className="mono" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" autoComplete="off" spellCheck={false} aria-describedby={`${ids}-b`} /><span className="h" id={`${ids}-b`}>Vacío: la rama por defecto del remoto</span></label>
            <div className="fld">
              <span className="l" aria-hidden="true">Clon</span>
              <Segmented label="Clon" value={clone} onChange={setClone} options={[{ key: 'laru', label: 'Que Laru lo clone' }, { key: 'mine', label: 'Ya lo tengo' }]} />
            </div>
          </> : null}
          {local && (
            <label className="fld">
              <span className="l">{kind === 'folder' ? 'Carpeta' : 'Ya lo tengo en'}</span>
              <input className="mono" data-autofocus={kind === 'folder' || undefined} required value={path} onChange={(e) => { setPath(e.target.value); if (kind === 'folder' && !name) setName(''); }} placeholder="~/code/vaultflow-audit" autoComplete="off" spellCheck={false} aria-describedby={`${ids}-p`} />
              <span className="h" id={`${ids}-p`} aria-live="polite">{probeText}</span>
            </label>
          )}
          <label className="fld"><span className="l">Nombre</span><input className="mono" value={name} onChange={(e) => setName(kebab(e.target.value))} placeholder={kind === 'folder' ? kebab(path.split('/').pop() ?? '') || 'audit' : kebab((url.split(/[/:]/).pop() ?? '').replace(/\.git$/, '')) || 'payments'} autoComplete="off" spellCheck={false} /></label>
          {kind === 'folder' && <label className="fld"><span className="l">Título</span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Auditoría" autoComplete="off" /></label>}
          <div className="fld"><span className="l" aria-hidden="true">Papel</span><Segmented label="Papel" value={role} onChange={setRole} options={roles} /></div>
          {kind === 'folder' && <>
            <p className="h">Se ignoran node_modules/, target/, .env… y lo que diga su .gitignore.</p>
            <label className="fld"><span className="l">Ignorar además</span><input className="mono" value={ignore} onChange={(e) => setIgnore(e.target.value)} placeholder="data/, *.zip" autoComplete="off" spellCheck={false} /></label>
          </>}
          {error && <p className="form-err" role="alert">{error}</p>}
        </div>
        <footer>
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn primary" disabled={busy || Boolean(local && probe && (!probe.exists || probe.wide || probe.overlap))}>Añadir</button>
        </footer>
      </form>
    </Dialog>
  );
}

function RepoSheet({ g, repo, snapshots }: { g: Indexed; repo: RepoStatus; snapshots: DiskReport['snapshots'] }) {
  const tree = useApi<{ dirs: string[]; commit: string }>(`/api/repo-tree?repo=${encodeURIComponent(repo.name)}`);
  const node = g.nodes.get(`repo:${repo.name}`);
  if (!node) return <section className="panel repo-sheet"><div className="empty">Aún no se ha leído el código de {repo.name}. Pulsa «Releer el código».</div></section>;
  const services = g.out(node.id).filter((f) => f.p === 'contains').map((f) => g.nodes.get(f.o)!);
  const sum = (p: string) => services.reduce((n, s) => n + g.out(s.id).filter((f) => f.p === p).length, 0);
  const tests = services.reduce((n, s) => n + Object.values((s.attrs?.tests ?? {}) as Record<string, number>).reduce((a, b) => a + b, 0), 0);
  const roots = new Map(services.map((s) => [String(s.attrs?.dir), s]));
  const facts: Array<[number, string]> = [[services.length, 'Servicios'], [sum('exposes'), 'Endpoints'], [new Set(services.flatMap((s) => g.out(s.id).filter((f) => f.p === 'maps-table').map((f) => f.o))).size, 'Tablas'], [new Set(services.flatMap((s) => g.out(s.id).filter((f) => f.p === 'publishes' || f.p === 'consumes').map((f) => f.o))).size, 'Temas'], [new Set(services.flatMap((s) => g.out(s.id).filter((f) => f.p === 'reads-var').map((f) => f.o))).size, 'Variables leídas'], [tests, 'Pruebas']];
  const anchor = `repo:${repo.name}@${String(node.attrs?.commit).slice(0, 7)}`;

  return (
    <section className="panel repo-sheet">
      <header>{repo.source === 'folder' ? <FolderOpen /> : <GitBranch />}<h3>{repo.name}</h3><span className="faint mono">{anchor}</span><CopyButton value={anchor} label="Copiar el ancla" /><div className="meta"><Origin of="extracted" /><span className="mono">{repo.checkout}</span></div></header>
      {snapshots.length > 0 && <div className="faint" style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', alignItems: 'center', padding: '6px 16px', fontSize: 12 }}>Instantáneas (lo que se construyó): {snapshots.map((s) => <span key={s.id} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><span className="mono">{s.id}</span> · {size(s.bytes)}<PathChip path={s.path} reveal={{ what: 'snapshot', id: s.id }} hide /></span>)}</div>}
      <div className="facts">{facts.map(([n, l]) => <div key={l}><b className="num">{n}</b><span>{l}</span></div>)}</div>
      <div className="grid cols-2" style={{ gap: 0 }}>
        <div style={{ borderRight: '1px solid var(--line-1)' }}>
          {tree.loading ? <div className="body"><div className="sk" style={{ height: 120 }} /></div> : (
            <ul className="dirs" aria-label="Estructura del proyecto">
              {(tree.data?.dirs ?? []).map((d) => {
                const depth = d.split('/').length - 1;
                const svc = roots.get(d);
                return <li key={d} style={{ paddingLeft: depth * 16 }}><Folder size={13} />{d.split('/').pop()}/{svc && <a className="chip accent svc" href={href('map', svc.id)}><Server size={12} />{svc.name}</a>}</li>;
              })}
            </ul>
          )}
        </div>
        <div>
          <table className="t">
            <thead><tr><th>Servicio</th><th>Tecnología</th><th className="r">Endpoints</th><th className="r">Pruebas</th></tr></thead>
            <tbody>{services.map((s) => (
              <tr key={s.id}>
                <td><a className="rowlink" href={href('map', s.id)} style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}><Server />{s.name}</a></td>
                <td>{s.kind}</td>
                <td className="r num">{g.out(s.id).filter((f) => f.p === 'exposes').length}</td>
                <td className="r num">{Object.values((s.attrs?.tests ?? {}) as Record<string, number>).reduce((a, b) => a + b, 0) || <span className="faint">0</span>}</td>
              </tr>
            ))}</tbody>
          </table>
          {!services.length && <div className="empty"><FileCode size={14} />Ningún servicio detectado: si este proyecto despliega algo, decláralo en <code>services:</code> de laru.yaml.</div>}
        </div>
      </div>
    </section>
  );
}
