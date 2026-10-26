/**
 * The Markdown a piece's fields hold, as React elements: paragraphs, lists, fenced code, `code`, **bold**
 * and `[[id]]` links. Text is never injected as HTML, so a field cannot carry markup into the page.
 */
import { drawMermaid, type DiagramKind } from '@laru/diagrams';
import { Fragment, useId, useMemo, type ReactNode } from 'react';
import { CodeBlock } from '../components/ui.tsx';
import { pageOf } from './route.ts';
import { langOf, type Lang } from './syntax.ts';

/** The language a fence names (```json, ```sql…); without one, JSON when it looks like it. */
const FENCE: Record<string, Lang> = { json: 'json', sql: 'sql', http: 'http', log: 'log', sh: 'sh', bash: 'sh', shell: 'sh', console: 'sh', curl: 'sh', text: 'text' };

function inline(text: string, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[\[([^\]]+)\]\]/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<code key={`${key}-${m.index}`}>{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<b key={`${key}-${m.index}`}>{m[2]}</b>);
    else out.push(<a key={`${key}-${m.index}`} className="rowlink mono" href={pageOf(m[3])}>{m[3]}</a>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** A written diagram, drawn as a fixed SVG by the engine; what it cannot draw shows its text and says why. The source stays one click away. */
export function Diagram({ code, kind }: { code: string; kind?: DiagramKind }) {
  const id = useId().replace(/:/g, '');
  const r = useMemo(() => drawMermaid(code, id, kind), [code, id, kind]);
  if (!r.svg) return <div><p className="faint">No se puede dibujar: {r.error}</p><CodeBlock className="md-code" text={code} lang="text" /></div>;
  return (
    <figure className="diagram">
      <div className="diagram-stage" role="img" aria-label="Diagrama" dangerouslySetInnerHTML={{ __html: r.svg }} />
      <details><summary>Ver el texto del diagrama</summary><CodeBlock className="md-code" text={code} lang="text" /></details>
    </figure>
  );
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length;) {
    const l = lines[i];
    if (/^\s*```/.test(l)) {
      const named = l.trim().slice(3).trim().toLowerCase();
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i]);
      i++;
      const code = body.join('\n');
      if (named === 'mermaid') { blocks.push(<Diagram key={i} code={code} />); continue; }
      blocks.push(<CodeBlock key={i} className="md-code" text={code} lang={Object.hasOwn(FENCE, named) ? FENCE[named] : langOf(code)} />);
    } else if (/^\s*[-*]\s+/.test(l)) {
      const items: string[] = [];
      for (; i < lines.length && /^\s*[-*]\s+/.test(lines[i]); i++) items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
      blocks.push(<ul key={i}>{items.map((it, n) => <li key={n}>{inline(it, n)}</li>)}</ul>);
    } else if (!l.trim()) i++;
    else {
      const para: string[] = [];
      for (; i < lines.length && lines[i].trim() && !/^\s*(```|[-*]\s+)/.test(lines[i]); i++) para.push(lines[i]);
      blocks.push(<p key={i}>{inline(para.join(' '))}</p>);
    }
  }
  return <div className="md">{blocks.map((b, i) => <Fragment key={i}>{b}</Fragment>)}</div>;
}

export const Inline = ({ text }: { text: string }) => <>{inline(text)}</>;
