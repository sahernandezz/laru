/**
 * The editor by fields: a form generated from the standard, validated live against the same rules the AI's
 * writes go through, saved only when there is no error. Nobody edits free Markdown here.
 */
import { PenTool, Plus, Save, Trash2, X } from 'lucide-react';
import { DiagramEditor } from '../components/DiagramEditor.tsx';
import { mermaidBlocks } from '@laru/diagrams';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type DocNote, type DocPiece, type Issue, type KnowledgeData, type Shape, type WriteInput, type WriteResult } from '../api.ts';
import { toast } from '../components/ui.tsx';
import { issueText, KIND, pieceLabel, STATUS } from '../lib/es.ts';
import { pageOf } from '../lib/route.ts';
import { Diagram } from '../lib/md.tsx';
import { noteLevel } from './Docs.tsx';
import { iconOf } from '../lib/pieceMenu.tsx';

type Row = Record<string, string>;

export function PieceForm({ k, piece, type, parent, presetId, done }: { k: KnowledgeData; piece?: DocPiece; type?: string; parent?: string; presetId?: string; done: (id: string) => void }) {
  const shape: Shape | undefined = k.shapes[(piece?.type ?? type) as keyof typeof k.shapes];
  const initial: WriteInput = useMemo(() => piece
    ? { type: piece.type, id: piece.id, title: piece.title, kind: piece.kind, status: piece.status, summary: piece.summary, owner: piece.owner, anchors: piece.anchors, meta: piece.meta, relations: piece.relations, fields: piece.fields as WriteInput['fields'] }
    : { type: (type ?? 'note') as WriteInput['type'], id: presetId, in: parent === '-' ? undefined : parent, title: presetId ? presetId.split(':')[1] : '', kind: shape?.kinds?.[0], status: shape?.statuses[0], summary: '', fields: {} }, [piece, type, parent, presetId, shape]);
  const [v, setV] = useState<WriteInput>(initial);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [note, setNote] = useState<DocNote | undefined>(piece?.note);
  const [saving, setSaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => setV(initial), [initial]);
  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => api<WriteResult>('/api/knowledge/validate', { method: 'POST', body: v }).then((r) => { setIssues(r.issues); if (r.note) setNote(r.note); }).catch(() => {}), 350);
    return () => clearTimeout(timer.current);
  }, [v]);
  if (!shape) return <div className="page"><div className="notice">No existe el tipo «{type}».</div></div>;

  const at = (prefix: string) => issues.filter((i) => i.at === prefix || i.at.startsWith(prefix + '[') || i.at.startsWith(prefix + '.'));
  const errors = issues.filter((i) => i.level === 'error');
  const owes = (name: string) => note?.owed.some((o) => o.at === `fields.${name}`);
  const set = (patch: Partial<WriteInput>) => setV((x) => ({ ...x, ...patch }));
  const setField = (name: string, value: unknown) => setV((x) => ({ ...x, fields: { ...x.fields, [name]: value as never } }));
  // the diagram being edited: its field, the classes the field expects, and the block it replaces (none: a new one at the end)
  const [editing, setEditing] = useState<{ field: string; kinds?: string[]; block?: { start: number; end: number; lang: string } } | null>(null);
  const applyDiagram = (code: string) => {
    if (!editing) return;
    const text = String(v.fields[editing.field] ?? ''), b = editing.block;
    const fenced = `\`\`\`${b?.lang ?? 'mermaid'}\n${code.replace(/\s+$/, '')}\n\`\`\``;
    setField(editing.field, b ? text.slice(0, b.start) + fenced + text.slice(b.end) : `${text.replace(/\s+$/, '')}${text.trim() ? '\n\n' : ''}${fenced}`);
    setEditing(null);
  };
  const Icon = iconOf({ type: shape.type, kind: v.kind });
  const save = async () => {
    setSaving(true);
    try {
      const r = await api<WriteResult>('/api/knowledge/write', { method: 'POST', body: v });
      setIssues(r.issues);
      if (r.ok) { toast(`Guardado en ${r.path}`); done(r.id); } else toast('No se guardó: corrige los errores marcados');
    } finally { setSaving(false); }
  };

  return (
    <div className="page">
      <nav className="crumbs"><a href={pageOf(piece?.id ?? parent ?? '')}>{piece ? piece.title : parent && parent !== '-' ? parent : 'Documentación'}</a><span>/</span><span>{piece ? 'Editar' : 'Nueva pieza'}</span></nav>
      <div className="head">
        <div><span className="type-badge"><Icon />{pieceLabel(shape.type)}</span><h1 style={{ marginTop: 10 }}>{v.title || 'Sin título'}</h1><p>{shape.question}</p></div>
        <div className="actions">
          {note && <span className={`note note-${noteLevel(note.score)}`} title={note.owed.length ? `Debe ${note.owed.length}` : undefined}><span aria-hidden>{note.score >= 80 ? '●' : note.score >= 50 ? '◐' : '○'}</span>Nota {note.score}</span>}
          <a className="btn" href={pageOf(piece?.id ?? (parent && parent !== '-' ? parent : ''))}><X />Cancelar</a>
          <button className="btn primary" disabled={saving || errors.length > 0} onClick={save} title={errors.length ? `${errors.length} errores por corregir` : undefined}><Save />{piece ? 'Guardar' : 'Crear'}</button>
        </div>
      </div>
      {errors.length > 0 && <div className="notice"><div><b>{errors.length} {errors.length === 1 ? 'error impide' : 'errores impiden'} guardar.</b> Cada uno está junto a su campo.</div></div>}

      <section className="panel"><div className="body form">
        <Row2>
          <Input label="Título" value={v.title} onChange={(t) => set({ title: t })} issues={at('title')} />
          <Input label="Id" value={v.id ?? ''} placeholder={`${shape.prefix}se-deriva-del-título`} onChange={(t) => set({ id: t || undefined })} issues={at('id')} mono disabled={Boolean(piece)} />
        </Row2>
        <Input label="Resumen" hint="Una frase. La IA la lee para decidir si abre la pieza." value={v.summary} onChange={(t) => set({ summary: t })} issues={at('summary')} />
        <Row2>
          {shape.kinds && <Choice label="Clase" options={shape.kinds} value={v.kind} render={(o) => KIND[o] ?? o} onChange={(o) => set({ kind: o })} issues={at('kind')} />}
          <Choice label="Estado" options={shape.statuses} value={v.status} render={(o) => STATUS[o] ?? o} onChange={(o) => set({ status: o })} issues={at('status')} />
        </Row2>
        <Row2>
          <Input label="Dueño" hint="Un equipo o un papel, nunca una persona." value={v.owner ?? ''} onChange={(t) => set({ owner: t || undefined })} issues={at('owner')} />
          {!piece && <Input label="Vive en" value={v.in ?? ''} onChange={(t) => set({ in: t || undefined })} issues={at('in')} mono hint={`Un contenedor: ${shape.livesIn.map((t) => pieceLabel(t).toLowerCase()).join(', ') || 'ninguno, es la raíz'}.`} />}
        </Row2>
        {shape.anchors !== 'no' && <Lines label="Anclas al código" hint="Una por línea: repo:ruta/o/glob/**" mono value={v.anchors ?? []} onChange={(l) => set({ anchors: l.length ? l : undefined })} issues={at('anchors')} />}
        {shape.meta?.map((m) => (
          <Input key={m.name} label={m.name} hint={m.hint} mono value={Array.isArray(v.meta?.[m.name]) ? (v.meta![m.name] as string[]).join(', ') : String(v.meta?.[m.name] ?? '')}
            onChange={(t) => set({ meta: { ...v.meta, [m.name]: m.list ? t.split(',').map((s) => s.trim()).filter(Boolean) : t } })} issues={at(m.name)} />
        ))}
      </div></section>

      {shape.fields.map((f) => (
        <section key={f.name} className="panel" style={{ marginTop: 16 }}>
          <header><h3>{f.heading}</h3>{f.required && <span className={`chip${owes(f.name) ? ' owed-chip' : ''}`} title="Si queda vacía se guarda igual, pero baja la nota del documento">{owes(f.name) ? 'Obligatoria · falta' : 'Obligatoria'}</span>}<div className="meta" style={{ maxWidth: '60%', textAlign: 'right' }}>{f.hintEs ?? f.hint}</div></header>
          <div className="body">
            {f.type === 'rows' ? <Rows columns={f.columns!} value={(v.fields[f.name] as Row[] | undefined) ?? []} onChange={(r) => setField(f.name, r)} issues={at(`fields.${f.name}`)} name={f.name} />
              : f.type === 'list' || f.type === 'refs' ? <Lines value={(v.fields[f.name] as string[] | undefined) ?? []} onChange={(l) => setField(f.name, l)} issues={at(`fields.${f.name}`)} hint="Uno por línea." />
              : <><Area value={(v.fields[f.name] as string | undefined) ?? ''} onChange={(t) => setField(f.name, t)} issues={at(`fields.${f.name}`)} max={f.max} />
                {f.diagram && mermaidBlocks(String(v.fields[f.name] ?? '')).map((b, n) => (
                  <div key={n} className="dg-inline">
                    <Diagram code={b.code} />
                    <button type="button" className="btn sm" onClick={() => setEditing({ field: f.name, kinds: f.kinds, block: b })}><PenTool />Editar el diagrama</button>
                  </div>
                ))}
                {f.diagram && <p className="faint dg-add"><button type="button" className="btn sm" onClick={() => setEditing({ field: f.name, kinds: f.kinds })}><Plus />{mermaidBlocks(String(v.fields[f.name] ?? '')).length ? 'Otro diagrama' : 'Añadir un diagrama'}</button>{f.diagram === 'required' && !mermaidBlocks(String(v.fields[f.name] ?? '')).length ? ' Esta sección lo exige.' : ''}</p>}</>}
          </div>
        </section>
      ))}
      {editing && <DiagramEditor code={editing.block ? mermaidBlocks(String(v.fields[editing.field] ?? '')).find((x) => x.start === editing.block!.start)?.code ?? '' : ''} kinds={editing.kinds} onApply={applyDiagram} onClose={() => setEditing(null)} />}
    </div>
  );
}

