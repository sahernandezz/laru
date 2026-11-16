/**
 * A working agreement as the agent gets it: how it reaches the agent here, each rule with what Laru does about it (a
 * branch the hook keeps the agent's edits off, a `cmd:` the hook refuses or asks about, or an instruction the agent is
 * only told), and the very text the agent reads.
 */
import { Ban, Bot, CircleCheck, CircleDashed, GitBranch, HelpCircle, Lock, MessageSquareText, NotebookPen, Target } from 'lucide-react';
import { useApi, type DocPiece } from '../api.ts';
import { CopyButton, Skeleton } from '../components/ui.tsx';
import { Markdown } from '../lib/md.tsx';
import { tr } from '../lib/i18n.ts';

interface AgreementData { text: string; inForce: boolean; reaches: { claude: boolean; mcp: boolean; hooks: boolean } }

const list = (p: DocPiece, f: string) => ((p.fields[f] ?? []) as unknown[]).map(String).filter(Boolean);
const cmdOf = (x: string) => /^cmd:\s*(.+)$/.exec(x)?.[1];

function Rule({ text, kind }: { text: string; kind: 'never' | 'confirm' }) {
  const cmd = cmdOf(text);
  return (
    <li className="agr-rule">
      <span className={`agr-ic ${kind}`} aria-hidden="true">{kind === 'never' ? <Ban /> : <HelpCircle />}</span>
      <span className="agr-what">{cmd ? <><span className="faint">{tr('Una orden de terminal que encaje con')}</span> <code>{cmd}</code></> : text}</span>
      {cmd ? <span className={`chip ${kind === 'never' ? 'err' : 'run'}`} title={kind === 'never' ? tr('El hook de Laru rechaza la orden antes de que corra') : tr('El hook de Laru para la orden y te pregunta antes')}>{kind === 'never' ? tr('Laru la bloquea') : tr('Laru te pregunta')}</span>
        : <span className="chip" title={tr('El agente lo lee y lo sigue; nada lo comprueba')}>{tr('Indicación')}</span>}
    </li>
  );
}

export function AgreementView({ p }: { p: DocPiece }) {
  const a = useApi<AgreementData>(`/api/agreement?id=${encodeURIComponent(p.id)}`);
  const never = list(p, 'never'), confirm = list(p, 'confirm'), protectedBranches = list(p, 'protected');
  const purpose = String(p.fields.purpose ?? ''), branches = String(p.fields.branches ?? ''), notes = String(p.fields.notes ?? '');
  const r = a.data?.reaches;
  const via: Array<[boolean | undefined, string, string]> = [
    [r?.claude, 'Claude Code', tr('la importa en cada sesión (CLAUDE.local.md)')],
    [r?.mcp, tr('Servidor MCP de Laru'), tr('la lleva en sus instrucciones: Codex y los demás agentes')],
    [r?.hooks, tr('Hooks de Laru'), tr('hacen cumplir las ramas y las órdenes cmd:')],
  ];
  return (
    <div className="agr">
      <section className="panel agr-intro" aria-labelledby="agr-intro-h">
        <div className="agr-intro-body">
          <span className="agr-bot" aria-hidden="true"><Bot /></span>
          <div>
            <h2 id="agr-intro-h">{tr('Lo que el agente recibe')}</h2>
            <p>{tr('Al empezar cada sesión en este workspace, el agente lee esta forma de trabajo y la pone por encima de la guía general. Lo que puede comprobarse, Laru además lo hace cumplir: en las ramas protegidas no edita código, y las órdenes')}{' '}<code>cmd:</code>{' '}{tr('se bloquean o te las pregunta.')}</p>
            {a.data && !a.data.inForce && <p className="agr-warn">{tr('No es la que está en vigor: el agente sigue otra forma de trabajo de este workspace, o esta está retirada.')}</p>}
          </div>
        </div>
        <ul className="agr-via">
          {via.map(([ok, name, how]) => (
            <li key={name}>{ok === undefined ? <CircleDashed className="faint" /> : ok ? <CircleCheck className="ok-ink" /> : <CircleDashed className="err-ink" />}<b>{name}</b><span className="faint">{ok === false ? tr('no está conectado aquí: se conecta al abrir el agente o con laru mcp') : how}</span></li>
          ))}
        </ul>
      </section>

      <div className="agr-grid">
        {purpose && (
          <section className="panel agr-card wide"><header><Target /><h3>{tr('Para qué')}</h3></header><div className="agr-body"><Markdown text={purpose} /></div></section>
        )}
        <section className="panel agr-card wide"><header><NotebookPen /><h3>{tr('Instrucciones para el agente')}</h3></header>
          {notes ? <div className="agr-body"><Markdown text={notes} /></div>
            : <div className="empty">{tr('Aún no le has dicho al agente cómo quieres que trabaje aquí: cómo entrega un PR o un commit, cómo prueba, cómo te informa. Escríbelo con «Editar», agrupado con títulos: cada título le llega en el momento del que habla.')}</div>}
        </section>
        {(branches || protectedBranches.length > 0) && (
          <section className="panel agr-card wide"><header><GitBranch /><h3>{tr('Ramas')}</h3></header>
            <div className="agr-body">
              {branches && <Markdown text={branches} />}
              {protectedBranches.length > 0 && <div className="agr-locks">
                {protectedBranches.map((b) => <span key={b} className="chip err"><Lock />{b}</span>)}
                <span className="faint">{tr('El agente no edita código en ellas: el hook de Laru se lo impide.')}</span>
              </div>}
            </div>
          </section>
        )}
        <section className="panel agr-card"><header><Ban /><h3>{tr('Nunca')}</h3><span className="meta num">{never.length}</span></header>
          {never.length ? <ul className="agr-rules">{never.map((x) => <Rule key={x} text={x} kind="never" />)}</ul> : <div className="empty">{tr('Nada prohibido todavía.')}</div>}
        </section>
        <section className="panel agr-card"><header><HelpCircle /><h3>{tr('Pedir confirmación')}</h3><span className="meta num">{confirm.length}</span></header>
          {confirm.length ? <ul className="agr-rules">{confirm.map((x) => <Rule key={x} text={x} kind="confirm" />)}</ul> : <div className="empty">{tr('Nada que preguntar antes.')}</div>}
        </section>
      </div>

      <details className="panel agr-text" open>
        <summary><MessageSquareText /><h3>{tr('Tal como lo lee el agente')}</h3><span className="faint">{tr('el texto exacto, en las instrucciones del servidor MCP')}</span>{a.data && <CopyButton value={a.data.text} label={tr('Copiar el texto')} />}</summary>
        {a.data ? <pre className="mono">{a.data.text}</pre> : a.error ? <div className="empty">{a.error}</div> : <Skeleton lines={6} />}
      </details>
    </div>
  );
}
