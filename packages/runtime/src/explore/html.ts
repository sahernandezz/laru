/**
 * An email's HTML made safe to draw: a small whitelist tokenizer, no library. It is a boundary, not an ornament: the
 * frame that shows the result has no scripts and no network, but a click on a link could still navigate the frame, and
 * a form could still be sent, so what is not on the list is not in the output. Tags and attributes off the list are
 * dropped (a dropped tag keeps its text, except those that hold code or other documents), every `href` becomes
 * `data-href` (the frame's style paints `a[data-href]` as a link; nothing is opened from inside it), a remote `src` and
 * every `url()` of the CSS are removed and counted, and inline images (`cid:`) come in as `data:`.
 */
const TAGS = new Set('a abbr address article aside b bdi bdo big blockquote br caption center cite code col colgroup dd del details dfn div dl dt em figcaption figure font footer h1 h2 h3 h4 h5 h6 header hr i img ins kbd li main mark nav ol p pre q s samp section small span strike strong sub summary sup table tbody td tfoot th thead tr tt u ul var wbr'.split(' '));
/** Tags whose content is dropped with them: code, other documents, forms' inner parts. */
const DEAD = new Set(['script', 'iframe', 'object', 'embed', 'applet', 'frame', 'frameset', 'noscript', 'template', 'svg', 'math', 'head', 'title', 'meta', 'link', 'base', 'form', 'button', 'input', 'select', 'textarea', 'audio', 'video', 'canvas', 'map', 'area']);
const ATTRS = new Set('align valign width height border cellpadding cellspacing bgcolor color colspan rowspan alt title dir lang face size nowrap span start type'.split(' '));
const VOID = new Set(['br', 'hr', 'img', 'col', 'wbr', 'link', 'meta', 'base', 'input', 'area', 'embed', 'source', 'track', 'param', 'frame']);

