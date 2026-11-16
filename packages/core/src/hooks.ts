/**
 * Claude Code hooks. Before an edit, the conventions that rule the file and the pieces that talk about it reach the
 * model once per session and file (`additionalContext`); after an edit, a `forbid:` or `require:` rule the new
 * content breaks blocks with the line. Files outside the app's checkouts get silence. Both answer in milliseconds:
 * the knowledge and one repo's file list, no map.
 *
 * What is refused before it happens: a piece of docs/ written by hand (knowledge_write writes it), an edit on a branch
 * the working agreement says is not edited, and a shell command its `never` lists; one its `confirm` lists is asked
 * about. When the agent stops: `check`'s errors, and the pieces describing the files it edited that it did not review.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { agreementRules, loadAgreement } from './agreement.ts';
import { conventionsFor } from './knowledge/coverage.ts';
import { anchorCovers, anchorResolver, DOCS_DIR, freshness, globRe, loadKnowledge, type Loaded } from './knowledge/store.ts';
import { estimateTokens } from './query.ts';
import { momentsOf, rulesFor, rulesForText, ruleText } from './work.ts';
import { runsDocker } from './shell.ts';
import { stateDir, type Workspace } from './workspace.ts';

export interface HookInput { session_id?: string; cwd?: string; prompt?: string; tool_name?: string; tool_input?: { file_path?: string; path?: string; command?: string }; stop_hook_active?: boolean }

const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
const ask = (reason: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } });
const sessionFile = (ws: Workspace, input: HookInput, what: string) => join(stateDir(ws), 'hooks', `${(input.session_id ?? 'none').replace(/[^\w-]/g, '')}${what}.json`);

/** The branch a checkout is on now, or undefined (detached, or not git). */
function branchOf(dir: string): string | undefined {
  try { const b = execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); return b && b !== 'HEAD' ? b : undefined; } catch { return undefined; }
}

/** An edit refused before it happens: a piece of docs/ by hand, or code on a branch the working agreement keeps. */
function refused(ws: Workspace, file: string, at: { repo: string; path: string } | null): Record<string, unknown> | null {
  const rel = relative(join(ws.root, DOCS_DIR), file);
  if (!rel.startsWith('..') && !rel.startsWith(sep) && file.endsWith('.md')) return deny(`${DOCS_DIR}/${rel} is a piece of the documentation: it is written with knowledge_write (read knowledge_shape first), which validates it; never by hand.`);
  if (!at) return null;
  const kept = agreementRules(loadAgreement(ws)).protected;
  const branch = kept.length ? branchOf(ws.checkouts[at.repo]) : undefined;
  const rule = branch && kept.find((g) => globRe(g).test(branch));
  return rule ? deny(`${at.repo} is on ${branch}, and the working agreement says code is not edited on «${rule}»: make a branch for the work first (ask the person which, if the agreement does not say).`) : null;
}

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
  const covers = (p: Loaded) => (p.anchors ?? []).some((a) => anchorCovers(resolve, a, at.repo, at.path));
  const pieces = k.pieces.filter(covers);
  const owners = pieces.filter((p) => p.type === 'module' || p.type === 'service');
  const conventions = [...new Map([...owners.flatMap((o) => conventionsFor(k, o)), ...pieces.filter((p) => p.type === 'convention')].map((c) => [c.id, c])).values()];
  return { ws, pieces, conventions };
}

