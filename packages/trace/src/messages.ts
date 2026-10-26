/**
 * What the sink makes of a message it received: SMS segments, the codes and links in a text, and their class. Stdlib
 * only and linear in the input (every pattern is bounded), because it runs inside the tap's event loop.
 */
import { MASK_KEYS } from './mask.ts';

// GSM 03.38 basic set; the extension set (each one counts as two) is `^ {} \ [ ~ ] | €`.
const GSM7 = new Set('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà');
const GSM7_EXT = new Set('^{}\\[~]|€\f');

export interface Segments { encoding: 'GSM-7' | 'UCS-2'; chars: number; units: number; segments: number; per: number }

/** How a provider counts a text: GSM-7 holds 160 units (153 per segment when it takes several), UCS-2 70 (67). One character outside GSM-7 moves the whole text to UCS-2. */
export function smsSegments(body: string): Segments {
  const chars = [...body];
  let units = 0;
  let gsm = true;
  for (const c of chars) {
    if (GSM7.has(c)) units += 1;
    else if (GSM7_EXT.has(c)) units += 2;
    else { gsm = false; break; }
  }
  if (!gsm) units = body.length; // UTF-16 code units: an emoji is two
  const [single, multi] = gsm ? [160, 153] : [70, 67];
  return { encoding: gsm ? 'GSM-7' : 'UCS-2', chars: chars.length, units, segments: units <= single ? 1 : Math.ceil(units / multi), per: units <= single ? single : multi };
}

const WORD = '(?:c[oó]digo|code|otp|pin|verification|verificaci[oó]n|clave|password|contraseña)';
/** A code: 4 to 8 digits next to a word that says so, or alone on its line; or 6 to 10 capitals-and-digits (one digit at least) in the same places. At most 3. */
export function codesOf(text: string): string[] {
  const out: string[] = [];
  const add = (c: string | undefined) => { if (c && !out.includes(c) && out.length < 3) out.push(c); };
  const t = text.length > 65536 ? text.slice(0, 65536) : text;
  for (const m of t.matchAll(new RegExp(`${WORD}[^\\d\\n]{0,30}?\\b(\\d{4,8})\\b`, 'gi'))) add(m[1]);
  for (const m of t.matchAll(new RegExp(`\\b(\\d{4,8})\\b[^\\d\\n]{0,20}${WORD}`, 'gi'))) add(m[1]);
  for (const m of t.matchAll(/^[ \t]*(\d{4,8})[ \t]*$/gm)) add(m[1]);
  for (const w of t.matchAll(new RegExp(WORD, 'gi'))) {
    const c = /^[^A-Za-z0-9\n]{0,30}?\b([A-Z0-9]{6,10})\b/.exec(t.slice(w.index! + w[0].length, w.index! + w[0].length + 45))?.[1];
    if (c && /\d/.test(c) && /[A-Z]/.test(c)) add(c);
  }
  return out;
}

/** What a link carries that opens something: the value of a parameter named like a secret, or a long mixed path segment. */
export function tokensOf(url: string): string[] {
  let u: URL;
  try { u = new URL(url); } catch { return []; }
  const out: string[] = [];
  for (const [k, v] of u.searchParams) if (MASK_KEYS.test(k) || /^(?:token|key|code|sig|auth)$/i.test(k)) if (v.length >= 4) out.push(v);
  for (const seg of u.pathname.split('/')) if (seg.length >= 16 && /[a-z]/i.test(seg) && /\d/.test(seg)) out.push(decodeURIComponent(seg.replace(/%(?![0-9a-f]{2})/gi, '%25')));
  return out;
}

export type LinkClass = 'local' | 'external' | 'production' | 'tracking' | 'unsubscribe' | 'blocked-scheme';
export interface Link { url: string; text?: string; class: LinkClass }
export interface LinkEnv { /** a name the env answers to (a service alias) */ local?: (host: string) => boolean; /** a host declared as production */ production?: (host: string) => boolean }

export function classify(url: string, hint?: 'tracking' | 'unsubscribe', env: LinkEnv = {}): LinkClass {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url.trim())?.[1]?.toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return 'blocked-scheme';
  if (hint) return hint;
  let u: URL;
  try { u = new URL(url); } catch { return 'blocked-scheme'; }
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || env.local?.(host)) return 'local';
  if (env.production?.(host)) return 'production';
  return /\/(?:open|track|pixel|beacon)\b/i.test(u.pathname) ? 'tracking' : 'external';
}

/** The URLs written in a plain text: http and https only, trailing punctuation left out. */
export function textLinks(text: string): string[] {
  return [...new Set([...text.slice(0, 262144).matchAll(/\bhttps?:\/\/[^\s<>"']{1,2000}/gi)].map((m) => m[0].replace(/[.,;:!?)\]]+$/, '')))];
}

/** Hosts of known providers that carry mail or SMS by HTTP: the map warns when one is not intercepted. */
export const PROVIDER_HOSTS = ['api.sendgrid.com', 'api.mailgun.net', 'api.eu.mailgun.net', 'api.postmarkapp.com', 'api.twilio.com', 'rest.nexmo.com', 'api.vonage.com', 'rest.messagebird.com', 'smtp.gmail.com', 'smtp.office365.com', 'smtp.sendgrid.net', 'smtp.mailgun.org', 'smtp.postmarkapp.com'];
