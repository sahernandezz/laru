/**
 * What a changed file reaches, endpoint by endpoint, for the impact of a change: the HTTP calls a frontend file makes
 * (its own and the methods of the services it injects and invokes) and the endpoints a Spring multipart setting governs.
 * Text only, from the working copy: no build, no run.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { detectFile } from '@laru/detect';
import type { Graph } from './graph.ts';

export interface Call { method: string; path: string; /** how the file gets there: `FileService.upload` */ via: string }

/** A path as a shape: `{x}`, `:x`, `${x}` are one placeholder, a trailing slash does not count. */
export const shape = (p: string) => ('/' + p.split('?')[0]).replace(/\/+/g, '/').replace(/\$\{[^}]*\}|\{[^}]*\}|:[A-Za-z_]\w*/g, '{}').replace(/(.)\/$/, '$1');
export const callKey = (method: string, path: string) => `${method.toUpperCase()} ${shape(path)}`;

const outbound = (path: string, content: string) => detectFile(path, content).flatMap((f) => (f.kind === 'outbound' && f.path && f.relative ? [{ method: f.method ?? 'GET', path: f.path, line: f.line }] : []));

/** The method of a class: its first line and the line before the next method that starts at the same indent (or the end). */
function methodRange(src: string, name: string): [number, number] | undefined {
  const lines = src.split('\n');
  const head = new RegExp(`^(\\s*)(?:(?:public|private|protected|static|async|readonly)\\s+)*${name}\\s*(?:<[^>]*>)?\\(`);
  const at = lines.findIndex((l) => head.test(l));
  if (at < 0) return undefined;
  const indent = head.exec(lines[at])![1].length;
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) if (lines[i].trim() && /^\s*(?:(?:public|private|protected|static|async|readonly)\s+)*[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\(/.test(lines[i]) && lines[i].length - lines[i].trimStart().length <= indent && !/^\s*(?:if|for|while|switch|return|catch|else)\b/.test(lines[i])) { end = i; break; }
  return [at + 1, end];
}

/** `import { FileService } from './file.service'` → FileService → './file.service'. */
const importsOf = (src: string) => new Map([...src.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](\.[^'"]+)['"]/g)].flatMap((m) => m[1].split(',').map((n) => [n.trim().split(/\s+as\s+/).pop()!, m[2]] as const)));
/** `private readonly fileService = inject(FileService)` and `constructor(private fileService: FileService)` → fileService → FileService. */
const injectedOf = (src: string) => new Map<string, string>([
  ...[...src.matchAll(/(\w+)\s*(?::\s*[\w<>]+)?\s*=\s*inject\(\s*(\w+)\s*\)/g)].map((m) => [m[1], m[2]] as const),
  ...[...src.matchAll(/(?:private|protected|public)\s+(?:readonly\s+)?(\w+)\s*:\s*(\w+)/g)].map((m) => [m[1], m[2]] as const),
]);

/**
 * The relative HTTP calls a frontend file makes: the ones in the file, and those in the methods of the services it
 * injects and calls (`this.fileService.upload(` → `FileService.upload` → `POST /api/files/upload`), one hop.
 */
export function callsOf(checkout: string, path: string, content: string): Call[] {
  const out: Call[] = outbound(path, content).map((c) => ({ method: c.method, path: c.path, via: path.split('/').pop()! }));
  const imports = importsOf(content), injected = injectedOf(content);
  for (const m of new Set([...content.matchAll(/this\.(\w+)\.(\w+)\(/g)].map((x) => `${x[1]}.${x[2]}`))) {
    const [prop, method] = m.split('.');
    const cls = injected.get(prop), from = cls && imports.get(cls);
    if (!cls || !from) continue;
    const base = normalize(join(dirname(path), from));
    const file = [`${base}.ts`, join(base, 'index.ts')].find((f) => existsSync(join(checkout, f)));
    if (!file) continue;
    const src = readFileSync(join(checkout, file), 'utf8'), range = methodRange(src, method);
    if (!range) continue;
    for (const c of outbound(file, src)) if (c.line >= range[0] && c.line < range[1]) out.push({ method: c.method, path: c.path, via: `${cls}.${method}` });
  }
  return out;
}

const CONFIG = /(^|\/)(application|bootstrap)[^/]*\.(ya?ml|properties)$/;
export const isConfig = (path: string) => CONFIG.test(path);

/** The settings a config file's change adds, removes or changes, by key. */
export function changedKeys(path: string, before: Array<{ kind: string; key?: string; value?: string }>, content: string | undefined): string[] {
  const keys = (fs: typeof before) => new Map(fs.flatMap((f) => (f.kind === 'config' && f.key ? [[f.key, f.value ?? ''] as const] : [])));
  const [b, a] = [keys(before), keys(content === undefined ? [] : detectFile(path, content))];
  return [...new Set([...b.keys(), ...a.keys()])].filter((k) => b.get(k) !== a.get(k)).sort();
}

/** The endpoints of a service whose handler takes an uploaded file (`MultipartFile` in its signature), read from the working copy. */
export function receivingFiles(g: Graph, checkouts: Record<string, string>, service: string): string[] {
  return g.map.nodes.filter((n) => n.type === 'endpoint' && n.service === service && n.anchor).flatMap((n) => {
    const root = checkouts[n.anchor!.repo];
    const f = root && join(root, n.anchor!.path);
    if (!f || !existsSync(f)) return [];
    const lines = readFileSync(f, 'utf8').split('\n'), at = Number(n.anchor!.line ?? 0);
    return /MultipartFile|multipart\/form-data/i.test(lines.slice(Math.max(0, at - 1), at + 7).join('\n')) ? [n.id] : [];
  });
}
