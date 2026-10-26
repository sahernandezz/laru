/** The SQL editor's two pure helpers: suggestions from the real schema, and results as CSV. */
import type { Table } from '@laru/runtime';

/**
 * What to offer for the word before the caret: `schema.` lists its tables, `table.` its columns, and a bare word
 * matches tables (inserted with their schema unless it is public), schemas, and the columns of the tables the
 * query already names. Null when there is nothing to offer.
 */
export function suggest(sql: string, caret: number, tables: Table[], max = 8): { from: number; items: string[] } | null {
  const word = /[\w.$]+$/.exec(sql.slice(0, caret))?.[0];
  if (!word || /^\d/.test(word)) return null;
  const lower = word.toLowerCase();
  const full = (t: Table) => (t.schema === 'public' ? t.name : `${t.schema}.${t.name}`);
  const items: string[] = [];
  const dot = word.lastIndexOf('.');
  if (dot >= 0) {
    const head = lower.slice(0, dot), prefix = word.slice(0, dot + 1);
    for (const t of tables) {
      if (t.schema.toLowerCase() === head) items.push(`${t.schema}.${t.name}`);
      if (t.name.toLowerCase() === head || `${t.schema}.${t.name}`.toLowerCase() === head) items.push(...t.columns.map((c) => prefix + c.name));
    }
  } else {
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const named = tables.filter((t) => new RegExp(`(^|[^\\w.])(${esc(t.schema)}\\.)?${esc(t.name)}\\b`, 'i').test(sql));
    for (const t of tables) if (t.name.toLowerCase().startsWith(lower) || full(t).toLowerCase().startsWith(lower)) items.push(full(t));
    for (const s of new Set(tables.map((t) => t.schema))) if (s.toLowerCase().startsWith(lower)) items.push(`${s}.`);
    for (const t of named) for (const c of t.columns) if (c.name.toLowerCase().startsWith(lower)) items.push(c.name);
  }
  const out = [...new Set(items)].filter((x) => x.toLowerCase().startsWith(lower) || dot < 0).filter((x) => x.toLowerCase() !== lower).slice(0, max);
  return out.length ? { from: caret - word.length, items: out } : null;
}

/** RFC 4180, with NULL as an empty field and '' as a quoted empty one: the same rule psql uses. */
export function toCsv(columns: string[], rows: Array<Array<string | null>>): string {
  const cell = (v: string | null) => (v === null ? '' : v === '' || /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [columns, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
