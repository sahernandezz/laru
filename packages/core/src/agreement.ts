/**
 * The workspace's working agreement (`agr:`): what it is for, its branches, what is never done and what is asked first.
 * The agent reads it always (CLAUDE.md imports it, AGENTS.md and the MCP server name it); the hooks enforce the parts
 * that can be: the branches not edited, and the `cmd: <regex>` items, refused (never) or asked about (confirm).
 */
import type { Loaded } from './knowledge/store.ts';
import { loadKnowledge } from './knowledge/store.ts';
import type { Workspace } from './workspace.ts';

export interface AgreementRules { protected: string[]; deny: Array<{ re: RegExp; text: string }>; ask: Array<{ re: RegExp; text: string }> }

/** The agreement in force: the application's, unless it is deprecated. */
export function loadAgreement(ws: Workspace): Loaded | undefined {
  return loadKnowledge(ws).pieces.find((p) => p.type === 'agreement' && p.status !== 'deprecated');
}

const list = (p: Loaded, f: string) => ((p.fields[f] ?? []) as unknown[]).map(String).filter(Boolean);
/** `cmd: <regex>` items as patterns; one that does not compile is left out (knowledge_write refuses it anyway). */
const commands = (items: string[]) => items.flatMap((text) => {
  const m = /^cmd:\s*(.+)$/.exec(text);
  if (!m) return [];
  try { return [{ re: new RegExp(m[1]), text: m[1] }]; } catch { return []; }
});

export function agreementRules(p: Loaded | undefined): AgreementRules {
  if (!p) return { protected: [], deny: [], ask: [] };
  return { protected: list(p, 'protected'), deny: commands(list(p, 'never')), ask: commands(list(p, 'confirm')) };
}

/** The agreement as the agent reads it where no file is imported (the MCP server's instructions). */
export function agreementText(p: Loaded): string {
  const items = (title: string, f: string) => (list(p, f).length ? [`${title}:`, ...list(p, f).map((x) => `- ${x}`)] : []);
  return [
    `Working agreement of this workspace (${p.path}): it rules how you work here, over the general guide.`,
    String(p.fields.purpose ?? ''),
    ...(p.fields.branches ? [`Branches: ${String(p.fields.branches)}`] : []),
    ...items('Branches you never edit code on', 'protected'),
    ...items('Never', 'never'),
    ...items('Ask the person first', 'confirm'),
    ...(p.fields.notes ? [String(p.fields.notes)] : []),
  ].filter(Boolean).join('\n');
}
