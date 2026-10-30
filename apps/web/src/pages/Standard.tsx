/**
 * The standard: what every piece of documentation is made of (its sections, what each asks for, a worked example) and
 * how a diagram is written (its classes, rules and a drawn template). It is the page the manual points at; the form,
 * the shape the AI reads and the note of each document all come from the same definitions.
 */
import type { DiagramKind } from '@laru/diagrams';
import { DIAGRAM_STANDARDS, inSpanish } from '@laru/diagrams';
import { Copy, ScrollText } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { typeColor } from '../lib/typeColor.ts';
import { useApi, type KnowledgeData, type Shape, type StandardData } from '../api.ts';
import { copy, Skeleton } from '../components/ui.tsx';
import { pieceLabel, plural, STAGE, STATUS } from '../lib/es.ts';
import { Diagram, Markdown } from '../lib/md.tsx';
import { href } from '../lib/route.ts';
import { useScope } from '../lib/scope.ts';
import { FieldView } from './Docs.tsx';
import { iconOf } from '../lib/pieceMenu.tsx';

const CONTAINER = ['application', 'module', 'process', 'repository', 'service', 'datastore', 'external'];

const chip = (type: string) => { const I = iconOf({ type }); return <a key={type} className="tchip" style={{ '--c': typeColor(type) } as CSSProperties} href={href('standard', type)}><I />{pieceLabel(type)}</a>; };

/** The model at a glance: every kind of piece as a coloured tile, in the group it belongs to. */
const GROUPS: Array<[string, string[]]> = [
  ['La aplicación', ['application', 'module', 'repository', 'service', 'datastore', 'external']],
  ['Procesos y pruebas', ['process', 'flow', 'scenario', 'test-plan']],
  ['Diseño', ['agreement', 'plan', 'decision', 'contract', 'data-model', 'convention', 'guide']],
  ['Construcción y operación', ['architecture', 'artifact', 'versioning', 'stack', 'infrastructure', 'secrets', 'glossary']],
];
function ModelMap({ types, count }: { types: Shape[]; count: (t: string) => number }) {
  const known = new Set(types.map((t) => t.type as string));
  return (
    <div className="model">{GROUPS.map(([title, list]) => (
      <section key={title} className="model-group"><h4>{title}</h4>
        <div className="model-tiles">{list.filter((t) => known.has(t)).map((t) => { const I = iconOf({ type: t }); return (
          <a key={t} className="model-tile" style={{ '--c': typeColor(t) } as CSSProperties} href={href('standard', t)}><span className="ic"><I size={22} /></span><span>{pieceLabel(t)}</span><small>{count(t)} en el catálogo</small></a>
        ); })}</div></section>
    ))}</div>
  );
}
const ANCHORS: Record<string, string> = { required: 'se ancla al código (se exige)', optional: 'puede anclarse al código', no: 'no lleva código' };

