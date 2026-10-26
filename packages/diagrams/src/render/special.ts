/**
 * The three classes whose Mermaid dialect is not a box-and-arrow one: a roadmap (`gantt`), the branches and releases of a
 * repository (`gitGraph`) and the classes of a piece of code (`classDiagram`). They are read and drawn here, in the same
 * ground, tones and face as every other sheet, so none of them falls back to a code block.
 */
import { FONT, PAPER, TITLE_INK, TONES } from './sheet.ts';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const INK2 = '#C1C4CB', LINE = '#3A3E46';

/** The title of a text: its frontmatter (`--- title: X ---`) or a `title X` line. */
function titleOf(code: string): string {
  return /^---\s*\n[\s\S]*?title:\s*(.+?)\s*\n[\s\S]*?---/.exec(code)?.[1] ?? /^\s*title\s+(.+)$/m.exec(code)?.[1]?.trim() ?? '';
}
const body = (code: string) => code.replace(/^---[\s\S]*?---\s*\n/, '').split('\n');
const wrap = (w: number, h: number, inner: string, title: string, id: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" role="img" width="${Math.round(w)}" height="${Math.round(h)}" viewBox="0 0 ${Math.round(w)} ${Math.round(h)}" class="pd-diagram" font-family="${esc(FONT)}">`
  + `<title>${esc(title || id)}</title><rect width="${Math.round(w)}" height="${Math.round(h)}" fill="${PAPER}"/>`
  + (title ? `<text x="28" y="40" font-size="24" font-weight="600" fill="${TITLE_INK}">${esc(title)}</text>` : '') + inner + '</svg>';

/** Which of the three a text is, from its first line. */
export const specialDialect = (code: string): 'gantt' | 'gitGraph' | 'classDiagram' | undefined => {
  const first = body(code).map((l) => l.trim()).find((l) => l && !l.startsWith('%%'));
  return first === 'gantt' || first === 'gitGraph' || first === 'classDiagram' ? first : undefined;
};

/* ---- gantt ---- */
interface Task { name: string; section: string; start: number; days: number; state: 'done' | 'active' | 'crit' | 'todo'; id: string; milestone: boolean }
const DAY = 86_400_000;

function ganttOf(lines: string[]): { tasks: Task[]; sections: string[] } {
  const tasks: Task[] = [], sections: string[] = [];
  let section = '';
  const byId = new Map<string, Task>();
  // a date that does not exist (2026-13-45, 2026-02-30) would reach the sheet as NaN
  const date = (tok: string, n: number) => {
    const t = Date.parse(tok);
    if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== tok) throw new Error(`gantt line ${n + 1}: «${tok}» is not a date`);
    return t / DAY;
  };
  for (const [n, raw] of lines.entries()) {
    const l = raw.trim();
    if (!l || l.startsWith('%%') || /^(gantt|title|axisFormat|todayMarker)\b/.test(l)) continue;
    // a format or a calendar this reader does not apply would draw dates that are not the ones written
    const fmt = /^dateFormat\s+(.+)$/.exec(l);
    if (fmt) { if (fmt[1].trim() !== 'YYYY-MM-DD') throw new Error(`gantt line ${n + 1}: dateFormat ${fmt[1].trim()} is not read (only YYYY-MM-DD)`); continue; }
    if (/^(excludes|includes|weekend|tickInterval)\b/.test(l)) throw new Error(`gantt line ${n + 1}: «${l.split(/\s/)[0]}» changes the dates and is not read`);
    const sec = /^section\s+(.+)$/.exec(l);
    if (sec) { section = sec[1]; sections.push(section); continue; }
    const t = /^(.+?)\s*:\s*(.*)$/.exec(l);
    if (!t) throw new Error(`gantt line ${n + 1} not understood: ${l}`);
    let state: Task['state'] = 'todo', id = '', start: number | undefined, end: number | undefined, days: number | undefined, milestone = false;
    for (const tok of t[2].split(',').map((x) => x.trim()).filter(Boolean)) {
      if (/^(done|active|crit|milestone)$/.test(tok)) { if (tok === 'milestone') milestone = true; else state = tok as Task['state']; }
      else if (/^\d{4}-\d{2}-\d{2}$/.test(tok)) { if (start === undefined) start = date(tok, n); else end = date(tok, n); }
      else if (/^after\s+\w+$/.test(tok)) { const p = byId.get(tok.slice(6).trim()); if (!p) throw new Error(`gantt line ${n + 1}: «${tok}» names a task that is not above it`); start = p.start + p.days; }
      else if (/^\d+[dwmy]$/.test(tok)) days = Number(tok.slice(0, -1)) * { d: 1, w: 7, m: 30, y: 365 }[tok.slice(-1) as 'd'];
      else if (/^\w+$/.test(tok) && !id) id = tok;
      else throw new Error(`gantt line ${n + 1}: «${tok}» is not a tag, an id, a date or a duration`);
    }
    const prev = tasks.at(-1);
    // Mermaid starts a task where the one above ended; a first task with no date has nowhere to start
    if (start === undefined && !prev) throw new Error(`gantt line ${n + 1}: «${t[1].trim()}» has no start date`);
    const from = start ?? (prev!.start + prev!.days);
    if (end !== undefined && end < from) throw new Error(`gantt line ${n + 1}: «${t[1].trim()}» ends before it starts`);
    const task = { name: t[1].trim(), section, start: from, days: end !== undefined ? Math.max(1, end - from) : days ?? 1, state, id, milestone };
    tasks.push(task);
    if (id) byId.set(id, task);
  }
  return { tasks, sections };
}

