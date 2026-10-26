/**
 * What changed between two versions of a drawing.
 *
 * A `git diff` of a typed block says «this line changed» and a reader has to hold two
 * models in their head to work out what that meant. This says it in the words of the
 * drawing: a piece appeared, one went, one was renamed, one moved. That is what somebody
 * reviewing a change to an architecture actually wants to know, and it is the same question
 * the federation asks when a child's fingerprint changes.
 */
import type { DiagramEdge, DiagramModel, DiagramNode } from './model.ts';

export interface DiagramDelta {
  added: string[];
  removed: string[];
  /** Same piece, different name, technology, description or shape. */
  changed: Array<{ id: string; fields: string[] }>;
  /** Same piece, same everything, somewhere else. */
  moved: Array<{ id: string; dx: number; dy: number }>;
  edgesAdded: string[];
  edgesRemoved: string[];
  /** True when the two drawings say the same thing in the same place. */
  same: boolean;
}

const WATCHED: Array<keyof DiagramNode> = ['name', 'shape', 'technology', 'description', 'ref', 'parent', 'icon'];
const endsOf = (e: DiagramEdge) => `${e.from} → ${e.to}${e.label ? ` (${e.label})` : ''}`;

export function delta(before: DiagramModel, after: DiagramModel): DiagramDelta {
  const was = new Map(before.nodes.map((n) => [n.id, n]));
  const is = new Map(after.nodes.map((n) => [n.id, n]));

  const added = [...is.keys()].filter((id) => !was.has(id));
  const removed = [...was.keys()].filter((id) => !is.has(id));
  const changed: DiagramDelta['changed'] = [];
  const moved: DiagramDelta['moved'] = [];

  for (const [id, now] of is) {
    const then = was.get(id);
    if (!then) continue;
    const fields = WATCHED.filter((f) => (then[f] ?? '') !== (now[f] ?? ''));
    if (fields.length) changed.push({ id, fields: fields as string[] });
    const dx = Math.round(now.x - then.x);
    const dy = Math.round(now.y - then.y);
    if (dx !== 0 || dy !== 0) moved.push({ id, dx, dy });
  }

  const wasEdges = new Set(before.edges.map(endsOf));
  const isEdges = new Set(after.edges.map(endsOf));
  const edgesAdded = [...isEdges].filter((e) => !wasEdges.has(e));
  const edgesRemoved = [...wasEdges].filter((e) => !isEdges.has(e));

  return {
    added, removed, changed, moved, edgesAdded, edgesRemoved,
    same: !added.length && !removed.length && !changed.length && !moved.length && !edgesAdded.length && !edgesRemoved.length,
  };
}

/** The delta in one line per thing that happened, for a console or a report. */
export function deltaLines(d: DiagramDelta): string[] {
  const out: string[] = [];
  for (const id of d.added) out.push(`+ ${id}`);
  for (const id of d.removed) out.push(`- ${id}`);
  for (const c of d.changed) out.push(`~ ${c.id}: ${c.fields.join(', ')}`);
  for (const m of d.moved) out.push(`→ ${m.id} moved ${m.dx >= 0 ? '+' : ''}${m.dx}, ${m.dy >= 0 ? '+' : ''}${m.dy}`);
  for (const e of d.edgesAdded) out.push(`+ ${e}`);
  for (const e of d.edgesRemoved) out.push(`- ${e}`);
  return out;
}
