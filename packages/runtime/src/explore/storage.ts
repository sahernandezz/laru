/**
 * An S3-compatible store of an env (MinIO), through `mc` inside its own container. The credentials are the
 * container's own environment, expanded by its shell: they never travel on Laru's command lines.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import type { Workspace } from '@laru/core';
import { docker, dockerEnv, inspectEnv, LABEL } from '../docker.ts';

export interface Bucketed { service: string; container: string; image: string }
export interface S3Entry { key: string; type: 'file' | 'folder'; size: number; lastModified: string; etag?: string }

export async function storeOfEnv(ws: Workspace, env: string): Promise<Bucketed> {
  const c = (await inspectEnv(ws, env)).find((x) => x.state === 'running' && !x.labels[LABEL.run] && /minio/.test(x.image));
  if (!c) throw new Error(`${env} has no running MinIO`);
  return { service: c.service, container: c.id, image: c.image };
}

const ALIAS = 'mc -C /tmp/ks-mc alias set ks http://127.0.0.1:9000 "${MINIO_ROOT_USER:-${MINIO_ACCESS_KEY}}" "${MINIO_ROOT_PASSWORD:-${MINIO_SECRET_KEY}}" >/dev/null &&';
const path = (p: string) => { if (/['\\]/.test(p) || p.includes('..')) throw new Error('not a valid object path'); return `'ks/${p.replace(/^\/+/, '')}'`; };

/** Buckets (no path), or the entries under bucket[/prefix]. */
export async function ls(s: Bucketed, at = '', recursive = false): Promise<S3Entry[]> {
  const out = await docker(['exec', s.container, 'sh', '-c', `${ALIAS} mc -C /tmp/ks-mc ls --json ${recursive ? '--recursive ' : ''}${path(at)}`]).catch((e: Error) => { if (/does not exist|NoSuchBucket/.test(e.message)) return ''; throw e; });
  return out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.status === 'success').map((x) => ({ key: x.key, type: x.type === 'folder' ? 'folder' : 'file', size: x.size ?? 0, lastModified: x.lastModified, etag: x.etag || undefined }));
}

export async function stat(s: Bucketed, at: string): Promise<Record<string, unknown>> {
  return JSON.parse(await docker(['exec', s.container, 'sh', '-c', `${ALIAS} mc -C /tmp/ks-mc stat --json ${path(at)}`]));
}

/** The first `max` bytes of an object. */
export function cat(s: Bucketed, at: string, max = 1024 * 1024): Promise<{ bytes: Buffer; truncated: boolean }> {
  return new Promise((ok, fail) => {
    const p = spawn('docker', ['exec', s.container, 'sh', '-c', `${ALIAS} mc -C /tmp/ks-mc cat ${path(at)} | head -c ${max + 1}`], { env: dockerEnv() });
    const chunks: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (c: Buffer) => chunks.push(c));
    p.stderr.on('data', (c: Buffer) => { err += c; });
    p.on('error', fail);
    p.on('close', (code) => {
      const all = Buffer.concat(chunks);
      if (code !== 0 && !all.length) return fail(new Error(err.trim().split('\n').pop() || `exit ${code}`));
      ok({ bytes: all.subarray(0, max), truncated: all.length > max });
    });
  });
}

/** What the browser may be handed as it is stored, by its own viewer: images, video, audio and PDF. Anything else is read as text or not at all. */
export const STREAMABLE = /^(image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)|video\/(mp4|webm|ogg|quicktime)|audio\/[\w.+-]+|application\/pdf)$/;
const BY_EXT: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml', mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
export const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** The stored Content-Type, or the one the extension says when the object was put without one (or as a blob). */
export function contentTypeOf(meta: Record<string, unknown>, key: string): string {
  const stored = String((meta.metadata as Record<string, unknown> | undefined)?.['Content-Type'] ?? '').split(';')[0].trim().toLowerCase();
  return stored && stored !== 'application/octet-stream' ? stored : BY_EXT[key.split('.').pop()?.toLowerCase() ?? ''] ?? stored;
}