/** «Cómo se documenta»: the model of the catalogue (what holds what), then every piece as a card with its own page. */
export function Standard({ parts }: { parts: string[] }) {
  const std = useApi<StandardData>('/api/standard');
  const kd = useApi<KnowledgeData>('/api/knowledge');
  const types = std.data?.types ?? [];
  const current = types.find((t) => t.type === parts[0]);
  const groups = useMemo(() => [['Contenedores: lo que se documenta', types.filter((t) => CONTAINER.includes(t.type))], ['Facetas: lo que se escribe sobre ello', types.filter((t) => !CONTAINER.includes(t.type))]] as const, [types]);
  useScope(current ? {
    back: { label: 'Todas las piezas', to: href('standard') },
    card: { icon: ScrollText, kind: 'Cómo se documenta', title: pieceLabel(current.type), sub: current.question },
    sections: groups.flatMap(([, list]) => list).map((t) => ({ key: t.type, label: pieceLabel(t.type), to: href('standard', t.type), icon: iconOf({ type: t.type }) })),
    active: current.type,
  } : null);
  if (std.loading && !std.data) return <div className="page"><Skeleton lines={6} /></div>;
  if (std.error || !types.length) return <div className="page"><div className="notice">{std.error}</div></div>;
  if (current) return (
    <div className="page">
      <nav className="crumbs" aria-label="Ruta"><a href={href('standard')}>Cómo se documenta</a><span aria-hidden="true">/</span><span>{pieceLabel(current.type)}</span></nav>
      <div className="std"><nav className="std-list" aria-label="Tipos de pieza">
        {groups.map(([title, list]) => (
          <div key={title}><h4>{title}</h4>
            {list.map((t) => { const I = iconOf({ type: t.type }); return <a key={t.type} href={href('standard', t.type)} aria-current={t.type === current.type ? 'true' : undefined}><I />{pieceLabel(t.type)}</a>; })}
          </div>
        ))}
      </nav><PieceStandard t={current} /></div>
    </div>
  );
  const holds = (c: string) => types.filter((t) => t.livesIn.includes(c as never)).map((t) => t.type);
  const inCatalog = (t: string) => kd.data?.pieces.filter((p) => p.type === t).length ?? 0;
  const containers = types.filter((t) => CONTAINER.includes(t.type));
  return (
    <div className="page wide">
      <div className="head"><div><span className="eyebrow">Manual</span><h1>Cómo se documenta aquí</h1><p>El catálogo tiene {plural(types.length, 'tipo de pieza', 'tipos de pieza')}: unos son contenedores (lo que se documenta) y otros facetas (lo que se escribe sobre ellos). Aquí está qué cabe dentro de qué y cómo se escribe cada una. Lo que falta en una pieza no impide guardarla: baja su nota y aparece en «Lo que debe».</p></div></div>

      <h2 className="section-h">El modelo</h2>
      <ModelMap types={types} count={inCatalog} />

      <h2 className="section-h" style={{ marginTop: 28 }}>Qué contiene a qué <span className="faint">{plural(containers.filter((c) => holds(c.type).length).length, 'contiene otras piezas', 'contienen otras piezas')}</span></h2>
      <section className="panel"><div className="scroll-x"><table className="t std-holds">
        <thead><tr><th>Contenedor</th><th>Puede contener</th><th>Código</th></tr></thead>
        <tbody>{containers.map((c) => { const I = iconOf({ type: c.type }); return (
          <tr key={c.type}><td className="wrap"><a className="rowlink" href={href('standard', c.type)}><I size={15} style={{ marginRight: 8, verticalAlign: -3 }} /><b>{pieceLabel(c.type)}</b></a><div className="faint sub">{c.question}</div></td>
            <td className="wrap"><span className="chips-inline">{holds(c.type).map(chip)}{!holds(c.type).length && <span className="faint">nada: no contiene otras piezas</span>}</span></td>
            <td className="wrap faint">{ANCHORS[c.anchors]}</td></tr>); })}</tbody>
      </table></div></section>

      <h2 className="section-h" style={{ marginTop: 28 }}>Las piezas <span className="faint">{plural(types.length, 'pieza', 'piezas')} · el número es lo que hay ahora en el catálogo</span></h2>
      <div className="std-cards">{types.map((t) => {
        const I = iconOf({ type: t.type }), inside = holds(t.type), n = inCatalog(t.type);
        return (
          <article key={t.type} className="std-card">
            <header><I /><h3>{pieceLabel(t.type)}</h3><code>{t.type}</code></header>
            <p className="q">{t.question}</p>
            <dl>
              <div><dt>Vive en</dt><dd>{t.livesIn.length ? <span className="chips-inline">{t.livesIn.map(chip)}</span> : <span className="faint">es la raíz</span>}</dd></div>
              <div><dt>Contiene</dt><dd>{inside.length ? <span className="chips-inline">{inside.map(chip)}</span> : <span className="faint">—</span>}</dd></div>
              <div><dt>Código</dt><dd className="faint">{ANCHORS[t.anchors]}</dd></div>
              <div><dt>Secciones</dt><dd className="faint">{plural(t.fields.length, 'sección', 'secciones')}, {t.fields.filter((f) => f.required).length} obligatorias</dd></div>
            </dl>
            <footer><span className="faint">{n} en el catálogo</span><a className="rowlink" href={href('standard', t.type)}>Cómo se escribe →</a></footer>
          </article>
        );
      })}</div>
    </div>
  );
}

/** Draws its children only once they scroll into view: forty drawn templates at once would stall the page. */
function Lazy({ children, height }: { children: ReactNode; height: number }) {
  const [on, setOn] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el || on) return;
    const io = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) { setOn(true); io.disconnect(); } }, { rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
  }, [on]);
  return <div ref={box} style={{ minHeight: on ? undefined : height }}>{on ? children : null}</div>;
}