export function drawGantt(code: string, idPrefix = 'pd'): string {
  const { tasks, sections } = ganttOf(body(code));
  if (!tasks.length) throw new Error('a roadmap with no tasks draws nothing');
  if (tasks.some((t) => !Number.isFinite(t.start) || !Number.isFinite(t.days))) throw new Error('a task of the roadmap has no date the sheet can place');
  const lo = Math.min(...tasks.map((t) => t.start)), hi = Math.max(...tasks.map((t) => t.start + t.days));
  const span = Math.max(30, hi - lo), left = 280, right = 40, W = 1000, plot = W - left - right, x = (d: number) => left + ((d - lo) / span) * plot;
  const rowH = 34, top = 90;
  let y = top, out = '';
  // the axis: a line a month
  const first = new Date(lo * DAY), tick0 = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1) / DAY;
  const ticks: string[] = [];
  for (let d = tick0, n = 0; d <= hi && n < 60; n++) {
    const dt = new Date(d * DAY);
    if (d >= lo - 1) ticks.push(`<line x1="${x(d)}" x2="${x(d)}" y1="${top - 10}" y2="PLOT_END" stroke="${LINE}" stroke-dasharray="3 5"/><text x="${x(d) + 4}" y="${top - 16}" font-size="11" fill="${INK2}">${dt.toLocaleDateString('es', { month: 'short', year: '2-digit', timeZone: 'UTC' })}</text>`);
    d = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 1) / DAY;
  }
  const colour = (s: Task['state']) => ({ done: TONES.runtime, active: TONES.subject, crit: TONES.gate, todo: TONES.step })[s];
  for (const s of sections.length ? sections : ['']) {
    if (s) { out += `<text x="28" y="${y + 20}" font-size="12" font-weight="600" fill="${INK2}" letter-spacing="1">${esc(s.toUpperCase())}</text>`; y += 30; }
    for (const t of tasks.filter((k) => k.section === s)) {
      const c = colour(t.state), x0 = x(t.start), x1 = Math.max(x(t.start + t.days), x0 + 12);
      out += `<text x="40" y="${y + 20}" font-size="14" fill="${TITLE_INK}">${esc(t.name)}</text>`;
      out += t.milestone
        ? `<path d="M${x0} ${y + 6} l9 9 -9 9 -9 -9 z" fill="${c.band}" stroke="${c.stroke}"/>`
        : `<rect x="${x0}" y="${y + 6}" width="${x1 - x0}" height="18" rx="5" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.5"/>`;
      y += rowH;
    }
  }
  const end = y + 10;
  return wrap(W, end + 30, ticks.join('').replace(/PLOT_END/g, String(end)) + out, titleOf(code), idPrefix + '-roadmap');
}

