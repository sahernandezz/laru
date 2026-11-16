import { tr } from './i18n.ts';
/** The aspects a declaration of production can name, in the words of the interface. */
export const FIDELITY_WORDS: Record<string, string> = {
  image: tr('Imagen'), profile: tr('Perfil'), memory: tr('Memoria'), cpus: tr('CPUs'), protocol: tr('Protocolo'), auth: tr('Autenticación'), mode: tr('Modo (real, contrato, imitado…)'),
  'upload-limit': tr('Límite de subida'), 'read-limit': tr('Límite de lectura'),
};

/** The contrast's verdict, said in the interface's language (the service writes it in Spanish). */
export const VERDICT_WORDS: Record<string, string> = { igual: tr('igual'), distinto: tr('distinto'), aceptado: tr('aceptado'), 'sin referencia': tr('sin referencia'), 'no aplica': tr('no aplica') };

/** What the contrast says an env or production does (in its own Spanish words), in the interface's language; anything else as it came. */
export function fidelityText(s: string): string {
  let m: RegExpExecArray | null;
  if ((m = /^autenticación según (\S+) \(del vault\)$/.exec(s))) return tr('autenticación según {key} (del vault)', { key: m[1] });
  if ((m = /^autenticación desactivada \((.+)\)$/.exec(s))) return tr('autenticación desactivada ({key})', { key: m[1] });
  if ((m = /^autenticación con IdP \((.+)\)$/.exec(s))) return tr('autenticación con IdP ({idp})', { idp: m[1] });
  if ((m = /^autenticación activa \((.+)\)$/.exec(s))) return tr('autenticación activa ({key})', { key: m[1] });
  if ((m = /^imitado \((\w+)\): no lee el fichero$/.exec(s))) return tr('imitado ({mode}): no lee el fichero', { mode: m[1] });
  if ((m = /^run (\S+) sin saltos HTTP medidos$/.exec(s))) return tr('run {id} sin saltos HTTP medidos', { id: m[1] });
  if ((m = /^(.+) · perfil (?:del vault \((.+)\)|(.+))$/.exec(s))) {
    const where = m[1] === 'en tu máquina' ? tr('en tu máquina') : m[1] === 'construido' ? tr('construido') : m[1];
    return m[2] !== undefined ? tr('{where} · perfil del vault ({key})', { where, key: m[2] }) : tr('{where} · perfil {profile}', { where, profile: m[3] === 'por defecto' ? tr('por defecto') : m[3] });
  }
  const fixed: Record<string, string> = {
    'autenticación propia (JWT)': tr('autenticación propia (JWT)'), 'sin autenticación vista': tr('sin autenticación vista'), 'sin límite propio': tr('sin límite propio'), 'sin límite': tr('sin límite'),
    'sin medir: ningún run en este entorno': tr('sin medir: ningún run en este entorno'), 'sin referencia de producción': tr('sin referencia de producción'), 'en tu máquina': tr('en tu máquina'),
  };
  return fixed[s] ?? s;
}