const esc = (s: string) => s.replace(/&(?!#?\w+;)/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const decode = (s: string) => s.replace(/&#x([0-9a-f]+);?/gi, (_, h: string) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff))).replace(/&#(\d+);?/g, (_, d: string) => String.fromCodePoint(Math.min(Number(d), 0x10ffff))).replace(/&(amp|lt|gt|quot|apos|colon|tab|newline);/gi, (_, n: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':', tab: '\t', newline: '\n' })[n.toLowerCase()]!);

export interface Sanitized { html: string; blocked: Array<{ url: string; why: string }> }

/** CSS with every way out removed: `url()`, `@import`, `expression()`, `behavior`, `-moz-binding`. The remote ones are reported. */
export function cleanCss(css: string, blocked: Sanitized['blocked']): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@import[^;{]*;?/gi, (m) => { const u = /(?:url\(\s*)?["']?([^"')\s;]+)/i.exec(m.slice(7))?.[1]; if (u) blocked.push({ url: u, why: 'css @import' }); return ''; })
    .replace(/url\(\s*(["']?)([^)]*?)\1\s*\)/gi, (_, _q: string, u: string) => { if (/^(?:https?:)?\/\//i.test(u.trim())) blocked.push({ url: u.trim(), why: 'css url()' }); return /^data:image\//i.test(u.trim()) ? `url(${u.trim()})` : 'none'; })
    .replace(/expression\s*\(|behavior\s*:|-moz-binding\s*:|javascript\s*:/gi, 'x-blocked:');
}

/** `cid`: the inline parts by Content-ID as `data:` URLs, made by the caller. */
export function sanitizeHtml(src: string, cid: Record<string, string> = {}): Sanitized {
  const blocked: Sanitized['blocked'] = [];
  const out: string[] = [];
  const s = src.length > 2 * 1024 * 1024 ? src.slice(0, 2 * 1024 * 1024) : src;
  let i = 0;
  let dead: string | undefined;
  let depth = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    const textEnd = lt < 0 ? s.length : lt;
    if (!dead && textEnd > i) out.push(s.slice(i, textEnd).replace(/&(?!#?\w+;)/g, '&amp;').replace(/>/g, '&gt;'));
    if (lt < 0) break;
    i = lt;
    if (s.startsWith('<!--', i)) { const e = s.indexOf('-->', i + 4); i = e < 0 ? s.length : e + 3; continue; }
    if (/^<![a-z]/i.test(s.slice(i, i + 3)) || s.startsWith('<?', i) || s.startsWith('<![CDATA[', i)) { const e = s.indexOf('>', i); i = e < 0 ? s.length : e + 1; continue; }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>?/.exec(s.slice(i, i + 20000));
    if (!m) { if (!dead) out.push('&lt;'); i++; continue; }
    i += m[0].length;
    const [, close, rawName, rest] = m;
    const name = rawName.toLowerCase();
    if (dead) { if (close && name === dead) dead = undefined; continue; }
    if (name === 'style') {
      if (close) continue;
      const e = s.toLowerCase().indexOf('</style', i);
      const css = s.slice(i, e < 0 ? s.length : e);
      i = e < 0 ? s.length : s.indexOf('>', e) + 1 || s.length;
      out.push(`<style>${cleanCss(css, blocked).replace(/</g, '\\3c ')}</style>`);
      continue;
    }
    if (DEAD.has(name)) { if (!close && !VOID.has(name) && !/\/\s*$/.test(rest)) dead = name; if (name === 'link' || name === 'meta') { const u = /\bhref\s*=\s*["']?([^"'\s>]+)/i.exec(rest)?.[1]; if (u && name === 'link' && /^(?:https?:)?\/\//i.test(u)) blocked.push({ url: u, why: 'style' }); } continue; }
    if (!TAGS.has(name)) continue;
    if (close) { if (!VOID.has(name) && depth > 0) { out.push(`</${name}>`); depth--; } continue; }
    const attrs: string[] = [];
    for (const a of rest.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
      const k = a[1].toLowerCase();
      const v = decode(a[2] ?? a[3] ?? a[4] ?? '').replace(/[\u0000-\u001f\u007f]/g, '');
      if (k === 'href' && name === 'a') attrs.push(`data-href="${esc(v)}"`);
      else if (k === 'src' && name === 'img') {
        const id = /^cid:(.+)$/i.exec(v.trim())?.[1];
        if (id && cid[id]) attrs.push(`src="${cid[id]}"`);
        else if (/^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,[A-Za-z0-9+/=]+$/i.test(v.trim())) attrs.push(`src="${esc(v.trim())}"`);
        else if (/^(?:https?:)?\/\//i.test(v.trim())) blocked.push({ url: v.trim(), why: /\b(?:width|height)\s*=\s*["']?[01]\b/i.test(rest) || /display\s*:\s*none/i.test(rest) ? 'tracking pixel' : 'image' });
      } else if (k === 'style') attrs.push(`style="${esc(cleanCss(v, blocked))}"`);
      else if (k === 'class') attrs.push(`class="${esc(v.replace(/[^\w\s-]/g, ''))}"`);
      else if (ATTRS.has(k)) attrs.push(`${k}="${esc(v)}"`);
      else if (k === 'background' && /^(?:https?:)?\/\//i.test(v.trim())) blocked.push({ url: v.trim(), why: 'image' });
    }
    out.push(`<${name}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`);
    if (!VOID.has(name)) depth++;
  }
  return { html: out.join(''), blocked };
}

/** The page of a message as the frame draws it: light colours on white whatever the message asks, links painted, nothing active. */
export const framePage = (body: string, width?: number) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{color-scheme:light}html{background:#fff;color:#1f2328}body{margin:0;padding:12px;font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;word-wrap:break-word;${width ? `width:${width - 24}px` : ''}}a[data-href]{color:#0b57d0;text-decoration:underline;cursor:default}img{max-width:100%;height:auto}table{max-width:100%}</style>${body}`;

/** The headers of the frame's page: it is a document of its own, drawn with nothing active and nothing loaded from anywhere. */
export const FRAME_HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
};
