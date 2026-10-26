/**
 * The diagram editor: a class the engine draws is edited on Excalidraw's canvas (its tools, its
 * library, the class's own pieces); any class can be edited as text, with the drawing beside it as it is written. The
 * rules of the class are underneath either way. «Aplicar» hands the diagram back, as text, to the field it came from:
 * the piece is saved as any other edit, and the engine lays it out when it draws it.
 */
import { Check, CircleAlert, Code2, FileText, TriangleAlert, Waypoints, X } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { DIAGRAM_STANDARDS, dialectOf, emptyModel, emptySequence, fromMermaid, inSpanish, kindOfDialect, lintDiagramOfKind, paintsKind, parseSequence, SKINS, toMermaid, toSequence, type DiagramKind } from '@laru/diagrams';
import { ask } from '../lib/ask.ts';
import { Diagram } from '../lib/md.tsx';
import type { Drawing } from './ExcalidrawCanvas.tsx';

// Excalidraw is megabytes: it loads when a canvas is first opened, never with the page
const ExcalidrawCanvas = lazy(() => import('./ExcalidrawCanvas.tsx'));
/** A class the canvas edits: one the engine paints with a skin, and the sequence (its own bridge). */
const onCanvas = (k?: DiagramKind) => Boolean(k && (k === 'sequence' || (paintsKind(k) && SKINS[k as keyof typeof SKINS])));
/** The drawing of a text for a class, or why it cannot be one. */
function drawingOf(code: string, kind: DiagramKind): { drawing?: Drawing; why?: string } {
  if (kind === 'sequence') {
    const r = parseSequence(code.trim() || 'sequenceDiagram');
    return r.model ? { drawing: { ...(code.trim() ? r.model : emptySequence()), kind: 'sequence' } } : { why: 'la secuencia no se pudo leer' };
  }
  if (!code.trim()) return { drawing: emptyModel(kind) };
  const r = fromMermaid(code, kind);
  if (!r) return { why: 'este texto no es de esta clase' };
  if (r.unsupported.length) return { why: `el lienzo no sabe representar: ${r.unsupported.slice(0, 3).join('; ')}` };
  return { drawing: r.model };
}
const textOf = (d: Drawing) => (d.kind === 'sequence' ? toSequence(d as never) : toMermaid(d as never));

const authored = Object.values(DIAGRAM_STANDARDS).filter((c) => c.origin === 'authored').map(inSpanish);

