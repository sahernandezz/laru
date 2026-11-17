/**
 * A service's, a store's or an external's logo, as Docker Desktop shows it, or its generic icon when Laru does not know
 * its technology. The logos (≈500 KB) load once, apart, the first time one is drawn; until then the generic icon shows.
 */
import { useEffect, useState, type CSSProperties } from 'react';
import { Cloud, FlaskConical, Mail, ShieldCheck, type LucideIcon } from 'lucide-react';
import type { Indexed, MapNode } from '../api.ts';
import { roleOf, techOf, type Role } from '../lib/tech.ts';

/** A piece with no brand Laru knows, by what it does: better than a server or a globe. */
const ROLE_ICON: Record<Role, LucideIcon> = { antivirus: ShieldCheck, mail: Mail, mock: FlaskConical, cloud: Cloud };

type Logos = typeof import('../lib/techIcons.ts');
let logos: Logos | null = null;
let loading: Promise<Logos> | null = null;

export function TechIcon({ g, node, size = 16, fallback, color, style }: { g: Indexed | null | undefined; node: MapNode; size?: number; fallback: LucideIcon; color?: string; style?: CSSProperties }) {
  const role = roleOf(node);
  const Fallback = role ? ROLE_ICON[role] : fallback;
  const [m, setM] = useState(logos);
  useEffect(() => {
    if (m) return;
    let live = true;
    (loading ??= import('../lib/techIcons.ts')).then((x) => { logos = x; if (live) setM(x); }, () => { loading = null; });
    return () => { live = false; };
  }, [m]);
  const key = m ? techOf(g, node, m.ALIASES) : undefined;
  const logo = key ? m!.LOGOS[key] : undefined;
  // a tinted icon (the docs tree's) keeps its own colour: only a colour asked for is passed
  if (!logo) return <Fallback size={size} {...(color ? { color } : {})} style={style} aria-hidden="true" />;
  return <svg className="tech-logo" width={size} height={size} viewBox={logo.v} style={style} role="img" aria-label={logo.t} dangerouslySetInnerHTML={{ __html: `<title>${logo.t}</title>${logo.s}` }} />;
}
