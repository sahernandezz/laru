/** Small pieces shared by every screen. The vocabulary — origin marks, status dots — is the one the reference fixed. */
import { Activity, Copy, Eye, FolderOpen, PencilLine, ScanText, Sigma, type LucideIcon } from 'lucide-react';
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { api, WS, type ApiError, type Fact } from '../api.ts';
import { Cancelled, setAskHost } from '../lib/ask.ts';
import { highlight, statusClass, toLines, type Lang, type Token } from '../lib/syntax.ts';

export const ORIGIN: Record<Fact['origin'], { icon: LucideIcon; label: string }> = {
  declared: { icon: PencilLine, label: 'Declarado' },
  extracted: { icon: ScanText, label: 'Extraído' },
  observed: { icon: Activity, label: 'Observado' },
  derived: { icon: Sigma, label: 'Derivado' },
};

export function Origin({ of, label = true }: { of: Fact['origin']; label?: boolean }) {
  const { icon: Icon, label: text } = ORIGIN[of];
  return <span className="origin" title={text}><Icon />{label ? text : <span className="sr-only">{text}</span>}</span>;
}

export type DotState = 'ok' | 'err' | 'run' | 'idle' | 'queue';
export const Dot = ({ state }: { state: DotState }) => <span className={`dot ${state}`} aria-hidden="true" />;
export const Status = ({ state, children }: { state: DotState; children: ReactNode }) => <span className="status"><Dot state={state} />{children}</span>;

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(message: string) {
  let el = document.querySelector<HTMLDivElement>('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el?.remove(), 2600);
}

export const copy = (value: string, done = 'Copiado') => navigator.clipboard.writeText(value).then(() => toast(done), () => toast('No se pudo copiar'));

export function CopyButton({ value, label = 'Copiar', done }: { value: string; label?: string; done?: string }) {
  return <button className="copy" aria-label={label} title={label} onClick={() => copy(value, done)}><Copy /></button>;
}

/** Laru's mark: a small wave with a face, white on its cyan square. */
export const Logo = () => (
  <svg viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="15" fill="#22D3EE" /><path d="M7 40 C7 23 20 9 36 9 C47 9 55 16 57 24 C50 20 42 22 40 30 C38 38 46 44 57 42 C55 53 44 59 32 59 C17 59 7 52 7 40 Z" fill="#fff" transform="translate(6.4 6.4) scale(.8)" /><rect x="20" y="33" width="5" height="10" rx="2.5" fill="#0E3B45" /><rect x="29" y="33" width="5" height="10" rx="2.5" fill="#0E3B45" /></svg>
);

/** A path as people read it: the home folder as ~. Copying always gives the absolute path. */
export const tilde = (p: string) => p.replace(/^(\/Users\/[^/]+|\/home\/[^/]+)(?=\/|$)/, '~');
export const FINDER = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? 'Mostrar en Finder' : 'Abrir la carpeta';

/**
 * A path on this machine with «Mostrar en Finder» and «Copiar ruta». Showing sends a key (`{what, id}`), never the path:
 * the service builds it. `ws` is another workspace's id (the home page lists them all); by default the page's own.
 */
export function PathChip({ path, reveal, ws, hide }: { path: string; reveal?: { what: string; id?: string }; ws?: string | null; hide?: boolean }) {
  const open = () => api(ws ? `/api/w/${encodeURIComponent(ws)}/reveal` : reveal?.what === 'home' && !WS ? '/api/machine/reveal' : '/api/reveal', { method: 'POST', body: reveal })
    .catch((e: ApiError) => toast(e.status === 404 ? `Ya no existe: ${path}` : e.message));
  return (
    <span className="pathchip">
      {!hide && <code title={path}>{tilde(path)}</code>}
      {reveal && <button className="copy" aria-label={`${FINDER}: ${tilde(path)}`} title={FINDER} onClick={open}><FolderOpen /></button>}
      <CopyButton value={path} label={`Copiar ruta: ${tilde(path)}`} done="Ruta copiada" />
    </span>
  );
}

/** A connection line: its label, the value in one line, and a button that copies it whole. */
export function Field({ label, value }: { label: string; value?: string }) {
  return (
    <>
      <span className="lbl">{label}</span>
      <div className="f">{value ? <><code title={value}>{value}</code><CopyButton value={value} label={`Copiar ${label.toLowerCase()}`} /></> : <span className="faint">—</span>}</div>
    </>
  );
}

export function Skeleton({ lines = 4 }: { lines?: number }) {
  return <div className="panel"><div className="body" style={{ display: 'grid', gap: 10 }}>{Array.from({ length: lines }, (_, i) => <div key={i} className="sk" style={{ height: 14, width: `${[62, 90, 76, 84, 70][i % 5]}%` }} />)}</div></div>;
}

/**
 * A button that runs an async action, shows it is running and reports the result. Busy or unavailable, it stays
 * focusable (aria-disabled): disabling the button that has the focus would drop the focus to the page.
 */
export function ActionButton({ icon: Icon, children, run, primary, sm, disabled, label, done, title }: { icon: LucideIcon; children: ReactNode; run: () => Promise<unknown>; primary?: boolean; sm?: boolean; disabled?: boolean; label?: string; done?: (r: unknown) => string; title?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button className={`btn${primary ? ' primary' : ''}${sm ? ' sm' : ''}`} aria-disabled={busy || disabled || undefined} aria-busy={busy || undefined} aria-label={label} title={title} onClick={async () => {
      if (busy || disabled) return;
      setBusy(true);
      try { const r = await run(); if (done) toast(done(r)); } catch (e) { if (!(e instanceof Cancelled)) toast((e as Error).message); } finally { setBusy(false); }
    }}>
      <Icon className={busy ? 'spin' : undefined} />{children}
    </button>
  );
}

/**
 * A modal on the native <dialog>: showModal() makes the page behind inert (the focus trap) and Escape closes it.
 * Mount it to open it; `onClose` unmounts it, and focus goes back to what opened it (or to the page, when that is gone).
 */
export function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef(document.activeElement as HTMLElement | null);
  const id = useId();
  useEffect(() => {
    const d = ref.current!;
    if (!d.open) d.showModal();
    d.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => {
      const o = opener.current;
      if (o?.isConnected && !o.matches(':disabled')) o.focus();
      else document.getElementById('main')?.focus();
    };
  }, []);
  return (
    <dialog ref={ref} className={`dlg${wide ? ' wide' : ''}`} aria-labelledby={id} onClose={onClose} onMouseDown={(e) => {
      // Only a press outside the box closes it: the dialog's own scrollbar is the dialog too.
      if (e.target !== e.currentTarget) return;
      const r = e.currentTarget.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) ref.current?.close();
    }}>
      <div className="dlg-in"><h2 id={id}>{title}</h2>{children}</div>
    </dialog>
  );
}

