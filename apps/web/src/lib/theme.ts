/** The variants of Lusitania Laru can wear (their tokens are in styles.css). The choice is kept in this browser; index.html applies it before the first paint. */
export const THEMES = [
  { id: 'trench', name: 'Trench', light: false },
  { id: 'midnight', name: 'Midnight', light: false },
  { id: 'abyssal', name: 'Abyssal', light: false },
  { id: 'abyssal-deep', name: 'Abyssal Deep', light: false },
  { id: 'steel', name: 'Steel', light: false },
  { id: 'oceanic', name: 'Oceanic', light: false },
  { id: 'surface', name: 'Surface', light: true },
  { id: 'abyssal-light', name: 'Abyssal Light', light: true },
];
const KEY = 'laru.theme';

export const currentTheme = () => document.documentElement.dataset.theme ?? 'abyssal';
export const isLight = () => THEMES.some((t) => t.light && t.id === currentTheme());
export function setTheme(id: string) {
  document.documentElement.dataset.theme = id;
  try { localStorage.setItem(KEY, id); } catch { /* private window: it lasts this page */ }
}
