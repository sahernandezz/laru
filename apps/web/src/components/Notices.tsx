/**
 * What happened while the page was open, told without being asked: each notice comes up by itself at the top right, as
 * loud as it matters — what needs doing (Docker stopped answering, a run failed) stays until it is resolved or closed;
 * good news (a run passed, Docker came back) goes after a few seconds; a refresh from outside is a short line. A pointer
 * on a card keeps it. Docker coming back takes its own alert away. Docker's segment in the header opens the session's
 * history, with Docker's state on top, for whoever wants to look back; it counts only the failures not yet seen.
 */
import { CheckCheck, Container, Eraser, PlayCircle, RefreshCw, Trash2, X, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ago, plural, size } from '../lib/es.ts';
import { clearNotices, dismiss, markSeen, notices, notify, STAY, subscribe, type Live, type NoticeKind } from '../lib/notices.ts';
import { Dot, type DotState } from './ui.tsx';

export { notify } from '../lib/notices.ts';

export interface DockerSeen { ok: boolean | null; version?: string; error?: string; since: number }

const KIND: Record<NoticeKind, { icon: LucideIcon; label: string }> = {
  docker: { icon: Container, label: 'Docker' },
  change: { icon: RefreshCw, label: 'Cambios' },
  run: { icon: PlayCircle, label: 'Runs' },
  cleanup: { icon: Eraser, label: 'Limpieza' },
};

/** What the service's pulse says about its cleanups: Docker's (the machine's) and the runs' retention (a workspace's). */
export interface Cleanups {
  docker?: { at: string; images: number; imagesBytes?: number; volumes: number; buildCache?: { gb: number; trimmed: boolean; before?: number; after?: number; error?: string } };
  runs?: { at: string; removed: { media: number; runs: number; bytes: number } };
}
/**
 * A cleanup that happened between two pulses becomes a notice: what went and how much, or why the build cache could
 * not be trimmed (that one stays until closed). One that found nothing to remove says nothing.
 */
export function noticeCleanups(was: Cleanups | undefined, now: Cleanups | undefined, to?: string) {
  const d = now?.docker;
  if (d && was && d.at !== was.docker?.at) {
    const c = d.buildCache, cache = c?.before !== undefined && c.after !== undefined && c.after < c.before ? `caché de compilación de ${size(c.before)} a ${size(c.after)}` : '';
    const parts = [d.images ? `${plural(d.images, 'imagen', 'imágenes')}${d.imagesBytes ? ` (hasta ${size(d.imagesBytes)})` : ''}` : '', d.volumes ? plural(d.volumes, 'volumen', 'volúmenes') : '', cache].filter(Boolean);
    if (c?.error) notify({ kind: 'cleanup', title: 'No se pudo recortar la caché de Docker', detail: c.error, state: 'err', to });
    else if (parts.length) notify({ kind: 'cleanup', title: 'Laru limpió Docker', detail: `Borró ${parts.join(', ')}`, state: 'ok', to });
  }
  const r = now?.runs;
  if (r && was && r.at !== was.runs?.at && (r.removed.media || r.removed.runs)) {
    const parts = [r.removed.runs ? plural(r.removed.runs, 'run borrado', 'runs borrados') : '', r.removed.media ? plural(r.removed.media, 'run aligerado', 'runs aligerados') : ''].filter(Boolean);
    notify({ kind: 'cleanup', title: 'Laru limpió los runs', detail: `${parts.join(' y ')}: ${size(r.removed.bytes)} libres`, state: 'ok', to });
  }
}

const useNotices = () => useSyncExternalStore(subscribe, notices);
const when = (t: number) => ago(new Date(t).toISOString());

/** The cards that come up by themselves, newest on top, three at most. */
export function LiveNotices() {
  const { live: cards } = useNotices();
  if (!cards.length) return null;
  return (
    <section className="nt-live" aria-label="Avisos" aria-live="polite">
      {cards.slice(0, 3).map((x) => <Card key={x.id} n={x} />)}
      {cards.length > 3 && <div className="nt-more">y {cards.length - 3} más en la campana</div>}
    </section>
  );
}
function Card({ n }: { n: Live }) {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (held || n.level === 'alert') return;
    const t = setTimeout(() => dismiss(n.id), STAY[n.level]);
    return () => clearTimeout(t);
  }, [held, n.id, n.level]);
  const K = KIND[n.kind];
  const files = n.files?.map((f) => f.split('/').pop()).join(', ');
  const body = (
    <>
      <span className={`nt-tile ${n.kind} ${n.state}`} aria-hidden="true"><K.icon /></span>
      <span className="nt-body">
        <b>{n.title}{n.level === 'quiet' && files ? <span className="nt-quiet-files">{files}</span> : null}</b>
        {n.level !== 'quiet' && n.detail && <span className="nt-sub">{n.detail}</span>}
        {n.level !== 'quiet' && n.files && n.files.length > 0 && <span className="nt-files">{n.files.slice(0, 3).map((f) => <code key={f} title={f}>{f.split('/').pop()}</code>)}</span>}
      </span>
    </>
  );
  return (
    <div className={`nt-card ${n.level} ${n.state}`} role={n.level === 'alert' ? 'alert' : 'status'} onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)} onFocus={() => setHeld(true)} onBlur={() => setHeld(false)}>
      {n.to ? <a className="nt-card-main" href={n.to} onClick={() => dismiss(n.id)}>{body}</a> : <div className="nt-card-main">{body}</div>}
      <button className="icon-btn nt-close" aria-label="Cerrar el aviso" title="Cerrar" onClick={() => dismiss(n.id)}><X /></button>
    </div>
  );
}