/**
 * `length` bytes of an object from `start`, streamed from the store: the object is never held whole, so what the service
 * grows by is a pipe's buffer whatever the object weighs. The caller ends the child when the client goes away.
 */
export function slice(s: Bucketed, at: string, start: number, length: number): ChildProcessWithoutNullStreams {
  if (!Number.isInteger(start) || !Number.isInteger(length) || start < 0 || length < 1) throw new Error('not a valid range');
  return spawn('docker', ['exec', s.container, 'sh', '-c', `${ALIAS} mc -C /tmp/ks-mc cat --offset ${start} ${path(at)} | head -c ${length}`], { env: dockerEnv() });
}

/* ---- a spreadsheet, read without a library: an .xlsx is a zip of XML ---- */
export interface Sheet { name: string; rows: string[][]; truncated: boolean; sheets: number }

/** Every file of a zip, by name, from its central directory (stored or deflated: what spreadsheets use). */
function unzip(zip: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a spreadsheet: no zip directory');
  let at = zip.readUInt32LE(eocd + 16);
  for (let n = zip.readUInt16LE(eocd + 10); n > 0 && zip.readUInt32LE(at) === 0x02014b50; n--) {
    const method = zip.readUInt16LE(at + 10), csize = zip.readUInt32LE(at + 20), nlen = zip.readUInt16LE(at + 28), xlen = zip.readUInt16LE(at + 30), clen = zip.readUInt16LE(at + 32), off = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nlen);
    const data = off + 30 + zip.readUInt16LE(off + 26) + zip.readUInt16LE(off + 28);
    if (/^xl\/(sharedStrings\.xml|workbook\.xml|worksheets\/sheet\d+\.xml)$/.test(name)) {
      const raw = zip.subarray(data, data + csize);
      out.set(name, method === 0 ? raw : method === 8 ? inflateRawSync(raw) : Buffer.alloc(0));
    }
    at += 46 + nlen + xlen + clen;
  }
  return out;
}
const xml = (t: string) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, '&');
const colOf = (ref: string) => [...ref.replace(/\d+$/, '')].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

/** The first sheet of an .xlsx as rows of text (at most `maxRows` by `maxCols`), with its shared strings resolved. */
export function sheet(zip: Buffer, maxRows = 200, maxCols = 40): Sheet {
  const files = unzip(zip);
  const names = [...files.keys()].filter((n) => n.startsWith('xl/worksheets/')).sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]));
  if (!names.length) throw new Error('not a spreadsheet: it has no sheet');
  const strings = [...(files.get('xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => xml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
  const body = files.get(names[0])!.toString('utf8');
  const rows: string[][] = [];
  let truncated = false;
  for (const r of body.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    if (rows.length >= maxRows) { truncated = true; break; }
    const row: string[] = [];
    for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const at = /\br="([A-Z]+)\d+"/.exec(c[1]), kind = /\bt="(\w+)"/.exec(c[1])?.[1], v = /<v>([\s\S]*?)<\/v>/.exec(c[2] ?? '')?.[1], inline = /<t[^>]*>([\s\S]*?)<\/t>/.exec(c[2] ?? '')?.[1];
      const i = at ? colOf(at[1]) : row.length;
      if (i >= maxCols) { truncated = true; continue; }
      row[i] = kind === 's' && v !== undefined ? strings[Number(v)] ?? '' : kind === 'inlineStr' && inline !== undefined ? xml(inline) : v !== undefined ? xml(v) : '';
    }
    rows.push(Array.from(row, (x) => x ?? ''));
  }
  const first = /<sheet\b[^>]*\bname="([^"]*)"/.exec(files.get('xl/workbook.xml')?.toString('utf8') ?? '')?.[1];
  return { name: xml(first ?? 'Hoja 1'), rows, truncated, sheets: names.length };
}