/* ---- gitGraph ---- */
interface Commit { i: number; branch: string; id: string; tag?: string; parents: number[] }

export function drawGitGraph(code: string, idPrefix = 'pd'): string {
  const branches = ['main'], commits: Commit[] = [], head = new Map<string, number>(), start = new Map<string, number>();
  let cur = 'main', n = 0;
  const add = (branch: string, id: string, tag?: string, extra?: number) => {
    const parents = [head.get(branch) ?? start.get(branch), extra].filter((p): p is number => p !== undefined);
    commits.push({ i: commits.length, branch, id, tag, parents });
    head.set(branch, commits.length - 1);
  };
  for (const raw of body(code)) {
    const l = raw.trim();
    if (!l || l === 'gitGraph' || l.startsWith('%%')) continue;
    const q = (k: string) => new RegExp(`${k}:\\s*"([^"]*)"`).exec(l)?.[1];
    let m: RegExpExecArray | null;
    const name = (w: string) => w.replace(/^"|"$/g, '');
    if (/^commit\b/.test(l)) add(cur, q('id') ?? `c${++n}`, q('tag'));
    else if ((m = /^branch\s+(\S+)/.exec(l))) { const b = name(m[1]); if (branches.includes(b)) throw new Error(`gitGraph: branch ${b} is created twice`); branches.push(b); const from = head.get(cur) ?? start.get(cur); if (from !== undefined) start.set(b, from); cur = b; }
    else if ((m = /^(?:checkout|switch)\s+(\S+)/.exec(l))) { const b = name(m[1]); if (!branches.includes(b)) throw new Error(`gitGraph: checkout of ${b}, a branch that does not exist`); cur = b; }
    else if ((m = /^merge\s+(\S+)/.exec(l))) { const b = name(m[1]); if (!branches.includes(b)) throw new Error(`gitGraph: merge of ${b}, a branch that does not exist`); if (head.get(b) === undefined) throw new Error(`gitGraph: ${b} has no commits to merge`); add(cur, `merge ${b}`, q('tag'), head.get(b)); }
    else throw new Error(`gitGraph: «${l.split(/\s/)[0]}» is not read`);
  }
  if (!commits.length) throw new Error('a repository with no commits draws nothing');
  const lane = (b: string) => 90 + branches.indexOf(b) * 56, cx = (i: number) => 150 + i * 78;
  const W = cx(commits.length) + 60, H = 90 + branches.length * 56 + 30;
  const tone = (b: string) => [TONES.subject, TONES.runtime, TONES.channel, TONES.part, TONES.store, TONES.actor][branches.indexOf(b) % 6];
  let out = '';
  for (const b of branches) out += `<line x1="130" x2="${W - 30}" y1="${lane(b)}" y2="${lane(b)}" stroke="${LINE}" stroke-dasharray="2 6"/><text x="28" y="${lane(b) + 5}" font-size="13" font-weight="600" fill="${tone(b).stroke}">${esc(b)}</text>`;
  for (const c of commits) for (const p of c.parents) {
    const a = commits[p], col = tone(c.branch).stroke;
    out += a.branch === c.branch
      ? `<line x1="${cx(a.i)}" y1="${lane(a.branch)}" x2="${cx(c.i)}" y2="${lane(c.branch)}" stroke="${col}" stroke-width="2.5"/>`
      : `<path d="M${cx(a.i)} ${lane(a.branch)} C${cx(a.i) + 40} ${lane(a.branch)} ${cx(c.i) - 40} ${lane(c.branch)} ${cx(c.i)} ${lane(c.branch)}" fill="none" stroke="${tone(a.branch).stroke}" stroke-width="2.5"/>`;
  }
  for (const c of commits) {
    const t = tone(c.branch);
    out += `<circle cx="${cx(c.i)}" cy="${lane(c.branch)}" r="9" fill="${t.fill}" stroke="${t.stroke}" stroke-width="2.5"/>`;
    out += `<text x="${cx(c.i)}" y="${lane(c.branch) - 16}" font-size="11" fill="${INK2}" text-anchor="middle">${esc(c.id)}</text>`;
    if (c.tag) out += `<rect x="${cx(c.i) - 26}" y="${lane(c.branch) + 14}" width="52" height="18" rx="9" fill="${TONES.channel.fill}" stroke="${TONES.channel.stroke}"/><text x="${cx(c.i)}" y="${lane(c.branch) + 27}" font-size="11" fill="${TONES.channel.ink}" text-anchor="middle">${esc(c.tag)}</text>`;
  }
  return wrap(W, H, out, titleOf(code), idPrefix + '-versioning');
}

