/**
 * «Datos del último run» of a flow: finds the run that last played it (a reused result: the run it came from) and opens
 * the data screen on its recording, the same screen as live (`#/data/<env>?run=<id>&flujo=<slug>`), so it shows with
 * the env off. With no recording it says why: the flow never ran, its last run is from before Laru recorded, or the
 * recording failed. `?run=<id>`: that run instead of the last.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { useApi } from '../api.ts';
import { Skeleton } from '../components/ui.tsx';
import { href, queryOf, recordedHref } from '../lib/route.ts';
import { tr } from '../lib/i18n.ts';

interface Found { run: string | null; result?: string; recording?: { at: string; env: string; error?: string; cut: string[] } | null }
const LABEL: Record<string, string> = { data: tr('Bases de datos'), queues: tr('Colas'), storage: tr('Almacenamiento'), mail: tr('Correo y mensajes'), vars: tr('Variables y secretos') };

export function RunData({ slug, kind }: { slug: string; kind: string }) {
  const hash = useSyncExternalStore((f) => { addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, () => location.hash);
  const pinned = queryOf(hash).get('run');
  const r = useApi<Found>(`/api/run/state?flow=${encodeURIComponent(slug)}${pinned && /^\d+$/.test(pinned) ? `&id=${pinned}` : ''}`);
  const d = r.data, screen = LABEL[kind] ? kind : 'data';
  // a recording opens on the same screen as live: replaced, so Back does not land here again
  // only on a fresh answer: a cached one may name an older run than the last one now
  useEffect(() => {
    if (!r.loading && d?.run && d.recording && !d.recording.error) location.replace(recordedHref(screen, d.recording.env, d.run, slug));
  }, [d, r.loading, screen, slug]);
  const head = <div className="head"><div><h1>{LABEL[screen]}</h1><p>{tr('Cómo quedaron los datos al terminar el último run de')}{' '}{slug}.</p></div></div>;
  if (!d) return <div className="page">{head}{r.error ? <div className="notice">{r.error}</div> : <Skeleton lines={6} />}</div>;
  const run = d.run && <a className="rowlink" href={href('runs', d.run, slug)}>run {d.run}</a>;
  return (
    <div className="page">
      {head}
      <section className="panel"><div className="empty">
        {!d.run ? <>{tr('Este flujo todavía no se ha ejecutado. Ejecútalo desde su')}{' '}<a className="rowlink" href={href('docs', `flow:${slug}`)}>{tr('resumen')}</a>{' '}{tr('para ver aquí cómo quedan sus datos.')}</>
          : d.recording?.error ? <>{tr('El')}{' '}{run}{' '}{tr('no pudo grabar cómo quedaron sus datos:')}{' '}<span className="mono">{d.recording.error}</span></>
          : !d.recording ? <>{tr('Su último run, el')}{' '}{run}{tr(', es de antes de que Laru grabara los datos al terminar: el próximo run los guarda.')}</>
          : <Skeleton lines={3} />}
      </div></section>
    </div>
  );
}