const Row2 = ({ children }: { children: React.ReactNode }) => <div className="row2">{children}</div>;
const Problems = ({ issues }: { issues: Issue[] }) => (issues.length ? <ul className="problems">{issues.map((i, n) => <li key={n} className={i.level}>{issueText(i)}</li>)}</ul> : null);

function Input({ label, value, onChange, issues, hint, mono, placeholder, disabled }: { label: string; value: string; onChange: (v: string) => void; issues: Issue[]; hint?: string; mono?: boolean; placeholder?: string; disabled?: boolean }) {
  return (
    <label className={`fld${issues.some((i) => i.level === 'error') ? ' bad' : ''}`}>
      <span className="l">{label}</span>
      <input className={mono ? 'mono' : undefined} value={value} placeholder={placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      {hint && <span className="h">{hint}</span>}
      <Problems issues={issues} />
    </label>
  );
}

function Area({ value, onChange, issues, max }: { value: string; onChange: (v: string) => void; issues: Issue[]; max?: number }) {
  return (
    <div className={`fld${issues.some((i) => i.level === 'error') ? ' bad' : ''}`}>
      <textarea value={value} rows={Math.min(14, Math.max(4, value.split('\n').length + 1))} onChange={(e) => onChange(e.target.value)} />
      {max && <span className="h num">{value.length} / {max}</span>}
      <Problems issues={issues} />
    </div>
  );
}

function Lines({ label, value, onChange, issues, hint, mono }: { label?: string; value: string[]; onChange: (v: string[]) => void; issues: Issue[]; hint?: string; mono?: boolean }) {
  const [text, setText] = useState(value.join('\n'));
  useEffect(() => { if (text.split('\n').filter((l) => l.trim()).join('\n') !== value.join('\n')) setText(value.join('\n')); }, [value]); // eslint-disable-line
  return (
    <label className={`fld${issues.some((i) => i.level === 'error') ? ' bad' : ''}`}>
      {label && <span className="l">{label}</span>}
      <textarea className={mono ? 'mono' : undefined} value={text} rows={Math.max(3, text.split('\n').length + 1)} onChange={(e) => { setText(e.target.value); onChange(e.target.value.split('\n').map((l) => l.trim()).filter(Boolean)); }} />
      {hint && <span className="h">{hint}</span>}
      <Problems issues={issues} />
    </label>
  );
}

function Choice({ label, options, value, onChange, render, issues }: { label: string; options: string[]; value?: string; onChange: (v: string) => void; render: (o: string) => string; issues: Issue[] }) {
  return (
    <div className={`fld${issues.some((i) => i.level === 'error') ? ' bad' : ''}`} role="radiogroup" aria-label={label}>
      <span className="l">{label}</span>
      <div className="seg">{options.map((o) => <button key={o} type="button" role="radio" aria-checked={value === o} onClick={() => onChange(o)}>{render(o)}</button>)}</div>
      <Problems issues={issues} />
    </div>
  );
}

function Rows({ columns, value, onChange, issues, name }: { columns: NonNullable<Shape['fields'][number]['columns']>; value: Row[]; onChange: (v: Row[]) => void; issues: Issue[]; name: string }) {
  const cellIssues = (i: number, c: string) => issues.filter((x) => x.at === `fields.${name}[${i}].${c}`);
  const update = (i: number, c: string, t: string) => onChange(value.map((r, n) => (n === i ? { ...r, [c]: t } : r)));
  return (
    <div className="rows-ed">
      <div className="scroll-x"><table className="t">
        <thead><tr>{columns.map((c) => <th key={c.name}>{c.heading}{c.required ? ' *' : ''}</th>)}<th /></tr></thead>
        <tbody>{value.map((r, i) => (
          <tr key={i}>{columns.map((c) => {
            const bad = cellIssues(i, c.name);
            return <td key={c.name} className={bad.length ? 'bad' : undefined}>
              <input className={c.ref || c.date ? 'mono' : undefined} value={r[c.name] ?? ''} placeholder={c.enum ? c.enum.join(' | ') : c.ref ? c.ref.join(' ') : c.date ? 'AAAA-MM-DD' : ''} onChange={(e) => update(i, c.name, e.target.value)} aria-label={`${c.heading}, fila ${i + 1}`} />
              {bad.map((b, n) => <div key={n} className="cell-problem">{issueText(b)}</div>)}
            </td>;
          })}<td style={{ width: 36 }}><button className="icon-btn" aria-label={`Quitar la fila ${i + 1}`} onClick={() => onChange(value.filter((_, n) => n !== i))}><Trash2 size={14} /></button></td></tr>
        ))}</tbody>
      </table></div>
      <button className="btn sm" style={{ marginTop: 10 }} onClick={() => onChange([...value, {}])}><Plus />Añadir fila</button>
      <Problems issues={issues.filter((x) => x.at === `fields.${name}`)} />
    </div>
  );
}
