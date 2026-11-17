/**
 * The Markdown a piece's fields hold, as React elements (see Markdown), and the inline form for one-line texts.
 */
import { drawMermaid, type DiagramKind } from '@laru/diagrams';
import { isValidElement, useId, useMemo, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from '../components/ui.tsx';
import { pageOf } from './route.ts';
import { refLinks, titles } from './titles.ts';
import { langOf, type Lang } from './syntax.ts';
import { tr } from './i18n.ts';

/** The language a fence names (```json, ```sql…); without one, JSON when it looks like it. */
const FENCE: Record<string, Lang> = { json: 'json', sql: 'sql', http: 'http', log: 'log', sh: 'sh', bash: 'sh', shell: 'sh', console: 'sh', curl: 'sh', text: 'text' };

const ref = (id: string, key: string, shown: ReactNode = titles.get(id) ?? id) => <a key={key} className={titles.has(id) ? 'rowlink pref' : 'rowlink mono'} href={pageOf(id)} title={titles.has(id) ? id : undefined}>{shown}</a>;

function inline(text: string, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[\[([^\]]+)\]\]|(?<![\w[(/:.@-])([a-z][a-z0-9]*:[a-z0-9][a-z0-9-]*)(?![\w-])/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[4] !== undefined && !titles.has(m[4])) continue; // a word with a colon that names no piece is just text
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<code key={`${key}-${m.index}`}>{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<b key={`${key}-${m.index}`}>{m[2]}</b>);
    else out.push(ref(m[3] ?? m[4], `${key}-${m.index}`));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** A written diagram, drawn as a fixed SVG by the engine; what it cannot draw shows its text and says why. The source stays one click away. */
export function Diagram({ code, kind }: { code: string; kind?: DiagramKind }) {
  const id = useId().replace(/:/g, '');
  const r = useMemo(() => drawMermaid(code, id, kind), [code, id, kind]);
  if (!r.svg) return <div><p className="faint">{tr('No se puede dibujar:')}{' '}{r.error}</p><CodeBlock className="md-code" text={code} lang="text" /></div>;
  return (
    <figure className="diagram">
      <div className="diagram-stage" role="img" aria-label={tr('Diagrama')} dangerouslySetInnerHTML={{ __html: r.svg }} />
      <details><summary>{tr('Ver el texto del diagrama')}</summary><CodeBlock className="md-code" text={code} lang="text" /></details>
    </figure>
  );
}

/** `[[id]]`, and the id of a piece written bare, as a link Laru opens, outside code: the renderer sees a link of its own scheme. */
const wikiLinks = (text: string) => text.split(/(```[\s\S]*?```|`[^`\n]*`)/g).map((part, i) => (i % 2 ? part : refLinks(part))).join('');
const decoded = (s: string) => { try { return decodeURIComponent(s); } catch { return null; } };
const plain = (n: ReactNode): string => (typeof n === 'string' || typeof n === 'number' ? String(n) : Array.isArray(n) ? n.map(plain).join('') : isValidElement<{ children?: ReactNode }>(n) ? plain(n.props.children) : '');
/** A heading's anchor, so an index can point at it. */
export const anchorOf = (text: string) => `h-${text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
const heading = (Tag: 'h3' | 'h4' | 'h5') => ({ children }: { children?: ReactNode }) => <Tag className="md-h" id={anchorOf(plain(children))}>{children}</Tag>;

const COMPONENTS: Components = {
  // a fenced block: a diagram when it is mermaid, else code with its language
  pre: ({ children }) => {
    const c = isValidElement<{ className?: string; children?: ReactNode }>(children) ? children : null;
    const named = /language-(\S+)/.exec(c?.props.className ?? '')?.[1]?.toLowerCase() ?? '';
    const code = plain(c?.props.children).replace(/\n$/, '');
    if (named === 'mermaid') return <Diagram code={code} />;
    return <CodeBlock className="md-code" text={code} lang={Object.hasOwn(FENCE, named) ? FENCE[named] : langOf(code)} />;
  },
  a: ({ href, children }) => {
    if (!href?.startsWith('laru:')) return <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
    // a piece's id; one written by hand that does not decode stays text, never breaking the page around it
    const id = decoded(href.slice(5));
    // written as its id, it reads as its title; a link with words of its own keeps them
    return id ? ref(id, id, plain(children) === id ? undefined : children) : <span>{children}</span>;
  },
  table: ({ children }) => <div className="scroll-x"><table className="t md-table">{children}</table></div>,
  td: ({ children, style }) => <td className="wrap" style={style}>{children}</td>,
  blockquote: ({ children }) => <blockquote className="md-quote">{children}</blockquote>,
  // a field's own headings sit under its section's title
  h1: heading('h3'), h2: heading('h3'), h3: heading('h4'), h4: heading('h5'), h5: heading('h5'), h6: heading('h5'),
};
const urls = (url: string) => (url.startsWith('laru:') ? url : defaultUrlTransform(url));

/**
 * A field's Markdown as GitHub writes it (tables, numbered and nested lists, headings, quotes, emphasis, links), as
 * React elements: raw HTML in it is never rendered and a link's address is sanitised, so a field cannot carry markup or
 * a script into the page. A mermaid block is drawn; `[[id]]` opens that piece.
 */
export function Markdown({ text }: { text: string }) {
  return <div className="md"><ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS} urlTransform={urls}>{wikiLinks(text)}</ReactMarkdown></div>;
}

export const Inline = ({ text }: { text: string }) => <>{inline(text)}</>;
