/**
 * The pieces' titles by id: a piece's id in a text of the documentation (`flow:registro-e-inicio`, `[[mod:carpetas]]`)
 * reads as its title and opens it, its id in the tooltip (lib/md.tsx). Set as the documentation loads, apart from the
 * Markdown renderer so the shell does not load it; an id no piece has stays as written.
 */
export let titles = new Map<string, string>();
let known: unknown;
export function knowPieces(pieces: ReadonlyArray<{ id: string; title: string }>) {
  if (pieces === known) return;
  known = pieces;
  titles = new Map(pieces.map((p) => [p.id, p.title]));
}

/** A bare id in prose (`flow:x`), not inside a word, a path, a URL or a link already. */
export const BARE = /(^|[^\w[(/:.@-])([a-z][a-z0-9]*:[a-z0-9][a-z0-9-]*)(?![\w-])/g;
/** `[[id]]`, and the id of a known piece written bare, as a Markdown link of Laru's own scheme (`laru:<id>`). Text, not code: the caller keeps code apart. */
export const refLinks = (text: string) => text
  .replace(/\[\[([^\]\n]+)\]\]/g, (_, id: string) => `[${id}](laru:${encodeURIComponent(id)})`)
  .replace(BARE, (all, pre: string, id: string) => (titles.has(id) ? `${pre}[${id}](laru:${encodeURIComponent(id)})` : all));
