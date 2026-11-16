/** Ajustes › Idioma: the interface in Spanish or English, kept in this browser; a change reloads the page in it. */
import { Segmented } from '../components/ui.tsx';
import { LANG, setLang, tr, type Lang } from '../lib/i18n.ts';

export function Language() {
  return (
    <div className="page">
      <div className="head"><div><h1>{tr('Idioma')}</h1><p>{tr('El idioma de la interfaz. Se guarda en este navegador; la documentación de cada workspace sigue en el suyo.')}</p></div></div>
      {/* each language says its own name: whoever looks for theirs finds it whatever the page is in */}
      <Segmented<Lang> label={tr('Idioma')} value={LANG} onChange={(l) => { if (l !== LANG) setLang(l); }} options={[{ key: 'es', label: 'Español' }, { key: 'en', label: 'English' }]} />
    </div>
  );
}
