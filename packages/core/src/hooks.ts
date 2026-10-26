/**
 * Claude Code hooks. Before an edit, the conventions that rule the file and the pieces that talk about it reach the
 * model once per session and file (`additionalContext`); after an edit, a `forbid:` or `require:` rule the new
 * content breaks blocks with the line. Files outside the app's checkouts get silence. Both answer in milliseconds:
 * the knowledge and one repo's file list, no map.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { conventionsFor } from './knowledge/coverage.ts';
import { anchorResolver, freshness, loadKnowledge, type Loaded } from './knowledge/store.ts';
import { estimateTokens } from './query.ts';
import { stateDir, type Workspace } from './workspace.ts';

export interface HookInput { session_id?: string; cwd?: string; tool_name?: string; tool_input?: { file_path?: string; path?: string } }

/** `repo:path` of a file in one of the checkouts (the longest that contains it), or null. */
export function locate(ws: Workspace, file?: string): { repo: string; path: string } | null {
  if (!file) return null;
  const hits = Object.entries(ws.checkouts).map(([repo, dir]) => ({ repo, dir, rel: relative(dir, file) }))
    .filter((h) => h.rel && !h.rel.startsWith('..') && !h.rel.startsWith('/')).sort((a, b) => b.dir.length - a.dir.length);
  return hits[0] ? { repo: hits[0].repo, path: hits[0].rel } : null;
}

/** Pieces anchored to the file, and the conventions that rule it through them. */
function rulers(ws: Workspace, at: { repo: string; path: string }) {
  const k = loadKnowledge(ws);
  const resolve = anchorResolver(ws);
  const covers = (p: Loaded) => (p.anchors ?? []).some((a) => a.startsWith(`${at.repo}:`) && (resolve(a) ?? []).includes(at.path));
  const pieces = k.pieces.filter(covers);
  const owners = pieces.filter((p) => p.type === 'module' || p.type === 'service');
  const conventions = [...new Map([...owners.flatMap((o) => conventionsFor(k, o)), ...pieces.filter((p) => p.type === 'convention')].map((c) => [c.id, c])).values()];
  return { ws, pieces, conventions };
}

export function preEdit(ws: Workspace, input: HookInput): Record<string, unknown> | null {
  const at = locate(ws, input.tool_input?.file_path ?? input.tool_input?.path);
  if (!at) return null;
  const seenFile = join(stateDir(ws), 'hooks', `${(input.session_id ?? 'none').replace(/[^\w-]/g, '')}.json`);
  const seen = existsSync(seenFile) ? (JSON.parse(readFileSync(seenFile, 'utf8')) as string[]) : [];
  const key = `${at.repo}:${at.path}`;
  if (seen.includes(key)) return null;
  const { pieces, conventions } = rulers(ws, at);
  if (!pieces.length && !conventions.length) return null;
  const lines = [`Laru on ${key}:`];
  for (const c of conventions) lines.push(`- convention ${c.id} «${c.title}»: ${String(c.fields.rule ?? c.summary)}${(c.fields.check as string[] | undefined)?.length ? ` (checked: ${(c.fields.check as string[]).join('; ')})` : ''}`);
  for (const p of pieces.filter((x) => x.type !== 'convention')) lines.push(`- ${p.id} «${p.title}»: ${p.summary}${freshness(ws, p) === 'stale' ? ' — STALE: review and update it in this task, then knowledge_verify' : ''}`);
  lines.push('Call `context` on this file before a non-trivial change; after it, `impact` says which flows to run.');
  const out: string[] = [];
  let used = 0;
  for (const l of lines) { if (used + estimateTokens(l) > 600) { out.push(`… ${lines.length - out.length} more`); break; } out.push(l); used += estimateTokens(l); }
  mkdirSync(join(stateDir(ws), 'hooks'), { recursive: true });
  writeFileSync(seenFile, JSON.stringify([...seen, key]));
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: out.join('\n') } };
}

export function postEdit(ws: Workspace, input: HookInput): Record<string, unknown> | null {
  const file = input.tool_input?.file_path ?? input.tool_input?.path;
  const at = locate(ws, file);
  if (!at || !file || !existsSync(file)) return null;
  const src = readFileSync(file, 'utf8');
  const broken: string[] = [];
  for (const c of rulers(ws, at).conventions) for (const rule of (c.fields.check as string[] | undefined) ?? []) {
    const m = /^(forbid|require):\s*(.+)$/.exec(rule);
    if (!m) continue;
    const hit = new RegExp(m[2], 'm').exec(src);
    if (m[1] === 'forbid' && hit) broken.push(`${at.repo}:${at.path}:${src.slice(0, hit.index).split('\n').length} breaks «${c.title}» (${rule})`);
    if (m[1] === 'require' && !hit) broken.push(`${at.repo}:${at.path} breaks «${c.title}» (${rule})`);
  }
  return broken.length ? { decision: 'block', reason: `${broken.join('\n')}\nFix it, or change the convention with knowledge_write if the rule is wrong.` } : null;
}