/** «Cómo se dibuja»: every class of diagram as a card — what it answers, its rules and its template drawn — filtered by a chip. */
export function DiagramsManual({ parts }: { parts: string[] }) {
  const classes = Object.values(DIAGRAM_STANDARDS).map(inSpanish);
  const one = classes.find((c) => c.kind === parts[0]);
  const shown = one ? [one] : classes;
  return (
    <div className="page wide">
      <div className="head"><div><span className="eyebrow">Manual</span><h1>Cómo se dibuja aquí</h1><p>Un diagrama no es un dibujo libre: cada clase tiene su dialecto, sus formas y sus reglas, y quien lo lee debe entenderlo sin preguntar. Se escribe en un bloque <code>```mermaid</code>; esto es lo que se espera de cada clase, con su plantilla dibujada.</p></div></div>
      <div className="chips-row" role="group" aria-label="Clases de diagrama">
        <a className={`chip pick${one ? '' : ' on'}`} href={href('diagrams')}>Todas las clases</a>
        {classes.map((c) => <a key={c.kind} className={`chip pick${one?.kind === c.kind ? ' on' : ''}`} href={href('diagrams', c.kind)}>{c.label}</a>)}
      </div>
      {shown.map((c) => (
        <section key={c.kind} className="panel dia-card" id={c.kind}>
          <header><h3>{c.label}</h3><span className="chip">{c.origin === 'derived' ? 'se calcula' : 'se escribe'}</span><span className="faint dia-q">{c.question}</span></header>
          <p className="dia-purpose">{c.purpose}</p>
          <div className="dia-body">
            <div><h4>Reglas</h4><ul className="rules">{c.rules.map((r) => <li key={r.id}><b>{r.id}</b> {r.text} <span className="faint">({r.severity === 'error' ? 'error' : 'aviso'})</span></li>)}</ul></div>
            <div><h4>Plantilla <button className="btn sm" onClick={() => copy(c.template, 'Plantilla copiada')}><Copy />Copiar plantilla</button></h4>
              <Lazy height={240}>{c.template.trimStart().startsWith('{') ? <Markdown text={'```json\n' + c.template + '\n```'} /> : <Diagram code={c.template} kind={c.kind as DiagramKind} />}</Lazy></div>
          </div>
        </section>
      ))}
    </div>
  );
}

function PieceStandard({ t }: { t: Shape }) {
  const I = iconOf({ type: t.type });
  const input = (t as Shape & { example?: { input: { fields: Record<string, unknown>; title: string; summary: string } } }).example?.input;
  return (
    <div className="std-detail">
      <header>
        <span className="type-badge"><I />{pieceLabel(t.type)}</span>
        <h2>{t.question}</h2>
        <dl className="std-facts">
          <div><dt>Vive en</dt><dd>{t.livesIn.length ? t.livesIn.map((x) => pieceLabel(x).toLowerCase()).join(', ') : 'es la raíz'}</dd></div>
          {t.stage && <div><dt>Etapa</dt><dd>{STAGE[t.stage] ?? t.stage}</dd></div>}
          <div><dt>Estados</dt><dd>{t.statuses.map((s) => STATUS[s] ?? s).join(', ')}</dd></div>
          {t.kinds && <div><dt>Clases</dt><dd>{t.kinds.join(', ')}</dd></div>}
          <div><dt>Código anclado</dt><dd>{t.anchors === 'required' ? 'se exige' : t.anchors === 'optional' ? 'opcional' : 'no lleva'}</dd></div>
          {t.expects?.length ? <div><dt>Relaciones esperadas</dt><dd>{t.expects.join(', ')}</dd></div> : null}
          <div><dt>Carpeta</dt><dd className="mono">{t.folder}</dd></div>
        </dl>
      </header>
      <section className="panel">
        <header><h3>Secciones</h3><div className="meta">Las obligatorias pesan 2 en la nota; un diagrama exigido, otro 2.</div></header>
        <div className="body scroll-x"><table className="t">
          <thead><tr><th>Sección</th><th>Forma</th><th>Se pide</th><th>Qué va ahí</th></tr></thead>
          <tbody>{t.fields.map((f) => (
            <tr key={f.name}>
              <td className="wrap"><b>{f.heading}</b></td>
              <td className="wrap">{f.type === 'rows' ? `tabla (${f.columns?.map((c) => c.heading).join(' · ')})` : f.type === 'list' ? 'lista' : f.type === 'refs' ? `ids de ${f.ref?.join(' ') ?? 'piezas'}` : f.type === 'markdown' ? 'texto' : 'una línea'}</td>
              <td className="wrap">{[f.required ? 'obligatoria' : 'opcional', f.diagram === 'required' ? 'con diagrama' : f.diagram === 'optional' ? 'diagrama opcional' : '', f.minWords ? `≥ ${f.minWords} palabras` : '', f.max ? `≤ ${f.max}` : ''].filter(Boolean).join(' · ')}</td>
              <td className="wrap faint">{f.hintEs ?? f.hint}</td>
            </tr>
          ))}</tbody>
        </table></div>
      </section>
      {input && (
        <section className="panel" style={{ marginTop: 16 }}>
          <header><h3>Ejemplo trabajado</h3><div className="meta">Da 0 errores, 0 avisos y nota 100.</div></header>
          <div className="body fields">
            <div><b>{input.title}</b><p className="faint">{input.summary}</p></div>
            {t.fields.filter((f) => input.fields[f.name] !== undefined).map((f) => (
              <section key={f.name} className="field-view"><h3>{f.heading}</h3><FieldView value={input.fields[f.name]} columns={f.columns} /></section>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
