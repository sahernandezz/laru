/**
 * «Archivos locales»: where this workspace keeps its code, envs and evidence on this machine, how much each weighs, and
 * what retention removes. Every path can be shown in Finder or copied; nothing leaves the machine.
 */
import { Eraser, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { api, useApi, type DiskReport, type PruneReport } from '../api.ts';
import { ActionButton, Dialog, PathChip, Segmented, Skeleton, Status, tilde, toast } from '../components/ui.tsx';
import { ago, plural, RUN_DOT, RUN_STATUS, size } from '../lib/es.ts';
import { href } from '../lib/route.ts';

const KIND: Record<string, string> = { commit: 'commit', folder: 'carpeta', worktree: 'copia de trabajo' };
const STORE: Record<string, string> = { keychain: 'llavero de macOS', 'secret-tool': 'secret-tool (Linux)', file: 'un fichero 0600 en tu carpeta personal' };
const day = (iso: string) => new Date(iso).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function Files() {
  const disk = useApi<DiskReport>('/api/disk');
  const [order, setOrder] = useState<'recent' | 'size'>('recent');
  const [all, setAll] = useState(false);
  const [vols, setVols] = useState<{ volumes: Array<{ name: string; bytes: number }>; imagesBytes: number } | 'loading' | null>(null);
  const [pruning, setPruning] = useState(false);
  const d = disk.data;

  const head = (
    <div className="head">
      <div><h1>Archivos locales</h1><p>Dónde guarda Laru el código, los entornos y la evidencia de este workspace, y cuánto ocupa cada cosa. Nada sale de esta máquina.</p></div>
      <div className="actions">
        <ActionButton icon={RefreshCw} run={async () => disk.reload()}>Actualizar</ActionButton>
        <button className="btn" onClick={() => setPruning(true)}><Eraser />Liberar espacio…</button>
      </div>
    </div>
  );
  if (disk.error) return <div className="page">{head}<div className="notice" role="alert">{disk.error}</div></div>;
  if (!d) return <div className="page">{head}<Skeleton lines={8} /></div>;

  const runs = [...d.runs.rows].sort((a, b) => (order === 'size' ? b.bytes - a.bytes : Number(b.id) - Number(a.id)));
  const shown = all ? runs : runs.slice(0, 15);
  const p = d.runs.policy, last = d.runs.lastPrune as { at: string; removed: { media: number; runs: number; bytes: number } } | undefined;
  const cache = vols && vols !== 'loading' ? vols.volumes.filter((v) => v.name.includes('-cache-')) : [];

  return (
    <div className="page">
      {head}

      <section className="panel block" aria-labelledby="f-ws">
        <header><h3 id="f-ws">Workspace</h3></header>
        <dl className="places">
          <Place label="Lo versionado" path={d.workspace.path} reveal={{ what: 'workspace' }} bytes={d.workspace.bytes} what="laru.yaml, docs/, envs/ y vault/: lo que se comparte con git." />
          <Place label="Lo derivado" path={d.state.path} reveal={{ what: 'state' }} bytes={d.state.bytes} what="El mapa, los entornos y los runs de esta máquina. Se puede borrar: se rehace." />
        </dl>
      </section>

      <section className="panel block" aria-labelledby="f-code">
        <header><h3 id="f-code">Código de los proyectos</h3></header>
        <dl className="places">
          {d.projects.map((x) => x.path && !x.problem
            ? <Place key={x.name} label={x.name} path={x.path} reveal={{ what: 'project', id: x.name }} bytes={x.bytes} what={`${x.source === 'folder' ? 'Carpeta: tu carpeta; Laru solo la lee' : x.managed ? 'git: clon de Laru' : 'git: tu clon'}.`} />
            : <div key={x.name}><dt>{x.name}</dt><dd><span>{x.problem === 'missing' ? `${x.path} ya no existe.` : 'No está en esta máquina: Sincronizar en Proyectos, o laru repo link.'}</span></dd><span /></div>)}
        </dl>
        <div className="files-sub">Instantáneas: el código con el que se construyó cada entorno</div>
        {!d.snapshots.length ? <div className="empty" style={{ paddingTop: 8 }}>Ninguna todavía: se crean al levantar un entorno.</div> : (
          <dl className="places">
            {d.snapshots.map((s) => <Place key={s.id} label={s.id} path={s.path} reveal={{ what: 'snapshot', id: s.id }} bytes={s.bytes} what={`${KIND[s.kind]}; ${s.usedBy.length ? `usada por ${s.usedBy.join(', ')}` : 'sin usar: se borra al liberar espacio, salvo las dos más nuevas'}.`} />)}
          </dl>
        )}
        <div className="retention" style={{ borderBottom: 0, borderTop: '1px solid var(--line-1)' }}>
          {d.images ? <>Imágenes de Docker: {d.images.count} etiquetas <span className="mono">ks-{d.vaultKey.account}/…</span>{d.images.old ? `, ${d.images.old} de versiones anteriores (se conservan las 3 más nuevas de cada servicio y las que use un contenedor)` : ''}.</> : 'Docker no responde: no se pueden contar las imágenes.'}
        </div>
      </section>

      <section className="panel block" aria-labelledby="f-runs">
        <header><h3 id="f-runs">Ejecuciones</h3><div className="meta">{plural(d.runs.count, 'run', 'runs')}</div></header>
        <dl className="places">
          <Place label="Runs" path={d.runs.path} reveal={{ what: 'runs' }} bytes={d.runs.bytes} what={`${size(d.runs.videoBytes)} de vídeo${d.runs.rawBytes ? `, ${size(d.runs.rawBytes)} repetidos en out/ (la salida en bruto del runner, que nunca se sirve): se borran al liberar espacio` : ''}.`} />
        </dl>
        <p className="retention">
          Retención: vídeos {p.videoDays} días · runs {p.runDays} días · máximo {p.maxGB} GB. Siempre se guardan el último run verde y el último fallido de cada flujo, y los que estos citan. Se aplica tras cada run.
          {last ? ` Última limpieza: ${ago(last.at)}, ${plural(last.removed.media, 'run aligerado', 'runs aligerados')} y ${plural(last.removed.runs, 'run borrado', 'runs borrados')} (${size(last.removed.bytes)}).` : ''}
          {' '}Se cambia en <span className="mono">~/.laru/config.yaml</span> (retention).
        </p>
        {runs.length > 0 && <>
          <div style={{ padding: '10px 16px 0' }}><Segmented label="Orden de los runs" value={order} onChange={setOrder} options={[{ key: 'recent', label: 'Más recientes' }, { key: 'size', label: 'Más grandes' }]} /></div>
          <div className="scroll-x">
            <table className="t files-runs">
              <thead><tr><th>Run</th><th>Fecha</th><th>Entorno</th><th>Estado</th><th className="r">Vídeo</th><th className="r">Total</th><th><span className="sr-only">Carpeta</span></th></tr></thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id}>
                    <td><a className="rowlink num" href={href('runs', r.id)}>#{r.id}</a></td>
                    <td>{day(r.startedAt)}</td>
                    <td className="mono">{r.env}</td>
                    <td><Status state={RUN_DOT[r.status] ?? 'idle'}>{RUN_STATUS[r.status] ?? r.status}</Status></td>
                    <td className="r num">{r.pruned ? <span className="faint">borrado por retención</span> : r.videoBytes ? size(r.videoBytes) : '—'}{r.rawBytes ? <div className="faint" style={{ fontSize: 11.5 }}>+{size(r.rawBytes)} en out/</div> : null}</td>
                    <td className="r num">{size(r.bytes)}</td>
                    <td className="r"><PathChip path={r.path} reveal={{ what: 'run', id: r.id }} hide /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {runs.length > shown.length && <div style={{ padding: '8px 16px 12px' }}><button className="btn sm" onClick={() => setAll(true)}>Mostrar los {runs.length - shown.length} restantes</button></div>}
        </>}
      </section>

      <section className="panel block" aria-labelledby="f-envs">
        <header>
          <h3 id="f-envs">Entornos</h3>
          <div className="meta">{vols === null ? <button className="btn sm" onClick={() => { setVols('loading'); api<{ volumes: Array<{ name: string; bytes: number }>; imagesBytes: number }>('/api/disk/docker').then(setVols, (e: Error) => { setVols(null); toast(e.message); }); }}>Calcular volúmenes</button> : vols === 'loading' ? <span aria-live="polite">Preguntando a Docker…</span> : <span>Imágenes: {size(vols.imagesBytes)} según Docker</span>}</div>
        </header>
        {!d.envs.length ? <div className="empty">Este workspace todavía no tiene entornos.</div> : (
          <dl className="places">
            {d.envs.map((e) => {
              const mine = vols && vols !== 'loading' ? vols.volumes.filter((v) => !v.name.includes('-cache-') && v.name.includes(`-${e.env}_`)) : [];
              return <Place key={e.env} label={e.env} path={e.path} reveal={{ what: 'env', id: e.env }} bytes={e.bytes} what={`${e.trafficBytes ? `traffic.jsonl ${size(e.trafficBytes)}; ` : ''}compose.yml, state.json, events.jsonl, tap/.${mine.length ? ` Volúmenes: ${mine.map((v) => `${v.name} ${size(v.bytes)}`).join(', ')}.` : ''}`} />;
            })}
          </dl>
        )}
        {vols === 'loading' && <div className="body"><div className="sk" style={{ height: 14, width: '50%' }} /></div>}
        {cache.length > 0 && <p className="retention" style={{ borderTop: '1px solid var(--line-1)', borderBottom: 0 }}>Caché compartida entre entornos (sobrevive a Destruir): {cache.map((v) => `${v.name} ${size(v.bytes)}`).join(', ')}.</p>}
      </section>

      <section className="panel block" aria-labelledby="f-personal">
        <header><h3 id="f-personal">Personal</h3></header>
        <dl className="places">
          <Place label="Tu carpeta" path={d.personal.path} reveal={{ what: 'personal' }} what={`${d.personal.files.join(', ') || 'vacía'}. No se versiona: clones, instantáneas, sombras de carpetas y tus valores.`} />
          <div><dt>Clave del vault</dt><dd><span>{STORE[d.vaultKey.store] ?? d.vaultKey.store}{d.vaultKey.store !== 'file' ? `, servicio ${d.vaultKey.service}, cuenta ${d.vaultKey.account}` : ''}. Para otra máquina: laru vault key export.</span></dd><span /></div>
          <Place label="Esta máquina" path={d.machine.path} reveal={{ what: 'home' }} what="config.yaml, workspaces.yaml, daemon.json (el token, 0600), locks/ y la CA local." />
        </dl>
      </section>

      {pruning && <Prune onClose={() => setPruning(false)} onDone={disk.reload} />}
    </div>
  );
}