/**
 * The question `askFirst` puts to the person, once for the whole page: what the call would delete, and «Cancelar»
 * first (the safe answer has the focus). Escape and a press outside are a no.
 */
export function AskHost() {
  const [q, setQ] = useState<{ text: string; label: string; title?: string; answer: (yes: boolean) => void }>();
  useEffect(() => { setAskHost((x) => new Promise((answer) => setQ({ ...x, answer }))); return () => setAskHost(undefined); }, []);
  if (!q) return null;
  const reply = (yes: boolean) => { q.answer(yes); setQ(undefined); };
  return (
    <Dialog title={q.title ?? 'Antes de seguir'} onClose={() => reply(false)}>
      <div className="dlg-body" aria-live="polite"><p className="pre-line">{q.text}</p></div>
      <footer>
        <button type="button" className="btn" data-autofocus onClick={() => reply(false)}>Cancelar</button>
        <button type="button" className="btn destroy" onClick={() => reply(true)}>{q.label}</button>
      </footer>
    </Dialog>
  );
}

const REVEAL_MS = 10_000;

/**
 * A secret shown on demand for 10 s. Focus moves to «Ocultar» when the value appears and back to «Ver» when it goes
 * (only if it was inside), and a live region says both, so nobody loses their place in a long table.
 * `load` returns null when there is nothing to show, and says why itself.
 */
export function Reveal({ name, load, masked }: { name: string; load: () => Promise<string | null>; masked?: boolean }) {
  const [value, setValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState('');
  const box = useRef<HTMLSpanElement>(null);
  const refocus = useRef(false);
  const Name = name.charAt(0).toUpperCase() + name.slice(1);
  const hide = () => {
    refocus.current = Boolean(box.current?.contains(document.activeElement));
    setValue(null);
    setSaid(`${Name}: oculto`);
  };
  useEffect(() => {
    if (value === null) return;
    const t = setTimeout(hide, REVEAL_MS);
    return () => clearTimeout(t);
  }, [value]);
  useLayoutEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    box.current?.querySelector<HTMLElement>('[data-focus]')?.focus();
  }, [value]);
  const show = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const v = await load();
      if (v !== null) { refocus.current = true; setValue(v); setSaid(`${Name}: visible durante 10 segundos`); }
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <span className="revealed" ref={box}>
      <span className="sr-only" aria-live="polite">{said}</span>
      {value === null ? (
        <>{masked && <code className="faint" aria-hidden="true">••••••••••</code>}<button className="btn sm" data-focus aria-disabled={busy || undefined} aria-label={`Ver ${name} durante 10 segundos`} onClick={show}><Eye className={busy ? 'spin' : undefined} />Ver</button></>
      ) : (
        <>
          <code title={value}>{value === '' ? '(vacío)' : value}</code>
          <CopyButton value={value} label={`Copiar ${name}`} />
          <button className="btn sm" data-focus onClick={hide}>Ocultar</button>
        </>
      )}
    </span>
  );
}

