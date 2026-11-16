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
import { tr, LOCALE } from '../lib/i18n.ts';

const KIND: Record<string, string> = { commit: 'commit', folder: tr('carpeta'), worktree: tr('copia de trabajo') };
const STORE: Record<string, string> = { keychain: tr('llavero de macOS'), 'secret-tool': tr('secret-tool (Linux)'), file: tr('un fichero 0600 en tu carpeta personal') };
const day = (iso: string) => new Date(iso).toLocaleString(LOCALE, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function Files() {
  const disk = useApi<DiskReport>('/api/disk');
  const [order, setOrder] = useState<'recent' | 'size'>('recent');
  const [all, setAll] = useState(false);
  const [vols, setVols] = useState<{ volumes: Array<{ name: string; bytes: number }>; imagesBytes: number } | 'loading' | null>(null);
  const [pruning, setPruning] = useState(false);
  const d = disk.data;

  const head = (
    <div className="head">
      <div><h1>{tr('Archivos locales')}</h1><p>{tr('Dónde guarda Laru el código, los entornos y la evidencia de este workspace, y cuánto ocupa cada cosa. Nada sale de esta máquina.')}</p></div>
      <div className="actions">
        <ActionButton icon={RefreshCw} run={async () => disk.reload()}>{tr('Actualizar')}</ActionButton>
        <button className="btn" onClick={() => setPruning(true)}><Eraser />{tr('Liberar espacio…')}</button>
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
        <header><h3 id="f-ws">{tr('Workspace')}</h3></header>
        <dl className="places">
          <Place label={tr('Lo versionado')} path={d.workspace.path} reveal={{ what: 'workspace' }} bytes={d.workspace.bytes} what={tr('laru.yaml, docs/, envs/ y vault/: lo que se comparte con git.')} />
          <Place label={tr('Lo derivado')} path={d.state.path} reveal={{ what: 'state' }} bytes={d.state.bytes} what={tr('El mapa, los entornos y los runs de esta máquina. Se puede borrar: se rehace.')} />
        </dl>
      </section>

      <section className="panel block" aria-labelledby="f-code">
        <header><h3 id="f-code">{tr('Código de los proyectos')}</h3></header>
        <dl className="places">
          {d.projects.map((x) => x.path && !x.problem
            ? <Place key={x.name} label={x.name} path={x.path} reveal={{ what: 'project', id: x.name }} bytes={x.bytes} what={`${x.source === 'folder' ? tr('Carpeta: tu carpeta; Laru solo la lee') : x.managed ? tr('git: clon de Laru') : tr('git: tu clon')}.`} />
            : <div key={x.name}><dt>{x.name}</dt><dd><span>{x.problem === 'missing' ? tr('{path} ya no existe.', { path: x.path }) : tr('No está en esta máquina: Sincronizar en Proyectos, o laru repo link.')}</span></dd><span /></div>)}
        </dl>
        <div className="files-sub">{tr('Instantáneas: el código con el que se construyó cada entorno')}</div>
        {!d.snapshots.length ? <div className="empty" style={{ paddingTop: 8 }}>{tr('Ninguna todavía: se crean al levantar un entorno.')}</div> : (
          <dl className="places">
            {d.snapshots.map((s) => <Place key={s.id} label={s.id} path={s.path} reveal={{ what: 'snapshot', id: s.id }} bytes={s.bytes} what={`${KIND[s.kind]}; ${s.usedBy.length ? tr('usada por {join}', { join: s.usedBy.join(', ') }) : tr('sin usar: se borra al liberar espacio, salvo las dos más nuevas')}.`} />)}
          </dl>
        )}
        <div className="retention" style={{ borderBottom: 0, borderTop: '1px solid var(--line-1)' }}>
          {d.images ? <>{tr('Imágenes de Docker:')}{' '}{d.images.count}{' '}{tr('etiquetas')}{' '}<span className="mono">{tr('ks-')}{d.vaultKey.account}/…</span>{d.images.old ? tr(', {old} de Laru que ningún contenedor usa (se conserva la más nueva de cada servicio y las que use un contenedor)', { old: d.images.old }) : ''}.</> : tr('Docker no responde: no se pueden contar las imágenes.')}
        </div>
        <p className="retention">{tr('Limpieza de Docker: tras cada levantamiento, tras cada run, al arrancar el servicio y cada 6 horas. Se borran las imágenes de Laru que ningún contenedor usa (queda la más nueva de cada servicio), las imágenes y volúmenes de apps sin espacio de trabajo en esta máquina y los contenedores que el compose ya no declara; el')}{' '}<span className="mono">compose.yml</span>{' '}{tr('de cada entorno se queda.')}{' '}{tr('Caché de compilación de Laru (su propio builder, «laru»; la de Docker, que comparten tus otros proyectos, nunca se toca):')}{' '}{d.docker.buildCacheBytes === null ? tr('Docker no responde') : size(d.docker.buildCacheBytes)}{d.docker.buildCacheGB ? tr(', tope {buildCacheGB} GB: por encima se borra primero lo menos usado y, si no baja del tope, toda la que ninguna compilación usa (solo se pierde tiempo de la siguiente compilación)', { buildCacheGB: d.docker.buildCacheGB }) : tr(', Laru no la toca (buildCacheGB: 0)')}.
          {d.docker.lastCleanup ? tr(' Última limpieza: {ago}, {plural} y {plural2}{p3}.', { ago: ago(d.docker.lastCleanup.at), plural: plural(d.docker.lastCleanup.images, tr('imagen'), tr('imágenes')), plural2: plural(d.docker.lastCleanup.volumes, tr('volumen'), tr('volúmenes')), p3: d.docker.lastCleanup.buildCache?.error ? tr('; la caché no se pudo recortar: {error}', { error: d.docker.lastCleanup.buildCache.error }) : d.docker.lastCleanup.buildCache?.before !== undefined && d.docker.lastCleanup.buildCache.after !== undefined ? tr('; caché de compilación de {size} a {size2}', { size: size(d.docker.lastCleanup.buildCache.before), size2: size(d.docker.lastCleanup.buildCache.after) }) : '' }) : ''}
          {' '}{tr('El tope se cambia en')}{' '}<span className="mono">~/.laru/config.yaml</span>{' '}{tr('(buildCacheGB).')}</p>
      </section>

      <section className="panel block" aria-labelledby="f-runs">
        <header><h3 id="f-runs">{tr('Ejecuciones')}</h3><div className="meta">{plural(d.runs.count, 'run', 'runs')}</div></header>
        <dl className="places">
          <Place label="Runs" path={d.runs.path} reveal={{ what: 'runs' }} bytes={d.runs.bytes} what={tr('{size} de vídeo{p1}.', { size: size(d.runs.videoBytes), p1: d.runs.rawBytes ? tr(', {size} repetidos en out/ (la salida en bruto del runner, que nunca se sirve): se borran al liberar espacio', { size: size(d.runs.rawBytes) }) : '' })} />
        </dl>
        <p className="retention">{tr('Retención: de cada flujo se guardan sus últimos')}{' '}{p.keepRuns}{' '}{tr('runs y, siempre, su último run verde, que no se borra nunca (ni su vídeo); los anteriores se borran. Vídeos de los demás')}{' '}{p.videoDays}{' '}{tr('días · máximo')}{' '}{p.maxGB}{' '}{tr('GB. Se aplica tras cada run.')}{last ? tr(' Última limpieza: {ago}, {plural} y {plural2} ({size}).', { ago: ago(last.at), plural: plural(last.removed.media, tr('run aligerado'), tr('runs aligerados')), plural2: plural(last.removed.runs, tr('run borrado'), tr('runs borrados')), size: size(last.removed.bytes) }) : ''}
          {' '}{tr('Se cambia en')}{' '}<span className="mono">~/.laru/config.yaml</span>{' '}{tr('(retention).')}</p>
        {runs.length > 0 && <>
          <div style={{ padding: '10px 16px 0' }}><Segmented label={tr('Orden de los runs')} value={order} onChange={setOrder} options={[{ key: 'recent', label: tr('Más recientes') }, { key: 'size', label: tr('Más grandes') }]} /></div>
          <div className="scroll-x">
            <table className="t files-runs">
              <thead><tr><th>Run</th><th>{tr('Fecha')}</th><th>{tr('Entorno')}</th><th>{tr('Estado')}</th><th className="r">{tr('Vídeo')}</th><th className="r">{tr('Total')}</th><th><span className="sr-only">{tr('Carpeta')}</span></th></tr></thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id}>
                    <td><a className="rowlink num" href={href('runs', r.id)}>#{r.id}</a></td>
                    <td>{day(r.startedAt)}</td>
                    <td className="mono">{r.env}</td>
                    <td><Status state={RUN_DOT[r.status] ?? 'idle'}>{RUN_STATUS[r.status] ?? r.status}</Status></td>
                    <td className="r num">{r.pruned ? <span className="faint">{tr('borrado por retención')}</span> : r.videoBytes ? size(r.videoBytes) : '—'}{r.rawBytes ? <div className="faint" style={{ fontSize: 11.5 }}>+{size(r.rawBytes)}{' '}{tr('en out/')}</div> : null}</td>
                    <td className="r num">{size(r.bytes)}</td>
                    <td className="r"><PathChip path={r.path} reveal={{ what: 'run', id: r.id }} hide /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {runs.length > shown.length && <div style={{ padding: '8px 16px 12px' }}><button className="btn sm" onClick={() => setAll(true)}>{tr('Mostrar los')}{' '}{runs.length - shown.length}{' '}{tr('restantes')}</button></div>}
        </>}
      </section>

      <section className="panel block" aria-labelledby="f-envs">
        <header>
          <h3 id="f-envs">{tr('Entornos')}</h3>
          <div className="meta">{vols === null ? <button className="btn sm" onClick={() => { setVols('loading'); api<{ volumes: Array<{ name: string; bytes: number }>; imagesBytes: number }>('/api/disk/docker').then(setVols, (e: Error) => { setVols(null); toast(e.message); }); }}>{tr('Calcular volúmenes')}</button> : vols === 'loading' ? <span aria-live="polite">{tr('Preguntando a Docker…')}</span> : <span>{tr('Imágenes:')}{' '}{size(vols.imagesBytes)}{' '}{tr('según Docker')}</span>}</div>
        </header>
        {!d.envs.length ? <div className="empty">{tr('Este workspace todavía no tiene entornos.')}</div> : (
          <dl className="places">
            {d.envs.map((e) => {
              const mine = vols && vols !== 'loading' ? vols.volumes.filter((v) => !v.name.includes('-cache-') && v.name.includes(`-${e.env}_`)) : [];
              return <Place key={e.env} label={e.env} path={e.path} reveal={{ what: 'env', id: e.env }} bytes={e.bytes} what={tr('{p0}compose.yml, state.json, events.jsonl, tap/.{p1}', { p0: e.trafficBytes ? `traffic.jsonl ${size(e.trafficBytes)}; ` : '', p1: mine.length ? tr(' Volúmenes: {join}.', { join: mine.map((v) => `${v.name} ${size(v.bytes)}`).join(', ') }) : '' })} />;
            })}
          </dl>
        )}
        {vols === 'loading' && <div className="body"><div className="sk" style={{ height: 14, width: '50%' }} /></div>}
        {cache.length > 0 && <p className="retention" style={{ borderTop: '1px solid var(--line-1)', borderBottom: 0 }}>{tr('Caché compartida entre entornos (sobrevive a Destruir):')}{' '}{cache.map((v) => `${v.name} ${size(v.bytes)}`).join(', ')}.</p>}
      </section>

      <section className="panel block" aria-labelledby="f-personal">
        <header><h3 id="f-personal">Personal</h3></header>
        <dl className="places">
          <Place label={tr('Tu carpeta')} path={d.personal.path} reveal={{ what: 'personal' }} what={tr('{p0}. No se versiona: clones, instantáneas, sombras de carpetas y tus valores.', { p0: d.personal.files.join(', ') || tr('vacía') })} />
          <div><dt>{tr('Clave del vault')}</dt><dd><span>{STORE[d.vaultKey.store] ?? d.vaultKey.store}{d.vaultKey.store !== 'file' ? tr(', servicio {service}, cuenta {account}', { service: d.vaultKey.service, account: d.vaultKey.account }) : ''}{tr('. Para otra máquina: laru vault key export.')}</span></dd><span /></div>
          <Place label={tr('Esta máquina')} path={d.machine.path} reveal={{ what: 'home' }} what={tr('config.yaml, workspaces.yaml, daemon.json (el token, 0600), locks/ y la CA local.')} />
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
  const nothing = r && !r.runs.length && !r.snapshots.length && !r.images.length && !r.volumes?.length;
  const go = async () => {
    setBusy(true);
    try { const done = await api<PruneReport>('/api/prune', { method: 'POST', body: { dryRun: false } }); toast(tr('Liberados unos {size}', { size: size(done.bytes) })); onDone(); onClose(); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <Dialog title={tr('Liberar espacio')} onClose={onClose}>
      <div className="dlg-body" aria-live="polite">
        {plan.error || error ? <p className="form-err" role="alert">{plan.error || error}</p> : !r ? <Skeleton lines={3} /> : nothing ? <p>{tr('No hay nada que liberar: todo está dentro de la retención.')}</p> : (
          <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6 }}>
            {by('raw').length > 0 && <li>{tr('Copias en bruto del runner (out/) de')}{' '}{plural(by('raw').length, 'run', 'runs')}: {size(sum(by('raw')))}{tr('. La evidencia no cambia.')}</li>}
            {by('media').length > 0 && <li>{tr('Vídeo y capturas de')}{' '}{plural(by('media').length, 'run', 'runs')}{' '}{tr('de más de los días de retención:')}{' '}{size(sum(by('media')))}{tr('. Se quedan la traza y los registros.')}</li>}
            {by('run').length > 0 && <li>{plural(by('run').length, tr('run entero'), tr('runs enteros'))} ({by('run').map((a) => `#${a.run}`).join(', ')}): {size(sum(by('run')))}{tr('. Su fila sigue en el historial.')}</li>}
            {r.snapshots.length > 0 && <li>{plural(r.snapshots.length, tr('instantánea sin usar'), tr('instantáneas sin usar'))}: {size(sum(r.snapshots))}.</li>}
            {r.volumes?.length > 0 && <li>{plural(r.volumes.length, tr('volumen'), tr('volúmenes'))}{' '}{tr('de Docker de apps sin espacio de trabajo en esta máquina (ninguno en uso).')}</li>}
            {r.images.length > 0 && <li>{plural(r.images.length, tr('imagen anterior'), tr('imágenes anteriores'))}{' '}{tr('de Docker (ninguna en uso): hasta')}{' '}{size(sum(r.images))}.</li>}
            {r.shadow.length > 0 && <li>{tr('Compactar')}{' '}{plural(r.shadow.length, tr('sombra'), tr('sombras'))}{' '}{tr('de carpetas (git gc).')}</li>}
          </ul>
        )}
        <p className="faint">{tr('Nunca se toca el código de los proyectos ni lo que no sea de Laru. Se conservan el último run verde y el último fallido de cada flujo.')}</p>
      </div>
      <footer>
        <button type="button" className="btn" data-autofocus onClick={onClose}>{tr('Cancelar')}</button>
        <button type="button" className="btn primary" disabled={!r || Boolean(nothing) || busy} onClick={go}><Eraser />{tr('Liberar')}{r && !nothing ? ` ${size(r.bytes)}` : ''}</button>
      </footer>
    </Dialog>
  );
}
