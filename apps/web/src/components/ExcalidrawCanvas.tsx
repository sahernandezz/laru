/**
 * Excalidraw itself editing a diagram: the class's model compiled to a scene, edited with
 * Excalidraw's own tools, read back into the model on every real change. What Laru adds lives in Excalidraw's own
 * places (its menu, its footer, its library): «Proponer la colocación», the rules of the class, the class itself.
 */
import { useEffect, useRef, useState } from 'react';
import { Excalidraw, Footer, MainMenu } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { AlertTriangle, Check, Sparkles } from 'lucide-react';
import { propose, SKINS, writeModel, type DiagramKind, type DiagramModel, type SequenceModel } from '@laru/diagrams';
import { fromScene, toScene } from '../lib/excalidrawScene.ts';
import type { Templates } from '../lib/libraryScene.ts';
import { sceneToSequence, sequenceToScene } from '../lib/sequenceScene.ts';

/** A sequence travels as its own model with the class on it. */
export type Drawing = DiagramModel | (SequenceModel & { kind: 'sequence' });
const isSequence = (d: Drawing): d is SequenceModel & { kind: 'sequence' } => d.kind === 'sequence';

export interface Issue { text: string; severity: 'error' | 'warning' }

export default function ExcalidrawCanvas({ model, kind, kinds, onChangeKind, issues, onChange }: {
  model: Drawing; kind: DiagramKind; kinds: Array<{ value: string; label: string }>; onChangeKind: (k: DiagramKind) => void;
  issues: Issue[]; onChange: (next: Drawing) => void;
}) {
  // the scene is rebuilt only when the model changes from outside: rebuilding on our own changes would drop Excalidraw's selection and scroll
  const held = useRef(model);
  /**
   * The model the scene on the canvas was compiled from. Every change is read against it, never against the last change:
   * read against the last one, a shape drawn by hand (adopted as a piece) was adopted again on every event, one more copy each time.
   */
  const compiled = useRef(model);
  const templates = useRef<Templates | undefined>(undefined);
  const compile = (d: Drawing) => { compiled.current = d; return isSequence(d) ? sequenceToScene(d) : toScene(d, templates.current); };
  const [scene, setScene] = useState(() => compile(model));
  const [api, setApi] = useState<{ updateScene: (s: unknown) => void; scrollToContent: (t?: unknown, o?: unknown) => void; updateLibrary: (o: unknown) => void } | null>(null);

  useEffect(() => {
    let alive = true;
    void import('../lib/libraryScene.ts').then((m) => m.templatesFor(kind)).then((t) => { if (!alive || !t.size) return; templates.current = t; setScene(compile(held.current)); }).catch(() => undefined);
    return () => { alive = false; };
  }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (model === held.current || writeModel(model as never) === writeModel(held.current as never)) return;
    held.current = model;
    setScene(compile(model));
  }, [model]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!api) return;
    api.updateScene({ elements: scene.elements });
    api.scrollToContent(undefined, { fitToContent: true, animate: false });
  }, [api, scene]);

  // the library comes with the class (a process wears BPMN, a deployment Kubernetes and the clouds), pushed once it is loaded
  useEffect(() => {
    if (!api) return;
    let alive = true;
    void import('../lib/excalidrawLibraries.ts').then((m) => m.libraryItemsForKind(kind)).then((items) => {
      if (!alive) return;
      if (items.length) api.updateLibrary({ libraryItems: items, merge: false, openLibraryMenu: false });
      else api.updateScene({ appState: { openSidebar: null } });
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [api, kind]);

  const [showIssues, setShowIssues] = useState(false);
  const errors = issues.filter((i) => i.severity === 'error').length;

  return (
    <div className="exc-host">
      {showIssues && issues.length > 0 && (
        <div className="exc-issues">{issues.map((i, n) => <p key={n} className={i.severity === 'error' ? 'err-ink' : 'warn-ink'}><AlertTriangle aria-hidden="true" />{i.text}</p>)}</div>
      )}
      <div className="exc-stage">
        <Excalidraw
          excalidrawAPI={(a: unknown) => setApi(a as never)}
          theme="dark"
          langCode="es-ES"
          initialData={{ elements: scene.elements as never, appState: { currentItemFontFamily: 5, openSidebar: { name: 'default', tab: 'library' } } as never, scrollToContent: true }}
          onChange={(elements: readonly unknown[]) => {
            // Excalidraw fires for a hover or a scroll too: only a change of the drawing goes on
            const before = held.current, from = compiled.current;
            const next = isSequence(from) ? sceneToSequence(elements, from) : fromScene(elements, from as DiagramModel);
            if (writeModel(next as never) === writeModel(before as never)) return;
            held.current = next as Drawing;
            onChange(next as Drawing);
          }}
          name={scene.name}
          UIOptions={{ canvasActions: { loadScene: false, export: false, saveToActiveFile: false, toggleTheme: false } }}
        >
          <MainMenu>
            {!isSequence(model) && SKINS[kind as keyof typeof SKINS] && (
              <MainMenu.Item onSelect={() => onChange(propose(structuredClone(model), { kind, skin: SKINS[kind as keyof typeof SKINS]! }).model)} icon={<Sparkles size={16} />}>Proponer la colocación</MainMenu.Item>
            )}
            <MainMenu.Separator />
            {issues.length === 0
              ? <MainMenu.Item onSelect={() => undefined} icon={<Check size={16} />}>Cumple las reglas de su clase</MainMenu.Item>
              : issues.slice(0, 8).map((i, n) => <MainMenu.Item key={n} onSelect={() => setShowIssues(true)} icon={<AlertTriangle size={16} />}>{i.text}</MainMenu.Item>)}
            <MainMenu.Separator />
            <MainMenu.DefaultItems.ChangeCanvasBackground />
            <MainMenu.DefaultItems.SaveAsImage />
            <MainMenu.DefaultItems.Help />
          </MainMenu>
          <Footer>
            <div className="exc-footer">
              <select aria-label="Clase del diagrama" value={kind} onChange={(e) => onChangeKind(e.target.value as DiagramKind)}>
                {kinds.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
              </select>
              <span>{isSequence(model) ? `${model.participants.length} participantes, ${model.rows.length} filas` : `${model.nodes.length} piezas, ${model.edges.length} flechas`}</span>
              {issues.length > 0 && <button type="button" className={errors ? 'err-ink' : 'warn-ink'} aria-expanded={showIssues} onClick={() => setShowIssues((v) => !v)}><AlertTriangle size={13} aria-hidden="true" />{issues.length}</button>}
            </div>
          </Footer>
        </Excalidraw>
      </div>
    </div>
  );
}
