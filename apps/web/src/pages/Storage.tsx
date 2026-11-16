/**
 * Storage: the env's S3-compatible store (MinIO), read through its own `mc`. Buckets, every object under one, and
 * a preview of the one picked: text and JSON as text, images as images, anything else by its type and size.
 */
import { CircleX, File, FileJson, FileText, Film, Folder, Image as ImageIcon, Search, Sheet as SheetIcon } from 'lucide-react';
import { useState } from 'react';
import { apiUrl, useApi, useRecorded, type S3Entry, type SheetData, type StoredObject } from '../api.ts';
import { CodeBlock, CopyButton, Skeleton } from '../components/ui.tsx';
import { langOf } from '../lib/syntax.ts';
import { ago, plural, size } from '../lib/es.ts';
import { useEnvList } from '../lib/useEnvs.ts';
import { href } from '../lib/route.ts';
import { tr, LOCALE } from '../lib/i18n.ts';

const LIMIT = '256 KB';
const iconOf = (key: string) => (/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(key) ? ImageIcon : /\.(mp4|webm|mov|ogv|mp3|wav|ogg)$/i.test(key) ? Film : /\.xlsx$/i.test(key) ? SheetIcon : /\.pdf$/i.test(key) ? FileText : /\.json$/i.test(key) ? FileJson : /\.(txt|md|csv|log|ya?ml|xml|html?)$/i.test(key) ? FileText : File);

export function Storage({ parts }: { parts: string[] }) {
  const [envArg, bucketArg, keyArg] = parts;
  const envs = useEnvList();
  const list = envs.data ?? [];
  // on a run's recording the env is the one recorded, on or off: what it shows is the run's
  const recorded = useRecorded();
  const env = recorded ? envArg : list.find((e) => e.env === envArg)?.env ?? list.find((e) => e.state === 'ready')?.env ?? list[0]?.env;
  const ready = Boolean(recorded) || list.find((e) => e.env === env)?.state === 'ready';
  const q = (path: string, recursive = false) => `/api/storage/ls?env=${encodeURIComponent(env ?? '')}&path=${encodeURIComponent(path)}${recursive ? '&recursive=1' : ''}`;
  const buckets = useApi<S3Entry[]>(env && ready ? q('') : null);
  const names = (buckets.data ?? []).map((b) => b.key.replace(/\/$/, ''));
  const bucket = names.find((b) => b === bucketArg) ?? names[0];

  const head = (
    <div className="head">
      <div><h1>{tr('Almacenamiento')}</h1><p>{tr('Los buckets del entorno y lo que guardan, leídos con el propio')}{' '}<span className="mono">{tr('mc')}</span>{' '}{tr('del contenedor. Las credenciales no salen de él.')}</p></div>
    </div>
  );
  if (envs.error) return <div className="page">{head}<div className="notice" role="alert"><CircleX />{envs.error}</div></div>;
  if (!envs.data) return <div className="page wide">{head}<Skeleton lines={6} /></div>;
  const switcher = !recorded && list.length > 1 && <nav className="seg" aria-label={tr('Entorno')}>{list.map((e) => <a key={e.env} href={href('storage', e.env)} aria-current={e.env === env ? 'page' : undefined}>{e.env}</a>)}</nav>;
  if (!env) return <div className="page">{head}<section className="panel"><div className="empty">{tr('Este workspace no tiene entornos. Crea uno en')}{' '}<a className="rowlink" href={href('envs')}>{tr('Entornos')}</a>{' '}{tr('y levántalo: su almacenamiento aparece aquí.')}</div></section></div>;
  if (!ready) return <div className="page">{head}{switcher}<section className="panel" style={{ marginTop: 12 }}><div className="empty"><span>{env}{' '}{tr('no está en marcha. Levántalo en')}{' '}<a className="rowlink" href={href('envs', env)}>{tr('Entornos')}</a>{' '}{tr('o con')}{' '}<code>laru up {env}</code>.</span></div></section></div>;
  if (buckets.error) return (
    <div className="page">{head}{switcher}
      {/has no running MinIO/.test(buckets.error) ? <section className="panel" style={{ marginTop: 12 }}><div className="empty">{env}{' '}{tr('no tiene MinIO en marcha. Los buckets aparecen aquí en cuanto arranca un contenedor de MinIO.')}</div></section>
        : <div className="notice" role="alert" style={{ marginTop: 12 }}><CircleX />{buckets.error}</div>}
    </div>
  );
  if (!buckets.data) return <div className="page wide">{head}<Skeleton lines={6} /></div>;

  return (
    <div className="page flush">
      <h1 className="sr-only">{tr('Almacenamiento de')}{' '}{env}</h1>
      <div className="dbx">
        <aside className="schema" aria-label={tr('Buckets')}>
          {!recorded && list.length > 1 && <nav className="seg dbx-envs" aria-label={tr('Entorno')}>{list.map((e) => <a key={e.env} href={href('storage', e.env)} aria-current={e.env === env ? 'page' : undefined}>{e.env}</a>)}</nav>}
          <h4>{tr('Buckets de')}{' '}{env}</h4>
          {names.map((b) => <a key={b} href={href('storage', env, b)} aria-current={b === bucket ? 'true' : undefined}><Folder /><span className="tn">{b}</span></a>)}
          {!names.length && <p className="faint aside-note">{tr('El almacén no tiene buckets todavía.')}</p>}
        </aside>
        {bucket ? <Bucket key={`${env}/${bucket}`} env={env} bucket={bucket} picked={keyArg} q={q} /> : <div className="center"><div className="empty">{tr('Sin buckets que mostrar.')}</div></div>}
      </div>
    </div>
  );
}

