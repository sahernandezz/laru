/**
 * A piece's tests, said in their own words: by level, with what each level starts and what its failure says; each file
 * by what it tests (its class's @DisplayName or Javadoc, else the class its name names) and each case by its title (its
 * @DisplayName, an `it`'s text), its method small beside it. The service's sheet and a piece's documentation show them.
 */
import { useState } from 'react';
import type { MapNode } from '../api.ts';
import { plural } from '../lib/es.ts';
import { tr } from '../lib/i18n.ts';

export type LiveTest = { file: string; level: string; count: number; title?: string; cases: Array<{ name: string; line: number; title?: string }> };

export const LEVEL: Record<string, string> = { unit: tr('Unitarias'), integration: tr('De integración'), e2e: tr('De punta a punta') };
/** What a level of tests is, for whoever reads it: what it starts and what a failure there says. */
const LEVEL_WHY: Record<string, string> = {
  unit: tr('Prueban una clase sola, sin arrancar la aplicación: son rápidas y, si fallan, señalan la pieza exacta.'),
  integration: tr('Arrancan la aplicación, o parte de ella, y la usan como lo haría otro servicio: por sus endpoints, con su seguridad y su base de datos.'),
  e2e: tr('Un navegador recorre la aplicación entera, como una persona.'),
};
/** A case that says nothing of itself, read from its method's name: `validateToken_expiredToken` is «Validate token · expired token». */
export const caseWords = (name: string) => {
  const s = name.split('_').filter(Boolean).map((p) => p.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase()).join(' · ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};
/** Cases shown at once; the rest open with a click. */
const FEW = 8;

export function TestLevels({ files, eps = [] }: { files: LiveTest[]; eps?: MapNode[] }) {
  return <>{['unit', 'integration', 'e2e'].filter((l) => files.some((x) => x.level === l)).map((l) => (
    <section key={l} className="link-group" aria-label={LEVEL[l]}>
      <h4>{LEVEL[l]} <span className="faint">{plural(files.filter((x) => x.level === l).reduce((n, x) => n + x.count, 0), tr('prueba'), tr('pruebas'))}</span></h4>
      <p className="group-why">{LEVEL_WHY[l]}</p>
      {files.filter((x) => x.level === l).map((x) => <TestSuite key={x.file} x={x} eps={eps} />)}
    </section>
  ))}</>;
}

/** One test file: what it tests, in its words or by its class, and its cases, the first few at once. */
function TestSuite({ x, eps }: { x: LiveTest; eps: MapNode[] }) {
  const [all, setAll] = useState(false);
  const name = x.file.slice(x.file.indexOf(':') + 1).split('/').at(-1)!;
  // the class its name names (`JwtTokenProviderTest` tests JwtTokenProvider), and that class's endpoints
  const cls = name.replace(/\.[^.]+$/, '').replace(/(\.test|\.spec|Tests?|IT|Spec)$/, '');
  const own = eps.filter((ep) => String(ep.attrs?.handler ?? '').split('.')[0] === cls);
  const shown = all ? x.cases : x.cases.slice(0, FEW);
  return (
    <div className="suite">
      <div className="suite-h">
        <span className="suite-t">{x.title ?? tr('Prueba {cls}', { cls })}</span>
        <span className="faint">{x.title ? tr('Prueba {cls}', { cls }) + ' · ' : ''}{plural(x.count, tr('caso'), tr('casos'))}{own.length ? ` · ${plural(own.length, tr('endpoint'), tr('endpoints'))}` : ''}</span>
        <span className="mono faint suite-file" title={x.file}>{name}</span>
      </div>
      <ul className="cases">{shown.map((c) => (
        <li key={c.line}><span className={c.title ? 'case-t' : 'case-t guessed'}>{c.title ?? caseWords(c.name)}</span><span className="mono faint case-m" title={`${x.file}:${c.line}`}>{c.title ? `${c.name}()` : ''}:{c.line}</span></li>
      ))}</ul>
      {x.cases.length > FEW && <button className="linkish" onClick={() => setAll(!all)} aria-expanded={all}>{all ? tr('Ver menos') : tr('Ver los {n} casos', { n: x.cases.length })}</button>}
    </div>
  );
}

