/**
 * The session's notices, kept outside React: what happened (the bell's history) and what is on screen by itself (the
 * cards), with how loud each one is. components/Notices.tsx draws them; the shell's pulse adds them.
 */
import type { DotState } from '../components/ui.tsx';

export type NoticeKind = 'docker' | 'change' | 'run' | 'cleanup';
/** `id`: its own, never its time: two notices of one pulse share the millisecond. */
export interface Notice { id: number; at: number; kind: NoticeKind; title: string; detail?: string; files?: string[]; state: DotState; to?: string }
export type Level = 'alert' | 'info' | 'quiet';
/** How long a card stays by itself. */
export const STAY: Record<Level, number> = { alert: Infinity, info: 6000, quiet: 3500 };
const levelOf = (n: Pick<Notice, 'kind' | 'state'>): Level => (n.state === 'err' ? 'alert' : n.kind === 'change' ? 'quiet' : 'info');
export type Live = Notice & { level: Level };

let list: Notice[] = [], live: Live[] = [], seenAt = Date.now();
const subs = new Set<() => void>();
let snap = { list, live, seenAt };
const emit = () => { snap = { list, live, seenAt }; subs.forEach((f) => f()); };
export const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
export const notices = () => snap;
/** Opening the bell: what came before now is seen. */
export const markSeen = () => { seenAt = Date.now(); emit(); };
export const clearNotices = () => { list = []; emit(); };
/** A change right after another (an agent writing several files, a file saved twice) adds to the one before instead of repeating it. */
let ids = 0;
export function notify(n: Omit<Notice, 'at' | 'id'>) {
  const now = Date.now(), last = list[0], id = ++ids;
  const merge = n.kind === 'change' && last?.kind === 'change' && now - last.at < 60_000;
  // a merged change is a new card (its own time on screen), with the files of both
  const made: Notice = merge ? { ...last, id, at: now, files: [...new Set([...(n.files ?? []), ...(last.files ?? [])])] } : { ...n, id, at: now };
  list = merge ? [made, ...list.slice(1)] : [made, ...list].slice(0, 50);
  // on screen: a change replaces the change card; Docker back takes the alert that it went away
  live = live.filter((x) => !(made.kind === 'change' && x.kind === 'change') && !(made.kind === 'docker' && x.kind === 'docker'));
  live = [{ ...made, level: levelOf(made) }, ...live];
  emit();
}
export const dismiss = (id: number) => { live = live.filter((x) => x.id !== id); emit(); };