export function DiagramEditor({ code: initial, kinds, onApply, onClose }: { code: string; kinds?: string[]; onApply: (code: string) => void; onClose: () => void }) {
  const [code, setCode] = useState(initial);
  // what is drawn follows the text a moment later, so typing never waits for the engine
  const [drawn, setDrawn] = useState(initial);
  useEffect(() => { const t = setTimeout(() => setDrawn(code), 250); return () => clearTimeout(t); }, [code]);
  const offered = kinds?.length ? authored.filter((c) => kinds.includes(c.kind)) : authored;
  const read = kindOfDialect(dialectOf(code));
  const [picked, setPicked] = useState<DiagramKind | undefined>(() => (read && offered.some((c) => c.kind === read) ? read : (offered[0]?.kind as DiagramKind | undefined)));
  const std = authored.find((c) => c.kind === picked);
  // the canvas first when the class has one and the text can be read onto it; the text otherwise, saying why
  const [mode, setMode] = useState<'canvas' | 'text'>(() => (onCanvas(picked) && drawingOf(initial, picked!).drawing ? 'canvas' : 'text'));
  const [drawing, setDrawing] = useState<Drawing | undefined>(() => (picked ? drawingOf(initial, picked).drawing : undefined));
  const [why, setWhy] = useState<string>();
  const toCanvas = (k = picked) => {
    if (!k) return;
    const r = drawingOf(code, k);
    if (!r.drawing) { setWhy(r.why); return; }
    setWhy(undefined); setDrawing(r.drawing); setMode('canvas');
  };
  const pick = (k: DiagramKind) => { setPicked(k); if (mode === 'canvas') { if (onCanvas(k)) { const r = drawingOf(code, k); setDrawing(r.drawing ?? (k === 'sequence' ? { ...emptySequence(), kind: 'sequence' } : emptyModel(k))); } else setMode('text'); } };
  const issues = useMemo(() => (picked && drawn.trim() ? lintDiagramOfKind(drawn, picked) : []), [drawn, picked]);
  const failing = new Set(issues.map((i) => i.rule));
  // the canvas writes the text back in its own form: that rewrite alone is not a change the person made
  const canonical = useMemo(() => { const d = picked && drawingOf(initial, picked).drawing; return d ? textOf(d) : initial; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = code !== initial && code !== canonical;
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (mode === 'text') area.current?.focus(); }, [mode]);

  // Tab indents (two spaces); Shift+Tab leaves the text, Esc goes to the bar (a second Esc closes), ⌘/Ctrl+Enter applies
  const apply = useRef<HTMLButtonElement>(null);
  const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); if (changed) onApply(code); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); (changed ? apply.current : apply.current?.previousElementSibling as HTMLElement | null)?.focus(); return; }
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      const t = e.currentTarget, a = t.selectionStart, b = t.selectionEnd;
      setCode(code.slice(0, a) + '  ' + code.slice(b));
      requestAnimationFrame(() => { t.selectionStart = t.selectionEnd = a + 2; });
    }
  };
  const close = async () => { if (!changed || await ask('Los cambios de este diagrama no se han aplicado a la pieza.', 'Cerrar y perderlos', 'Hay cambios sin aplicar')) onClose(); };

  return (
    <div className="dg-editor" role="dialog" aria-modal="true" aria-label="Editor de diagramas" onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); void close(); } }}>
      <header className="dg-bar">
        <b>Editor de diagramas</b>
        <label className="dg-kind"><span className="faint">Clase</span>
          <select value={picked ?? ''} onChange={(e) => pick(e.target.value as DiagramKind)}>
            {offered.map((c) => <option key={c.kind} value={c.kind}>{c.label}</option>)}
          </select>
        </label>
        {std && <span className="faint dg-q">{std.question}</span>}
        <span className="grow" />
        <div className="seg" role="group" aria-label="Cómo se edita">
          <button type="button" aria-pressed={mode === 'canvas'} disabled={!onCanvas(picked)} title={onCanvas(picked) ? 'Dibujarlo en el lienzo' : 'Esta clase se escribe como texto'} onClick={() => toCanvas()}><Waypoints />Lienzo</button>
          <button type="button" aria-pressed={mode === 'text'} onClick={() => setMode('text')}><Code2 />Texto</button>
        </div>
        {std && mode === 'text' && <button type="button" className="btn sm" onClick={async () => { if (!code.trim() || await ask('La plantilla sustituye todo el texto del diagrama.', 'Usar la plantilla', 'Sustituir el texto')) setCode(std.template.trim()); }}><FileText />Plantilla</button>}
        <button type="button" className="btn sm" onClick={close}><X />Cerrar</button>
        <button ref={apply} type="button" className="btn sm primary" aria-disabled={!changed || undefined} aria-keyshortcuts="Meta+Enter Control+Enter" onClick={() => changed && onApply(code)}><Check />Aplicar</button>
      </header>
      {why && <div className="notice warn dg-why" role="status"><TriangleAlert /><span>No se abre en el lienzo: {why}. Sigue en texto.</span><button type="button" className="btn sm" onClick={() => setWhy(undefined)}>Entendido</button></div>}
      {mode === 'canvas' && drawing && picked ? (
        <Suspense fallback={<div className="dg-loading">Abriendo el lienzo…</div>}>
          <ExcalidrawCanvas model={drawing} kind={picked} kinds={offered.filter((c) => onCanvas(c.kind as DiagramKind)).map((c) => ({ value: c.kind, label: c.label }))} onChangeKind={pick}
            issues={issues.map((i) => ({ text: authored.find((c) => c.kind === picked)?.rules.find((r) => r.id === i.rule)?.text ?? i.text, severity: i.severity }))}
            onChange={(d) => { setDrawing(d); setCode(textOf(d)); }} />
        </Suspense>
      ) : (
      <div className="dg-panes">
        <div className="dg-code">
          <textarea ref={area} className="mono" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={keys} spellCheck={false} aria-label="Texto del diagrama" aria-describedby="dg-keys" placeholder="flowchart LR&#10;  a[Inicio] --> b[Fin]" />
          <p id="dg-keys" className="dg-keys faint"><kbd>Tab</kbd> sangra · <kbd>⇧ Tab</kbd> o <kbd>Esc</kbd> salen del texto · <kbd>⌘ ↵</kbd> aplica</p>
        </div>
        <div className="dg-view" aria-live="polite">
          {drawn.trim() ? <Diagram code={drawn} kind={picked} /> : <p className="empty">Escribe el diagrama a la izquierda, o empieza por la plantilla de su clase.</p>}
        </div>
      </div>
      )}
      {std && (
        <footer className="dg-rules" aria-label={`Reglas de ${std.label}`}>
          <span className={`dg-sum ${issues.some((i) => i.severity === 'error') ? 'err' : issues.length ? 'warn' : 'ok'}`}>
            {issues.some((i) => i.severity === 'error') ? <CircleAlert /> : issues.length ? <TriangleAlert /> : <Check />}
            {issues.length ? `${issues.length} ${issues.length === 1 ? 'regla sin cumplir' : 'reglas sin cumplir'}` : 'Cumple las reglas que se pueden comprobar'}
          </span>
          <ul>
            {std.rules.map((r) => {
              const bad = failing.has(r.id);
              return <li key={r.id} className={bad ? (r.severity === 'error' ? 'err' : 'warn') : r.check ? 'ok' : 'todo'} title={r.check ? undefined : 'Esta regla no se comprueba sola: léela tú'}>{bad ? <X /> : r.check ? <Check /> : <span className="dg-dot">·</span>}{r.text}</li>;
            })}
          </ul>
        </footer>
      )}
    </div>
  );
}
