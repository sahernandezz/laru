/**
 * Accepting something on purpose, with the reason that goes to findings.yaml, and the prompt that hands a finding to the
 * crew. Used by «Lo que debe» of every sheet: findings live there, next to the piece they are about.
 */
import { useId, useState, type FormEvent } from 'react';
import { api, type Finding } from '../api.ts';
import { Dialog, toast } from './ui.tsx';
import { FINDING, findingText, plural, SEVERITY } from '../lib/es.ts';
import { tr } from '../lib/i18n.ts';

/** Evidence that is only a number is a run. */
const evidenceText = (e: string) => (/^\d+$/.test(e) ? `run ${e}` : e);

/** The prompt «Pedir arreglo» copies: everything the developer agent needs, and when it is done. */
export function fixPrompt(f: Finding, app: string, env?: string): string {
  return [
    tr('Usa el agente developer para arreglar un hallazgo de Laru en {p0}.', { p0: app || tr('este aplicativo') }),
    '',
    tr('Hallazgo: {what} ({type}), severidad {severity}', { what: FINDING[f.type] ?? f.type, type: f.type, severity: SEVERITY[f.severity].label.toLowerCase() }),
    tr('Clave: {key}', { key: f.key }),
    `Sujeto: ${f.subject}`,
    tr('Qué pasa: {findingText}', { findingText: findingText(f) }),
    tr('Evidencia: {evidence}', { evidence: f.evidence ? evidenceText(f.evidence) : tr('ninguna adjunta; laru findings lo vuelve a mostrar') }),
    '',
    tr('Antes de tocar nada, pide a Laru context("{subject}"). Después de editar, pasa impact por el diff y ejecuta los flujos afectados con laru test --affected{p1}.', { subject: f.subject, p1: env ? tr(' sobre {env}', { env }) : '' }),
    tr('Hecho significa: los flujos afectados en verde y este hallazgo fuera de laru findings.'),
  ].join('\n');
}

/** What is accepted: its key in findings.yaml, what to call it and what it says. */
export interface Acceptable { key: string; title: string; text: string }
export function Accept({ f, onClose, onDone, remaining }: { f: Acceptable; onClose: () => void; onDone: () => void; remaining?: number }) {
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ids = useId();
  const today = new Date().toISOString().slice(0, 10);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!reason.trim()) { setError(tr('Di por qué se acepta: quien lo lea en findings.yaml tiene que entenderlo.')); return; }
    setBusy(true);
    setError('');
    try {
      await api('/api/findings/accept', { method: 'POST', body: { key: f.key, reason: reason.trim(), until: until || undefined } });
      toast(tr('Aceptado{p0}{p1}', { p0: until ? tr(' hasta el {until}', { until }) : '', p1: remaining === undefined ? '' : tr('. Quedan {n}', { n: plural(remaining, tr('hallazgo abierto'), tr('hallazgos abiertos')) }) }));
      onClose();
      onDone();
    } catch (err) { setError((err as Error).message); setBusy(false); }
  };
  return (
    <Dialog title={tr('Aceptar: {title}', { title: f.title })} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <div className="dlg-body form">
          <p>{f.text}</p>
          <p className="mono faint key-line">{f.key}</p>
          <div className="fld">
            <label className="l" htmlFor={`${ids}-r`}>{tr('Motivo')}</label>
            <textarea id={`${ids}-r`} data-autofocus rows={3} value={reason} onChange={(e) => setReason(e.target.value)} aria-describedby={`${ids}-rh`} aria-invalid={Boolean(error && !reason.trim()) || undefined} />
            <span className="h" id={`${ids}-rh`}>{tr('Queda en findings.yaml con tu usuario. Un hallazgo aceptado no vuelve a aparecer como abierto.')}</span>
          </div>
          <div className="fld">
            <label className="l" htmlFor={`${ids}-u`}>{tr('Hasta, si caduca')}</label>
            <input id={`${ids}-u`} type="date" min={today} value={until} onChange={(e) => setUntil(e.target.value)} aria-describedby={`${ids}-uh`} />
            <span className="h" id={`${ids}-uh`}>{tr('Pasada esa fecha el hallazgo vuelve a abrirse solo. Sin fecha, se acepta hasta que alguien lo quite.')}</span>
          </div>
          {error && <p className="form-err" role="alert">{error}</p>}
        </div>
        <footer>
          <button type="button" className="btn" onClick={onClose}>{tr('Cancelar')}</button>
          <button className="btn primary" aria-disabled={busy || undefined}>{tr('Aceptar')}</button>
        </footer>
      </form>
    </Dialog>
  );
}
