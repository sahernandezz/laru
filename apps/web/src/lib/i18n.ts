/**
 * The interface in Spanish or English. The Spanish text is its own key: `tr('Guardar')` says «Guardar» in Spanish and
 * its entry of en.ts in English, and `{name}` in a text takes a value. A word with two meanings carries which one after
 * `@@` (`tr('Tema@@Kafka')`, a topic; `tr('Tema')`, the look): Spanish shows the word alone. The language is this browser's choice (Ajustes ›
 * Idioma), else the browser's own; a change reloads the page, so every text, the ones made when a module loads included,
 * comes out in the new one. test/i18n.test.ts holds every text of the sources to its English entry.
 */
import { createElement, Fragment, type ReactNode } from 'react';
import { EN } from './en.ts';

export type Lang = 'es' | 'en';
const KEY = 'laru.lang';

export const LANG: Lang = (() => {
  let kept: string | null = null;
  try { kept = localStorage.getItem(KEY); } catch { /* private window: the browser's language */ }
  if (kept === 'es' || kept === 'en') return kept;
  // outside a browser (the tests) the sources' own language
  return typeof document === 'undefined' || /^es\b/i.test(navigator.language) ? 'es' : 'en';
})();
/** For numbers, dates and lists */
export const LOCALE = LANG === 'es' ? 'es-ES' : 'en-US';
if (typeof document !== 'undefined') document.documentElement.lang = LANG;

export function setLang(lang: Lang) {
  try { localStorage.setItem(KEY, lang); } catch { /* private window: it lasts this page */ }
  location.reload();
}

const word = (key: string) => { const at = key.indexOf('@@'); return at < 0 ? key : key.slice(0, at); };
const said = (key: string) => (LANG === 'en' ? EN[key] ?? word(key) : word(key));

/** A text of the interface in its language, each `{name}` replaced by its value. */
export function tr(es: string, vars?: Record<string, unknown>): string {
  const s = said(es);
  return vars ? s.replace(/\{(\w+)\}/g, (all, k: string) => (Object.hasOwn(vars, k) ? String(vars[k] ?? '') : all)) : s;
}

/** The same, when a value is an element (a link, a code): what comes back is for JSX. */
export function trx(es: string, vars: Record<string, ReactNode>): ReactNode {
  return said(es).split(/(\{\w+\})/).map((part, i) => {
    const k = /^\{(\w+)\}$/.exec(part)?.[1];
    return k && Object.hasOwn(vars, k) ? createElement(Fragment, { key: i }, vars[k]) : part;
  });
}
