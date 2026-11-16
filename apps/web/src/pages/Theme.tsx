/** Ajustes › Tema: the variants of Lusitania, each card in its own colours; the choice applies at once. */
import { useState } from 'react';
import { currentTheme, setTheme, THEMES } from '../lib/theme.ts';
import { tr } from '../lib/i18n.ts';

export function Theme() {
  const [at, setAt] = useState(currentTheme);
  return (
    <div className="page">
      <div className="head"><div><h1>{tr('Tema')}</h1><p>{tr('Las variantes de Lusitania, el tema de VS Code, con su paleta Material Oceanic en el código. Se guarda en este navegador.')}</p></div></div>
      <div className="themes" role="radiogroup" aria-label={tr('Tema')}>
        {THEMES.map((t) => (
          <button key={t.id} type="button" role="radio" aria-checked={at === t.id} className="theme-card" data-theme={t.id} onClick={() => { setTheme(t.id); setAt(t.id); }}>
            <span className="shot" aria-hidden="true"><i /><pre>{'{\n  '}<span style={{ color: 'var(--syn-key)' }}>{tr('"estado"')}</span>{': '}<span style={{ color: 'var(--syn-str)' }}>{tr('"pasa"')}</span>{',\n  '}<span style={{ color: 'var(--syn-key)' }}>{tr('"ms"')}</span>{': '}<span style={{ color: 'var(--syn-num)' }}>84</span>{'\n}'}</pre></span>
            <span className="name">{t.name}<span>{t.light ? tr('claro') : tr('oscuro')}</span></span>
          </button>
        ))}
      </div>
    </div>
  );
}
