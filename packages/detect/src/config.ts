/** Spring and Quarkus configuration files: every key with its value and profile, and the env vars they read. */
import { LineCounter, isMap, isScalar, isSeq, parseAllDocuments, type Node as YamlNode } from 'yaml';
import type { Finding } from './types.ts';

const PLACEHOLDER = /\$\{([A-Z][A-Z0-9_]*)(?::([^}]*))?\}/g;

/** `application-docker.yml` → docker; `application.yml` → undefined. */
const fileProfile = (path: string): string | undefined => path.match(/(?:application|bootstrap)-([\w-]+)\.(?:ya?ml|properties)$/)?.[1];

function pushEntry(out: Finding[], key: string, value: string, line: number, profile?: string) {
  const qp = key.match(/^%([\w-]+)\.(.+)$/); // Quarkus `%dev.key`
  out.push({ kind: 'config', key: qp ? qp[2] : key, value, line, profile: qp ? qp[1] : profile });
  for (const m of value.matchAll(PLACEHOLDER)) out.push({ kind: 'env-var', name: m[1], via: 'placeholder', hasDefault: m[2] !== undefined, configKey: qp ? qp[2] : key, line });
}

export function detectProperties(path: string, src: string): Finding[] {
  const out: Finding[] = [];
  const profile = fileProfile(path);
  src.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) return;
    const m = line.match(/^([^=:\s]+)\s*[=:]\s*(.*)$/);
    if (m) pushEntry(out, m[1], m[2], i + 1, profile);
  });
  return out;
}

export function detectYamlConfig(path: string, src: string): Finding[] {
  const out: Finding[] = [];
  const lc = new LineCounter();
  for (const doc of parseAllDocuments(src, { lineCounter: lc })) {
    if (!('contents' in doc) || !doc.contents) continue;
    const local: Finding[] = [];
    const walk = (node: YamlNode | null, prefix: string) => {
      if (isMap(node)) {
        for (const pair of node.items) {
          const k = isScalar(pair.key) ? String(pair.key.value) : '';
          const full = prefix ? `${prefix}.${k}` : k;
          const v = pair.value as YamlNode | null;
          if (isScalar(v)) pushEntry(local, full, String(v.value ?? ''), lc.linePos(v.range?.[0] ?? 0).line, fileProfile(path));
          else walk(v, full);
        }
      } else if (isSeq(node)) {
        node.items.forEach((item, i) => {
          if (isScalar(item)) pushEntry(local, `${prefix}[${i}]`, String(item.value ?? ''), lc.linePos(item.range?.[0] ?? 0).line, fileProfile(path));
          else walk(item as YamlNode, `${prefix}[${i}]`);
        });
      }
    };
    walk(doc.contents as YamlNode, '');
    // Spring multi-document files: `spring.config.activate.on-profile` names the document's profile.
    const docProfile = local.find((f) => f.kind === 'config' && /^spring\.(config\.activate\.on-profile|profiles)$/.test(f.key));
    if (docProfile && docProfile.kind === 'config') for (const f of local) if (f.kind === 'config') f.profile = docProfile.value;
    out.push(...local);
  }
  return out;
}