export function preEdit(ws: Workspace, input: HookInput): Record<string, unknown> | null {
  const file = input.tool_input?.file_path ?? input.tool_input?.path;
  const at = locate(ws, file);
  const no = file ? refused(ws, file, at) : null;
  if (no) return no;
  if (!at) return null;
  const seenFile = sessionFile(ws, input, '');
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
  // the files this session edited, with when it first did: what the stop hook asks to have reviewed
  const editsFile = sessionFile(ws, input, '.edits');
  const edits = existsSync(editsFile) ? (JSON.parse(readFileSync(editsFile, 'utf8')) as Record<string, number>) : {};
  if (!edits[`${at.repo}:${at.path}`]) { edits[`${at.repo}:${at.path}`] = Date.now(); mkdirSync(join(stateDir(ws), 'hooks'), { recursive: true }); writeFileSync(editsFile, JSON.stringify(edits)); }
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

const DOCKER_INSTEAD = [
  'Not from your shell: this workspace\'s Docker is Laru\'s, and your shell may not reach the engine it does (on Windows with Docker inside WSL it never will). Ask Laru, which reaches it, with the tool or the command for what you wanted:',
  '- what runs and its state: env_status (`laru env status`); bring it up or apply a change: env_up (`laru up`); remove it: `laru down`',
  '- logs: `laru logs <service>`; a command inside a container: `laru exec <service> -- <command>`',
  '- databases: db_query (`laru db query "<sql>"`); queues: `laru queue`; objects: `laru storage`; mail: mail_list (`laru mail`)',
  '- what this machine has (Docker, WSL): `laru doctor`',
  'If Laru has no way to do what you need, say so to the person instead of reaching Docker yourself.',
].join('\n');

/**
 * A shell command the working agreement refuses (`never`) or wants asked about first (`confirm`); and a commit, a push, a
 * PR or a ticket, stopped once per session with the person's instructions about it, whole: what it delivers follows them,
 * then it runs again.
 */
export function preBash(ws: Workspace, input: HookInput): Record<string, unknown> | null {
  const cmd = input.tool_input?.command;
  if (!cmd) return null;
  const rules = agreementRules(loadAgreement(ws));
  const no = rules.deny.find((r) => r.re.test(cmd));
  if (no) return deny(`The working agreement of this workspace says this is never done (cmd: ${no.text}).`);
  if (runsDocker(cmd)) return deny(DOCKER_INSTEAD);
  // a moment Laru knows, or any command a rule names with `cmd:` (a publish, a deploy): both are looked up, every time
  const moments = momentsOf(cmd);
  const servedFile = sessionFile(ws, input, '.rules');
  const served = existsSync(servedFile) ? (JSON.parse(readFileSync(servedFile, 'utf8')) as string[]) : [];
  const due = rulesFor(ws, moments, cmd).filter((p) => !served.includes(p.id));
  if (due.length) {
    mkdirSync(join(stateDir(ws), 'hooks'), { recursive: true });
    writeFileSync(servedFile, JSON.stringify([...served, ...due.map((p) => p.id)]));
    return deny([
      `Not yet: ${moments.length ? `this is a ${moments.join(' and a ')}` : 'this command'}, and the person's instructions for how you work here say how it is done. Make what you deliver follow them, then run it again; it will not be stopped twice for these.`,
      ...due.map((p) => ruleText(ws, p)),
    ].join('\n\n'));
  }
  const first = rules.ask.find((r) => r.re.test(cmd));
  return first ? ask(`The working agreement asks the person before this (cmd: ${first.text}).`) : null;
}

/**
 * Each thing the person asks: their instructions about it reach the agent before it starts, whole, once per session
 * (what was shown stays in its context); the ones past the budget by name. And always one line: the work here is done
 * Laru's way, so a request with no rule of its own is still done through Laru's tools.
 */
export function onPrompt(ws: Workspace, input: HookInput): Record<string, unknown> {
  const out = ['Laru: work here through its tools and the person\'s instructions in their working agreement («Cómo se trabaja»), over your habits and the repositories\' defaults; `laru rules --for "<task>"` finds the ones for anything else you do.'];
  const servedFile = sessionFile(ws, input, '.rules');
  const served = existsSync(servedFile) ? (JSON.parse(readFileSync(servedFile, 'utf8')) as string[]) : [];
  const due = rulesForText(ws, input.prompt ?? '').filter((p) => !served.includes(p.id));
  if (due.length) {
    out.push('The person\'s instructions for what was just asked; follow them in how you do it:');
    let used = 0;
    const shown: string[] = [];
    for (const p of due) {
      const text = ruleText(ws, p);
      if (shown.length && used + estimateTokens(text) > 4000) { out.push(`Also about it (\`laru rules --for\` gives them whole): ${due.filter((x) => !shown.includes(x.id)).map((x) => `«${x.title}»`).join(', ')}`); break; }
      out.push(text); shown.push(p.id); used += estimateTokens(text);
    }
    mkdirSync(join(stateDir(ws), 'hooks'), { recursive: true });
    writeFileSync(servedFile, JSON.stringify([...served, ...shown]));
  }
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: out.join('\n\n') } };
}

/**
 * When the agent stops: the documentation's errors (`check`), and the pieces that describe the files it edited in this
 * session and that were not written or verified since. It blocks once: on stopping again (`stop_hook_active`) it lets go.
 */
export function stopCheck(ws: Workspace, input: HookInput, errors: Array<{ path: string; message: string }>): Record<string, unknown> | null {
  if (input.stop_hook_active) return null;
  const editsFile = sessionFile(ws, input, '.edits');
  const edits = existsSync(editsFile) ? (JSON.parse(readFileSync(editsFile, 'utf8')) as Record<string, number>) : {};
  const k = loadKnowledge(ws), resolve = anchorResolver(ws);
  const owed = k.pieces.filter((p) => p.type !== 'flow' && p.type !== 'convention' && Object.entries(edits).some(([key, t]) => {
    const [repo, ...rest] = key.split(':');
    // reviewed: its file was written after the first edit of the file it describes
    return (p.anchors ?? []).some((a) => anchorCovers(resolve, a, repo, rest.join(':'))) && statSync(join(ws.root, p.path)).mtimeMs < t;
  }));
  if (!errors.length && !owed.length) return null;
  return { decision: 'block', reason: [
    ...(errors.length ? [`laru check has ${errors.length} error(s) in the documentation; fix them before finishing:`, ...errors.slice(0, 10).map((e) => `- ${e.path}: ${e.message}`)] : []),
    ...(owed.length ? ['You edited code these pieces describe; check they still hold and update them with knowledge_write (or knowledge_verify when they do) before finishing:', ...owed.slice(0, 10).map((p) => `- ${p.id} «${p.title}» (${p.path})`)] : []),
  ].join('\n') };
}
