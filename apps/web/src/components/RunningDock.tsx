/**
 * What is running, floating at the bottom right of every screen while something runs: each run or session with where
 * it is in its phases, how long it has been at it (ticking), and a way to open it. It folds into a pill (the choice is
 * kept in this browser) and goes away by itself when nothing runs; how each one ended comes as a notice.
 */
import { ChevronDown, ChevronUp, PlayCircle, Radio } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { RunInfo } from '../api.ts';
import { RUN_PHASE } from '../lib/es.ts';
import { href, liveHref } from '../lib/route.ts';

const PHASES = ['queued', 'build', 'up', 'tests', 'evidence', 'destroy'] as const;
const FOLD = 'laru.running.folded';
const elapsed = (from: string, now: number) => { const s = Math.max(0, Math.round((now - Date.parse(from)) / 1000)); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`; };

export function RunningDock({ running }: { running: RunInfo[] }) {
  const [folded, setFolded] = useState(() => { try { return localStorage.getItem(FOLD) === '1'; } catch { return false; } });
  const fold = (on: boolean) => { setFolded(on); try { localStorage.setItem(FOLD, on ? '1' : '0'); } catch { /* not kept */ } };
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running.length) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running.length]);
  if (!running.length) return null;
  const n = 'en curso';

  if (folded) return (
    <button className="dock dock-pill" onClick={() => fold(false)} aria-label={`${running.length} ${n}: mostrar`}>
      <span className="dock-beat" aria-hidden="true" /><b className="num">{running.length}</b> {n}<ChevronUp aria-hidden="true" />
    </button>
  );
  return (
    <section className="dock" aria-label="En curso">
      <header className="dock-head">
        <span className="dock-beat" aria-hidden="true" />
        <h2>En curso</h2><span className="dock-n num">{running.length}</span>
        <button className="icon-btn" onClick={() => fold(true)} aria-label="Plegar" title="Plegar"><ChevronDown /></button>
      </header>
      <ul>
        {running.slice(0, 4).map((r) => {
          const session = r.kind === 'session', at = PHASES.indexOf(r.phase as typeof PHASES[number]);
          const what = session ? r.title ?? 'Sesión en vivo' : r.flows.length === 1 ? r.flows[0] : `${r.flows.length} flujos`;
          return (
            <li key={r.id}>
              <a href={session ? liveHref(r) : href('runs', r.id)}>
                <span className={`dock-icon${session ? ' live' : ''}`} aria-hidden="true">{session ? <Radio /> : <PlayCircle />}</span>
                <span className="dock-body">
                  <span className="dock-line"><b>{what}</b><span className="dock-time num">{elapsed(r.startedAt, now)}</span></span>
                  <span className="dock-sub"><span className="mono">#{r.id}</span> · {r.env} · {RUN_PHASE[r.phase] ?? r.phase}</span>
                  {!session && <span className="dock-phases" role="img" aria-label={`Fase ${at + 1} de ${PHASES.length}: ${RUN_PHASE[r.phase] ?? r.phase}`}>
                    {PHASES.map((p, i) => <i key={p} className={i < at ? 'past' : i === at ? 'now' : undefined} title={RUN_PHASE[p]} />)}
                  </span>}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
      {running.length > 4 && <a className="dock-more" href={`${href('runs')}?estado=running`}>y {running.length - 4} más en Runs</a>}
    </section>
  );
}
