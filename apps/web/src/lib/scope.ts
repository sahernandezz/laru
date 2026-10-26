/**
 * The side menu narrows as you go in: a screen that belongs to one thing (a flow, a module, an environment) says so here,
 * and the shell swaps the general menu for «← back», that thing's card and its own sections.
 * It lives outside React's tree because the screen is rendered inside the shell, not around it.
 *
 * Screens register while they are mounted and the newest registration wins; leaving removes only one's own. A screen
 * with nothing to say (null) registers nothing, so it can never wipe the menu of another screen on the same page.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { DotState } from '../components/ui.tsx';

export interface Scope {
  back: { label: string; to: string };
  card: { icon?: LucideIcon; kind: string; title: string; sub?: string; state?: DotState };
  sections: Array<{ key: string; label: string; to: string; n?: number; icon?: LucideIcon; group?: string }>;
  active: string;
  /** the application's: it lights up its section in the main menu instead of replacing it */
  app?: boolean;
}

const stack: Array<{ id: symbol; scope: Scope }> = [];
let current: Scope | null = null;
const subs = new Set<() => void>();
const emit = () => { const top = stack.at(-1)?.scope ?? null; if (top !== current) { current = top; subs.forEach((f) => f()); } };

/** The icons are components (not data): they stay out of the key that decides whether the scope changed. */
const keyOf = (s: Scope | null) => JSON.stringify(s, (k, v) => (k === 'icon' ? undefined : v));

/** A screen declares its scope while it is on screen. */
export function useScope(s: Scope | null) {
  const id = useRef(Symbol('scope'));
  const key = keyOf(s);
  useEffect(() => {
    if (!s) return;
    const at = stack.findIndex((x) => x.id === id.current);
    if (at >= 0) stack[at] = { id: id.current, scope: s }; else stack.push({ id: id.current, scope: s });
    emit();
    return () => { const i = stack.findIndex((x) => x.id === id.current); if (i >= 0) stack.splice(i, 1); emit(); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
}

export const useCurrentScope = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => current);