/** Tabs with arrow-key movement; the page renders one panel with `id={`${id}-panel`}` labelled by the selected tab. */
export function Tabs<K extends string>({ id, label, tabs, value, onChange, className = 'tabs' }: { id: string; label: string; tabs: Array<{ key: K; label: ReactNode; n?: number; icon?: LucideIcon; italic?: boolean }>; value: K; onChange: (k: K) => void; className?: string }) {
  const list = useRef<HTMLDivElement>(null);
  const key = (e: KeyboardEvent, i: number) => {
    const to = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    const next = tabs[(to + tabs.length) % tabs.length];
    onChange(next.key);
    list.current?.querySelector<HTMLElement>(`[data-tab="${next.key}"]`)?.focus();
  };
  return (
    <div className={className} role="tablist" aria-label={label} ref={list}>
      {tabs.map((t, i) => (
        <button key={t.key} type="button" id={`${id}-tab-${t.key}`} data-tab={t.key} role="tab" aria-selected={t.key === value} aria-controls={`${id}-panel`}
          tabIndex={t.key === value ? 0 : -1} className={t.italic ? 'preview' : undefined} onClick={() => onChange(t.key)} onKeyDown={(e) => key(e, i)}>
          {t.icon && <t.icon />}{t.label}{t.n !== undefined && <span className="n num">{t.n}</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * One choice among a few, as a radio group: one tab stop, arrows move the choice (and the focus) like any radio
 * group. For filters only: a choice that changes something outside the page is a button, not this.
 */
export function Segmented<K extends string>({ label, options, value, onChange, className = 'seg' }: { label: string; options: Array<{ key: K; label: ReactNode; title?: string }>; value: K; onChange: (k: K) => void; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const key = (e: KeyboardEvent, i: number) => {
    const to = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    const next = options[(to + options.length) % options.length];
    onChange(next.key);
    box.current?.querySelectorAll<HTMLElement>('[role="radio"]')[(to + options.length) % options.length]?.focus();
  };
  const current = options.some((o) => o.key === value) ? value : options[0]?.key;
  return (
    <div className={className} role="radiogroup" aria-label={label} ref={box}>
      {options.map((o, i) => (
        <button key={o.key} type="button" role="radio" aria-checked={o.key === value} tabIndex={o.key === current ? 0 : -1} title={o.title} onClick={() => onChange(o.key)} onKeyDown={(e) => key(e, i)}>{o.label}</button>
      ))}
    </div>
  );
}

export const shortPath = (p: string) => p.split('/').pop() ?? p;

// ---------- code, and the colour language ----------

const cls = (t: Token) => (t.t === 'method' ? `m-${t.x}` : t.t === 'status' ? `st-${t.x}` : t.t === 'level' ? `syn-lv lv-${t.x}` : `syn-${t.t}`);

const span = (t: Token, key: number | string) => (!t.t ? t.v : <span key={key} className={cls(t)} title={t.t === 'mask' ? 'Enmascarado al capturar' : undefined}>{t.v}</span>);

/** Code as coloured spans. The characters are the text's own; `format` only re-indents JSON and SQL. */
export const Code = memo(function Code({ text, lang, format = false }: { text: string; lang: Lang; format?: boolean }) {
  const toks = useMemo(() => highlight(text, lang, format), [text, lang, format]);
  return <>{toks.map(span)}</>;
});

/** Code line by line: a line too long for the block wraps past its own indentation, so the shape shown is the text's. */
const Lines = memo(function Lines({ text, lang, format = false }: { text: string; lang: Lang; format?: boolean }) {
  const lines = useMemo(() => toLines(highlight(text, lang, format)), [text, lang, format]);
  return <>{lines.map((l, i) => (
    // the line keeps its \n, so a selection copies the text as shown, line ends included
    <span key={i} className="ln" style={{ '--in': l.indent } as CSSProperties}>{l.toks.map(span)}{i < lines.length - 1 ? '\n' : null}</span>
  ))}</>;
});

/**
 * A block of code. A selection copies what is seen: formatting only moves whitespace outside quotes, so it is the same
 * statement or document. The button copies the original text exactly as it came.
 */
export function CodeBlock({ text, lang, format, className = 'json', label, autoFocus }: { text: string; lang: Lang; format?: boolean; className?: string; label?: string; autoFocus?: boolean }) {
  return (
    <div className="code-block">
      <pre className={className} tabIndex={0} aria-label={label} data-autofocus={autoFocus || undefined}><Lines text={text} lang={lang} format={format} /></pre>
      <CopyButton value={text} label="Copiar el original" done="Copiado el original" />
    </div>
  );
}

/** http, sql, kafka…: always written, the colour only repeats it. */
export const Kind = ({ k }: { k: string }) => <span className={`kind k-${k}`}>{k}</span>;
export const Method = ({ m }: { m: string }) => <span className={`method m-${m.toLowerCase()}`}>{m}</span>;
export const HttpStatus = ({ n }: { n: number }) => <span className={`mono num st-${statusClass(n)}`}>{n}</span>;
/** ERROR, WARN, INFO, DEBUG as a small tag. */
export const Level = ({ lv }: { lv: string }) => <span className="lv">{lv && <span className={`lv-tag lv-${lv.toLowerCase()}`}>{lv.toUpperCase()}</span>}</span>;