function Place({ label, path, reveal, bytes, what }: { label: string; path: string; reveal: { what: string; id?: string }; bytes?: number; what: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd><span className="row"><code title={path}>{tilde(path)}</code>{bytes !== undefined && <span className="num">{size(bytes)}</span>}</span><span>{what}</span></dd>
      <span className="acts"><PathChip path={path} reveal={reveal} hide /></span>
    </div>
  );
}

/** «Liberar espacio…»: the dry run, section by section, then the same request for real. */
function Prune({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const plan = useApi<PruneReport>('/api/prune/plan');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const r = plan.data;
  const by = (w: string) => (r?.runs ?? []).filter((a) => a.what === w);
  const sum = (xs: Array<{ bytes: number }>) => xs.reduce((n, x) => n + x.bytes, 0);
  const nothing = r && !r.runs.length && !r.snapshots.length && !r.images.length;
  const go = async () => {
    setBusy(true);
    try { const done = await api<PruneReport>('/api/prune', { method: 'POST', body: { dryRun: false } }); toast(`Liberados unos ${size(done.bytes)}`); onDone(); onClose(); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <Dialog title="Liberar espacio" onClose={onClose}>
      <div className="dlg-body" aria-live="polite">
        {plan.error || error ? <p className="form-err" role="alert">{plan.error || error}</p> : !r ? <Skeleton lines={3} /> : nothing ? <p>No hay nada que liberar: todo está dentro de la retención.</p> : (
          <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6 }}>
            {by('raw').length > 0 && <li>Copias en bruto del runner (out/) de {plural(by('raw').length, 'run', 'runs')}: {size(sum(by('raw')))}. La evidencia no cambia.</li>}
            {by('media').length > 0 && <li>Vídeo y capturas de {plural(by('media').length, 'run', 'runs')} de más de los días de retención: {size(sum(by('media')))}. Se quedan la traza y los registros.</li>}
            {by('run').length > 0 && <li>{plural(by('run').length, 'run entero', 'runs enteros')} ({by('run').map((a) => `#${a.run}`).join(', ')}): {size(sum(by('run')))}. Su fila sigue en el historial.</li>}
            {r.snapshots.length > 0 && <li>{plural(r.snapshots.length, 'instantánea sin usar', 'instantáneas sin usar')}: {size(sum(r.snapshots))}.</li>}
            {r.images.length > 0 && <li>{plural(r.images.length, 'imagen anterior', 'imágenes anteriores')} de Docker (ninguna en uso): hasta {size(sum(r.images))}.</li>}
            {r.shadow.length > 0 && <li>Compactar {plural(r.shadow.length, 'sombra', 'sombras')} de carpetas (git gc).</li>}
          </ul>
        )}
        <p className="faint">Nunca se toca el código de los proyectos ni lo que no sea de Laru. Se conservan el último run verde y el último fallido de cada flujo.</p>
      </div>
      <footer>
        <button type="button" className="btn" data-autofocus onClick={onClose}>Cancelar</button>
        <button type="button" className="btn primary" disabled={!r || Boolean(nothing) || busy} onClick={go}><Eraser />Liberar{r && !nothing ? ` ${size(r.bytes)}` : ''}</button>
      </footer>
    </Dialog>
  );
}