/** Docker in the header: its state at a glance, and the session's notices behind it (with a count of failures not seen). */
export function Notices({ docker }: { docker?: DockerSeen }) {
  const { list: items, seenAt: seen } = useNotices();
  const [open, setOpen] = useState(false);
  // what was new when the panel opened stays marked while it is open; closing it marks everything seen
  const [newSince, setNewSince] = useState(seen);
  const btn = useRef<HTMLButtonElement>(null), wrap = useRef<HTMLSpanElement>(null);
  // only failures not seen are counted: the rest came up by themselves and went
  const unseen = items.filter((x) => x.at > seen && x.state === 'err').length;
  const close = (refocus = false) => { setOpen(false); markSeen(); if (refocus) btn.current?.focus(); };
  // opening clears the count; what was new stays marked in the panel until it closes
  const toggle = () => { if (open) close(); else { setNewSince(seen); setOpen(true); markSeen(); } };
  // a press anywhere outside closes it: a click on the page moves no focus, so a blur alone never came
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) close(); };
    addEventListener('pointerdown', away, true);
    return () => removeEventListener('pointerdown', away, true);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const dState: DotState = !docker || docker.ok === null ? 'idle' : docker.ok ? 'ok' : 'err';
  const dWord = !docker || docker.ok === null ? 'Preguntando a Docker…' : docker.ok ? 'Docker responde' : 'Docker no responde';
  const dSub = !docker || docker.ok === null ? 'Laru le pregunta cada 5 segundos mientras hay una página abierta.'
    : docker.ok ? `${docker.version ? `Versión ${docker.version} · ` : ''}desde ${when(docker.since)}` : `Desde ${when(docker.since)}. Los entornos se muestran sin estado hasta que vuelva.`;

  return (
    <span className="switch-wrap notices" ref={wrap} onBlur={(e) => { if (open && e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) close(); }}>
      <span className="status-pill">
        <button ref={btn} className={`st-seg docker-seg ${dState}`} onClick={toggle} aria-haspopup="dialog" aria-expanded={open}
          aria-label={`${dWord}. Avisos${unseen ? `: ${unseen} fallos sin ver` : ''}`} title={`${dWord}${docker?.ok === false && docker.error ? `: ${docker.error}` : ''}. Pulsa para ver los avisos`}>
          <span className="halo"><Dot state={dState} /></span>
          <Container className="st-seg-icon" aria-hidden="true" />
          <span className="lbl">{docker?.ok === false ? 'Docker caído' : 'Docker'}</span>
          {docker?.ok && docker.version && <span className="ver num">{docker.version}</span>}
          {unseen > 0 && <span className="st-badge num" aria-hidden="true">{unseen > 9 ? '9+' : unseen}</span>}
        </button>
      </span>
      {open && (
        <div className="popover nt" role="dialog" aria-label="Avisos" onMouseDown={(e) => { if (!(e.target as HTMLElement).closest('a')) e.preventDefault(); }} onKeyDown={(e) => { if (e.key === 'Escape') close(true); }}>
          <header className="nt-head">
            <h2>Avisos</h2>
            {items.length > 0 && <span className="nt-count num">{items.length}</span>}
            <span className="grow" />
            {items.some((x) => x.at > newSince) && <button className="icon-btn" title="Marcar como vistos" aria-label="Marcar como vistos" onClick={() => setNewSince(Date.now())}><CheckCheck /></button>}
            {items.length > 0 && <button className="icon-btn" title="Vaciar la lista" aria-label="Vaciar la lista" onClick={clearNotices}><Trash2 /></button>}
          </header>

          <div className={`nt-docker ${dState}`}>
            <span className="nt-tile"><Container /></span>
            <div className="nt-body">
              <b><Dot state={dState} />{dWord}</b>
              <span className="nt-sub">{dSub}</span>
              {docker?.ok === false && docker.error && <code className="nt-error">{docker.error}</code>}
            </div>
          </div>

          {!items.length ? (
            <div className="nt-empty">
              <b>Todo en calma</b>
              <p>Lo que pase mientras esta página esté abierta aparece aquí:</p>
              <ul>
                <li><span className="nt-tile docker"><Container /></span>Docker deja de responder o vuelve</li>
                <li><span className="nt-tile change"><RefreshCw /></span>Un agente o un editor cambia el workspace y la pantalla se actualiza</li>
                <li><span className="nt-tile run"><PlayCircle /></span>Termina un run o una sesión, con su resultado</li>
                <li><span className="nt-tile cleanup"><Eraser /></span>Laru limpia Docker o los runs viejos, con lo que liberó</li>
              </ul>
            </div>
          ) : (
            <ul className="nt-list" aria-label="Avisos de esta sesión">
              {items.map((x) => {
                const K = KIND[x.kind];
                const body = (
                  <>
                    <span className={`nt-tile ${x.kind} ${x.state}`} aria-hidden="true"><K.icon /></span>
                    <span className="nt-body">
                      <span className="nt-line"><b>{x.title}</b><time className="nt-time" dateTime={new Date(x.at).toISOString()}>{when(x.at)}</time></span>
                      {x.detail && <span className="nt-sub">{x.detail}</span>}
                      {x.files && x.files.length > 0 && <span className="nt-files">{x.files.slice(0, 3).map((f) => <code key={f} title={f}>{f.split('/').pop()}</code>)}{x.files.length > 3 && <span className="nt-sub">y {x.files.length - 3} más</span>}</span>}
                    </span>
                  </>
                );
                const cls = `nt-item${x.at > newSince ? ' new' : ''}`;
                return <li key={x.id}>{x.to ? <a className={cls} href={x.to} onClick={() => close()}>{body}</a> : <div className={cls}>{body}</div>}</li>;
              })}
            </ul>
          )}
          <footer className="nt-foot">Se guardan mientras esta pestaña esté abierta.</footer>
        </div>
      )}
    </span>
  );
}
