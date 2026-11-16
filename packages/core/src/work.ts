/**
 * How the agent works in this workspace: the person's own instructions, in their working agreement («Cómo se trabaja»):
 * anything they decided about how it works here (how it delivers, tests, names, asks), in their words. Not the
 * project's documentation, which says how the project is (its modules, rules, glossary, decisions).
 *
 * The agreement reaches the agent whole as its session starts. Its instructions, split by their headings, also reach it
 * at the moment each one is about: with each request that talks about it (`laru hook prompt`), and before a commit, a
 * push, a PR or a ticket (`laru hook pre-bash` stops it once and shows them); `laru rules` for an agent without hooks.
 */
import { loadAgreement } from './agreement.ts';
import type { Workspace } from './workspace.ts';

/** The moments of delivering, each with the commands that are it and the words an instruction about it uses. */
export const MOMENTS = [
  { key: 'commit', cmd: /\bgit\s+(-\S+\s+)*commit\b/, words: /\bcommits?\b/i },
  { key: 'push', cmd: /\bgit\s+(-\S+\s+)*push\b/, words: /\bpush\b|\bramas?\b|\bbranch(es)?\b/i },
  { key: 'pr', cmd: /\bgh\s+pr\s+(create|edit|merge|ready)\b|\bglab\s+mr\s+(create|update|merge)\b|\baz\s+repos\s+pr\s+(create|update)\b|\bhub\s+pull-request\b/, words: /\bPRs?\b|pull[\s-]?requests?|merge[\s-]?requests?|\bMRs?\b/i },
  { key: 'ticket', cmd: /\b(jira|acli)\b|\bgh\s+issue\s+(create|edit|comment|close)\b/, words: /\bjira\b|\btickets?\b|\bHUs?\b|historias? de usuario|\bsubtareas?\b|\bissues?\b/i },
] as const;
export type Moment = (typeof MOMENTS)[number]['key'];

/** One instruction of the person: a section of their agreement, by its heading. */
export interface Instruction { id: string; title: string; text: string }

/** The moments a shell command is (a `git commit && git push` is two). */
export const momentsOf = (cmd: string): Moment[] => MOMENTS.filter((m) => m.cmd.test(cmd)).map((m) => m.key);

const slug = (t: string) => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';

/** The person's instructions: their agreement's branches, and its instructions for the agent split by their headings. */
export function instructions(ws: Workspace): Instruction[] {
  const agr = loadAgreement(ws);
  if (!agr) return [];
  const out: Instruction[] = [];
  const add = (title: string, text: string) => {
    if (!text.trim()) return;
    let id = `agr#${slug(title)}`;
    for (let n = 2; out.some((x) => x.id === id); n++) id = `agr#${slug(title)}-${n}`;
    out.push({ id, title, text: text.trim() });
  };
  add('Ramas', String(agr.fields.branches ?? ''));
  const notes = String(agr.fields.notes ?? '');
  const heads = [...notes.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)];
  add('Instrucciones', heads.length ? notes.slice(0, heads[0].index) : notes);
  heads.forEach((h, i) => add(h[1], notes.slice(h.index + h[0].length, heads[i + 1]?.index ?? notes.length)));
  return out;
}

/** The instructions about these moments, or that name this very command (`cmd: <regex>` in their text). */
export function rulesFor(ws: Workspace, moments: Moment[], cmd?: string): Instruction[] {
  const words = MOMENTS.filter((m) => moments.includes(m.key)).map((m) => m.words);
  return instructions(ws).filter((s) => {
    if (cmd && [...s.text.matchAll(/`?cmd:\s*([^`\n]+)`?/g)].some((m) => { try { return new RegExp(m[1].trim()).test(cmd); } catch { return false; } })) return true;
    return words.some((re) => re.test(`${s.title}\n${s.text}`));
  });
}

/** What a text talks about: its words without accents, lowercase, of four letters or more, filler left out, each by its first five letters (documenta, documentación). */
const FILLER = new Set(['para', 'como', 'esta', 'este', 'esto', 'estos', 'estas', 'unos', 'unas', 'pero', 'todo', 'todos', 'toda', 'todas', 'hacer', 'dame', 'quiero', 'necesito', 'favor', 'sobre', 'desde', 'hasta', 'cuando', 'donde', 'tiene', 'tienen', 'cada', 'solo', 'sino', 'entre', 'luego', 'ahora', 'aqui', 'with', 'that', 'this', 'from', 'have', 'what', 'make', 'into', 'about', 'also', 'then', 'there', 'your', 'when', 'debe', 'deben', 'puede', 'pueden', 'cosas', 'algo', 'siempre', 'nunca', 'antes', 'despues']);
const stems = (t: string) => new Set((t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter((w) => !FILLER.has(w)).map((w) => w.slice(0, 5)));

/**
 * The instructions about what the person just asked: those about the moments it names (a PR, a commit, a Jira), then
 * those whose heading shares a word with it (a heading is what the section is about) or whose text shares two. Most
 * shared first.
 */
export function rulesForText(ws: Workspace, text: string): Instruction[] {
  const moments = MOMENTS.filter((m) => m.words.test(text)).map((m) => m.key);
  const byMoment = new Set(rulesFor(ws, moments).map((s) => s.id));
  const asked = stems(text);
  const shared = (t: string) => [...stems(t)].filter((w) => asked.has(w)).length;
  return instructions(ws)
    .map((s) => { const title = shared(s.title), body = shared(s.text); return { s, score: (byMoment.has(s.id) ? 10 : 0) + title * 2 + body, hit: byMoment.has(s.id) || title >= 1 || body >= 2 }; })
    .filter((x) => x.hit).sort((a, b) => b.score - a.score).map((x) => x.s);
}

/** An instruction whole, as the person wrote it. */
export const ruleText = (_ws: Workspace, s: Instruction) => `### ${s.title}\n${s.text}`;