/* ---- classDiagram ---- */
export function drawClasses(code: string, idPrefix = 'pd'): string {
  const classes = new Map<string, string[]>(), rels: Array<{ a: string; b: string; arrow: string; from?: string; to?: string; label?: string }> = [];
  let open: string | undefined;
  for (const [n, raw] of body(code).entries()) {
    const l = raw.trim();
    if (!l || l === 'classDiagram' || l.startsWith('%%') || /^direction\s+(TB|BT|LR|RL)$/.test(l)) continue;
    let m: RegExpExecArray | null;
    if (open) { if (l === '}') open = undefined; else classes.get(open)!.push(l); continue; }
    if ((m = /^class\s+(\w+)(?:~[^~]*~)?\s*(\{)?$/.exec(l))) { classes.set(m[1], classes.get(m[1]) ?? []); if (m[2]) open = m[1]; continue; }
    // `Order : +string id` is a member written outside the braces
    if ((m = /^(\w+)\s*:\s*(.+)$/.exec(l)) && !/(--|\.\.)/.test(l)) { classes.set(m[1], [...(classes.get(m[1]) ?? []), m[2].trim()]); continue; }
    if ((m = /^(\w+)\s+(?:"([^"]*)"\s+)?([<|*o]*(?:--|\.\.)[>|*o]*)\s+(?:"([^"]*)"\s+)?(\w+)(?:\s*:\s*(.*))?$/.exec(l))) {
      for (const k of [m[1], m[5]]) if (!classes.has(k)) classes.set(k, []);
      rels.push({ a: m[1], b: m[5], arrow: m[3], from: m[2], to: m[4], label: m[6] });
      continue;
    }
    // a note, a namespace, a click or a style would be drawn as if it were not there
    throw new Error(`classDiagram line ${n + 1} not understood: ${l}`);
  }
  if (open) throw new Error(`classDiagram: the class ${open} is never closed with }`);
  if (!classes.size) throw new Error('a class diagram with no classes draws nothing');
  const names = [...classes.keys()], cols = Math.ceil(Math.sqrt(names.length)), bw = 200, gapX = 90, gapY = 70, top = 80;
  const rows = Math.ceil(names.length / cols);
  const boxes = new Map<string, { x: number; y: number; h: number }>();
  const hOf = (k: string) => 34 + Math.max(1, classes.get(k)!.length) * 19 + 8;
  let y = top;
  for (let r = 0; r < rows; r++) {
    const row = names.slice(r * cols, (r + 1) * cols), rh = Math.max(...row.map(hOf));
    row.forEach((k, c) => boxes.set(k, { x: 28 + c * (bw + gapX), y, h: hOf(k) }));
    y += rh + gapY;
  }
  const W = 28 + cols * (bw + gapX), H = y;
  const edge = (k: string, toward: { x: number; y: number }) => {
    const b = boxes.get(k)!, cxk = b.x + bw / 2, cyk = b.y + b.h / 2, dx = toward.x - cxk, dy = toward.y - cyk;
    const s = Math.min(dx ? (bw / 2) / Math.abs(dx) : Infinity, dy ? (b.h / 2) / Math.abs(dy) : Infinity);
    return { x: cxk + dx * s, y: cyk + dy * s };
  };
  const centre = (k: string) => ({ x: boxes.get(k)!.x + bw / 2, y: boxes.get(k)!.y + boxes.get(k)!.h / 2 });
  let out = `<defs><marker id="${idPrefix}-tri" viewBox="0 0 12 10" refX="11" refY="5" markerWidth="12" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0 0 L12 5 L0 10 z" fill="${PAPER}" stroke="${INK2}"/></marker><marker id="${idPrefix}-arr" viewBox="0 0 10 8" refX="9" refY="4" markerWidth="10" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0 0 L10 4 L0 8" fill="none" stroke="${INK2}" stroke-width="1.6"/></marker><marker id="${idPrefix}-dia" viewBox="0 0 14 10" refX="13" refY="5" markerWidth="14" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0 5 L7 0 L14 5 L7 10 z" fill="${INK2}" stroke="${INK2}"/></marker></defs>`;
  for (const r of rels) {
    const p = edge(r.a, centre(r.b)), q = edge(r.b, centre(r.a));
    const end = /[|]>$|<[|]/.test(r.arrow) ? 'tri' : /[*o]$|^[*o]/.test(r.arrow) ? 'dia' : 'arr';
    const toB = /[>|*o]$/.test(r.arrow), toA = /^[<|*o]/.test(r.arrow);
    out += `<line x1="${p.x}" y1="${p.y}" x2="${q.x}" y2="${q.y}" stroke="${INK2}" stroke-width="1.5"${r.arrow.includes('..') ? ' stroke-dasharray="6 4"' : ''}${toB ? ` marker-end="url(#${idPrefix}-${end})"` : ''}${toA ? ` marker-start="url(#${idPrefix}-${end})"` : ''}/>`;
    if (r.from) out += `<text x="${p.x + (q.x - p.x) * 0.14}" y="${p.y + (q.y - p.y) * 0.14 - 6}" font-size="11" fill="${INK2}" text-anchor="middle">${esc(r.from)}</text>`;
    if (r.to) out += `<text x="${p.x + (q.x - p.x) * 0.86}" y="${p.y + (q.y - p.y) * 0.86 - 6}" font-size="11" fill="${INK2}" text-anchor="middle">${esc(r.to)}</text>`;
    if (r.label) out += `<text x="${(p.x + q.x) / 2}" y="${(p.y + q.y) / 2 - 6}" font-size="11" fill="${INK2}" text-anchor="middle">${esc(r.label)}</text>`;
  }
  for (const [k, members] of classes) {
    const b = boxes.get(k)!, t = TONES.part;
    out += `<g><rect x="${b.x}" y="${b.y}" width="${bw}" height="${b.h}" rx="8" fill="${t.fill}" stroke="${t.stroke}" stroke-width="1.75"/>`
      + `<text x="${b.x + bw / 2}" y="${b.y + 22}" font-size="15" font-weight="600" fill="${t.ink}" text-anchor="middle">${esc(k)}</text>`
      + `<line x1="${b.x}" x2="${b.x + bw}" y1="${b.y + 32}" y2="${b.y + 32}" stroke="${t.stroke}" opacity="0.5"/>`
      + members.map((m, i) => `<text x="${b.x + 14}" y="${b.y + 52 + i * 19}" font-size="12.5" fill="${t.ink}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">${esc(m)}</text>`).join('') + '</g>';
  }
  return wrap(W, H, out, titleOf(code), idPrefix + '-class');
}