function Bucket({ env, bucket, picked, q }: { env: string; bucket: string; picked?: string; q: (path: string, recursive?: boolean) => string }) {
  const objects = useApi<S3Entry[]>(q(bucket, true));
  const [filter, setFilter] = useState('');
  const all = (objects.data ?? []).filter((o) => o.type === 'file').sort((a, b) => b.lastModified.localeCompare(a.lastModified));
  const shown = all.filter((o) => o.key.toLowerCase().includes(filter.toLowerCase()));
  const sel = all.find((o) => o.key === picked);
  return (
    <>
      <div className="center">
        <div className="toolbar">
          <label className="search-in"><Search /><span className="sr-only">{tr('Filtrar objetos')}</span><input type="search" placeholder={tr('Filtrar por nombre o ruta')} value={filter} onChange={(e) => setFilter(e.target.value)} /></label>
          <span className="grow" />
          <span className="faint num" aria-live="polite">{objects.data ? (filter ? tr('{length} de {plural}', { length: shown.length, plural: plural(all.length, tr('objeto'), tr('objetos')) }) : plural(all.length, tr('objeto'), tr('objetos'))) : ''}</span>
        </div>
        <div className="grid-wrap" tabIndex={0} aria-label={tr('Objetos de {bucket}', { bucket })} aria-busy={objects.loading}>
          {objects.error ? <div className="notice" role="alert" style={{ margin: 12 }}><CircleX />{objects.error}</div>
            : !objects.data ? <div style={{ display: 'grid', gap: 10, padding: 16 }}>{[88, 72, 80, 66, 90].map((w) => <div key={w} className="sk" style={{ height: 14, width: `${w}%` }} />)}</div>
            : !shown.length ? <p className="empty">{all.length ? tr('Ningún objeto coincide.') : tr('{bucket} está vacío.', { bucket })}</p>
            : (
              <table className="t objects">
                <thead><tr><th>{tr('Objeto')}</th><th className="r">{tr('Tamaño')}</th><th className="r">{tr('Modificado')}</th></tr></thead>
                <tbody>
                  {shown.map((o) => {
                    const Icon = iconOf(o.key);
                    return (
                      <tr key={o.key} className={o === sel ? 'sel' : undefined}>
                        <td className="wrap"><a className="obj mono" href={href('storage', env, bucket, o.key)} aria-current={o === sel ? 'true' : undefined}><Icon aria-hidden="true" /><span>{o.key}</span></a></td>
                        <td className="r num">{size(o.size)}</td>
                        <td className="r faint" title={new Date(o.lastModified).toLocaleString(LOCALE)}>{ago(o.lastModified)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
        </div>
        <div className="gridfoot"><span>{tr('Más recientes primero')}</span><span className="grow" /><span className="mono">{bucket}</span></div>
      </div>
      <aside className="right" aria-label={tr('Vista previa')}>
        {sel ? <Preview key={sel.key} env={env} bucket={bucket} entry={sel} /> : <p className="faint aside-note">{picked ? tr('Ese objeto ya no está en el bucket.') : tr('Elige un objeto para ver su contenido y sus metadatos.')}</p>}
      </aside>
    </>
  );
}

function Preview({ env, bucket, entry }: { env: string; bucket: string; entry: S3Entry }) {
  const path = `${bucket}/${entry.key}`;
  const o = useApi<StoredObject>(`/api/storage/object?env=${encodeURIComponent(env)}&path=${encodeURIComponent(path)}`);
  const name = entry.key.split('/').pop() ?? entry.key;
  const type = o.data?.type ?? o.data?.meta.metadata?.['Content-Type'] ?? '';
  return (
    <section aria-labelledby="obj-h" className="preview">
      <h3 id="obj-h" className="aside-h mono" title={entry.key}>{name}</h3>
      <div className="conn">
        <span className="lbl">{tr('Ruta')}</span>
        <div className="f"><code title={path}>{path}</code><CopyButton value={path} label={tr('Copiar la ruta del objeto')} /></div>
      </div>
      <dl className="meta-list">
        <div><dt>{tr('Tipo')}</dt><dd className="mono">{o.data ? type || tr('sin tipo') : '…'}</dd></div>
        <div><dt>{tr('Tamaño')}</dt><dd className="num">{size(entry.size)}</dd></div>
        <div><dt>{tr('Modificado')}</dt><dd>{new Date(entry.lastModified).toLocaleString(LOCALE)}</dd></div>
        {entry.etag && <div><dt>{tr('ETag')}</dt><dd className="mono" title={entry.etag}>{entry.etag}</dd></div>}
      </dl>
      {o.error ? <p className="form-err" role="alert">{o.error}</p>
        : !o.data ? <div className="sk" style={{ height: 120 }} aria-hidden="true" />
        : <Content o={o.data} type={type} name={name} env={env} path={path} />}
    </section>
  );
}

/** By the stored Content-Type first; text without a type is shown as text. */
function Content({ o, type, name, env, path }: { o: StoredObject; type: string; name: string; env: string; path: string }) {
  const raw = apiUrl(`/api/storage/raw?env=${encodeURIComponent(env)}&path=${encodeURIComponent(path)}`);
  if (o.stream === 'sheet') return <SheetView env={env} path={path} name={name} />;
  if (o.stream === 'raw') {
    if (type.startsWith('image/')) return <div className="obj-img"><img src={raw} alt={tr('Vista previa de {name}', { name })} loading="lazy" /></div>;
    if (type.startsWith('video/')) return <video className="obj-media" src={raw} controls preload="metadata" aria-label={tr('Vídeo {name}', { name })} />;
    if (type.startsWith('audio/')) return <audio className="obj-audio" src={raw} controls preload="metadata" aria-label={tr('Audio {name}', { name })} />;
    if (type === 'application/pdf') return <iframe className="obj-pdf" src={raw} title={`PDF ${name}`} />;
  }
  const cut = o.truncated ? <p className="faint aside-note">{tr('Solo los primeros')}{' '}{LIMIT}.</p> : null;
  if (type.startsWith('image/')) {
    if (o.truncated) return <p className="faint aside-note">{tr('La imagen pesa más de')}{' '}{LIMIT}{tr(': aquí no se previsualiza.')}</p>;
    const src = o.base64 !== undefined ? `data:${type};base64,${o.base64}` : type === 'image/svg+xml' && o.text ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(o.text)}` : null;
    return src ? <div className="obj-img"><img src={src} alt={tr('Vista previa de {name}', { name })} /></div> : <p className="faint aside-note">{tr('No se pudo leer la imagen.')}</p>;
  }
  const textual = o.text !== undefined && (!type || /^text\/|json|xml|yaml|csv|javascript/.test(type));
  if (!textual) return <p className="faint aside-note">{tr('Sin vista previa para')}{' '}{type || tr('este contenido')}{tr(': se ve con un programa que lo entienda.')}</p>;
  if (!o.text) return <>{cut}<pre className="json obj-text"><span className="faint">{tr('(vacío)')}</span></pre></>;
  return <>{cut}<CodeBlock className="json obj-text" text={o.text} lang={langOf(o.text, type)} format label={tr('Contenido de {name}', { name })} /></>;
}

/** A spreadsheet's first sheet as a table, read and masked by the service. */
function SheetView({ env, path, name }: { env: string; path: string; name: string }) {
  const d = useApi<SheetData>(`/api/storage/sheet?env=${encodeURIComponent(env)}&path=${encodeURIComponent(path)}`);
  if (d.error) return <p className="form-err" role="alert">{d.error}</p>;
  if (!d.data) return <div className="sk" style={{ height: 120 }} aria-hidden="true" />;
  const cols = Math.max(0, ...d.data.rows.map((r) => r.length));
  return (
    <div className="obj-sheet">
      <p className="faint aside-note">{tr('Hoja «')}{d.data.name}»{d.data.sheets > 1 ? tr(', la primera de {sheets}', { sheets: d.data.sheets }) : ''}{d.data.truncated ? tr('; solo las primeras filas y columnas') : ''}.</p>
      <div className="scroll-x" tabIndex={0} aria-label={tr('Contenido de {name}', { name })}>
        <table className="t">
          <tbody>{d.data.rows.map((r, i) => <tr key={i}>{Array.from({ length: cols }, (_, c) => <td key={c} className="mono">{r[c] ?? ''}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}
