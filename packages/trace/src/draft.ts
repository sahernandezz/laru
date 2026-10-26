/**
 * A session turned into the draft of a flow: its marks become the Pasos, what the person did in each the
 * step's code, and what the services did underneath an `observed.wait`. What was typed is never kept, so a fill is a
 * '…' to write, and what the person saw is not known, so each step's check is a '…' too: `laru check` flags every
 * one until it is written. Pure.
 */
import { noiseOf } from './chain.ts';
import { isBrowser, type Action, type Trace } from './trace.ts';

export interface FlowDraft {
  /** flow.md's fields, in the standard's shape */
  fields: { goal: string; actors: string[]; steps: Array<{ step: string; actor: string; service?: string; expected: string }> };
  /** the map nodes the session reached (svc:, ds:, ext:) */
  needs: string[];
  spec: (title: string) => string;
}

const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
/** a path as the regex that finds it again: ids and numbers are any segment */
const pathRe = (p: string) => `/^${p.split('?')[0].split('/').map((s) => (/^[0-9a-f-]{8,}$|^\d+$/i.test(s) || /^[0-9a-f]{8}-[0-9a-f-]{27}/i.test(s) ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'))).join('\\/')}$/`;
const ACTS = new Set<Action['kind']>(['click', 'dblclick', 'fill', 'type', 'press', 'select', 'check', 'uncheck', 'files']);

/** What a person did, as Playwright; a navigation they caused (a click that loads a page, a redirect) is left out. */
function code(list: Action[]): string[] {
  const out: string[] = [];
  list.forEach((a, i) => {
    const prev = list[i - 1], next = list[i + 1];
    if (a.kind === 'navigate') { if (!prev || a.t0 - prev.t0 > 1500) out.push(`    await page.goto(${q(a.path ?? '/')});`); return; }
    // a click that only focuses the field typed into next; the click a form's Enter makes on its submit button
    if (a.kind === 'click' && next && (next.kind === 'fill' || next.kind === 'type') && next.target === a.target) return;
    if (a.kind === 'click' && prev?.kind === 'press' && prev.key === 'Enter' && a.t0 - prev.t0 < 50) return;
    const on = a.target && /^getBy/.test(a.target) ? `page.${a.target}` : undefined;
    if (!on && a.kind !== 'press') { out.push(`    // ${a.kind} on ${a.target ?? 'a point of the page'}: give it a locator by role and name`, '    todo();'); return; }
    if (a.kind === 'click') out.push(`    await ${on}.click();`);
    else if (a.kind === 'dblclick') out.push(`    await ${on}.dblclick();`);
    else if (a.kind === 'fill' || a.kind === 'type') out.push(`    await ${on}.fill('…'); // what was typed is never kept: write the value`);
    else if (a.kind === 'press') out.push(on ? `    await ${on}.press(${q(a.key ?? 'Enter')});` : `    await page.keyboard.press(${q(a.key ?? 'Enter')});`);
    else if (a.kind === 'select') out.push(`    await ${on}.selectOption('…');`);
    else if (a.kind === 'check' || a.kind === 'uncheck') out.push(`    await ${on}.${a.kind}();`);
    else if (a.kind === 'files') out.push(`    await ${on}.setInputFiles('…'); // the file the person picked`);
  });
  return out;
}

export interface ScenarioDraft {
  /** scenario.md's `given` rows: one per mark of the session, the state each leaves */
  fields: { given: Array<{ kind: 'data'; what: string }> };
  needs: string[];
  setup: (title: string) => string;
}

/**
 * A session turned into the draft of a scenario: what the person did becomes the preparation that puts the system in the
 * state the session left. As with a flow, what was typed is never kept (a '…' to write), and who can sign in once it
 * is applied is for the author to say. Pure.
 */
export function scenarioFromSession(trace: Trace, o: { session: string; title: string; nodes: Set<string> }): ScenarioDraft {
  const flow = draftFromSession(trace, o);
  const marks = trace.steps.length ? trace.steps : [{ n: 1, title: o.title }];
  const actions = (trace.actions ?? []).filter((a) => a.kind === 'navigate' || ACTS.has(a.kind));
  return {
    fields: { given: marks.map((m) => ({ kind: 'data' as const, what: `${m.title} (de la sesión ${o.session})` })) },
    needs: flow.needs,
    setup: (title) => [
      `// ${title}: drafted from session ${o.session}. It plays what the person did, as the preparation of the scenario. What was typed is never kept:`,
      `// write every '…' and todo(), say who can sign in, then laru check and «Aprovisionar» it.`,
      `import { scenario, todo } from '@laru/flow';`,
      '',
      `scenario(${q(title)}, async ({ page, api, uniq }) => {`,
      ...marks.flatMap((m) => {
        const mine = trace.steps.length ? actions.filter((a) => (a.step ?? 1) === (m as { n: number }).n) : actions;
        return [`    // ${m.title}`, ...(mine.length ? code(mine) : ['    todo(); // no action of the person was recorded in this step'])];
      }),
      `    return { identities: [], signedIn: false }; // todo: who can sign in once it is applied`,
      '});',
      '',
    ].join('\n'),
  };
}

export function draftFromSession(trace: Trace, o: { session: string; title: string; nodes: Set<string> }): FlowDraft {
  const marks = trace.steps.length ? trace.steps : [{ n: 1, title: o.title, t0: -Infinity, t1: Infinity }];
  const actions = (trace.actions ?? []).filter((a) => a.kind === 'navigate' || ACTS.has(a.kind));
  const hops = trace.exchanges.filter((e) => !noiseOf(e));
  // what came before the first mark belongs to the first step: opening the app, mostly
  const steps = marks.map((m) => {
    const mine = trace.steps.length ? actions.filter((a) => (a.step ?? 1) === m.n) : actions;
    const inStep = trace.steps.length ? hops.filter((e) => (e.step ?? 1) === m.n) : hops;
    const first = inStep.find((e) => e.kind === 'http' && isBrowser(e.from));
    const behind = first ? inStep.find((e) => e.kind === 'http' && e.from === first.to && o.nodes.has(`svc:${e.to}`)) : undefined;
    const service = [behind?.to, first?.to].map((s) => s && `svc:${s}`).find((s) => s && o.nodes.has(s));
    const waits = [...new Map(inStep.filter((e) => e.kind === 'http' && !isBrowser(e.from) && !['host', 'runner'].includes(e.from) && e.method && e.path)
      .map((e) => [`${e.from} ${e.to} ${e.method} ${pathRe(e.path!)}`, e])).values()].slice(0, 4);
    // what the app sent to a mailbox in this step: the draft waits for it there, not on the wire
    const sent = [...new Map(inStep.filter((e) => e.msg && !e.msg.cb).map((e) => [e.msg!.id, e.msg!])).values()].slice(0, 3);
    return { m, lines: code(mine), service, waits, sent };
  });
  const needs = [...new Set(trace.participants.map((p) => p.node).filter((n): n is string => Boolean(n && o.nodes.has(n))))].sort();
  return {
    fields: {
      goal: `… (borrador de la sesión ${o.session}: qué prueba este recorrido)`,
      actors: ['Usuario'],
      steps: steps.map((s) => ({ step: s.m.title, actor: 'Usuario', ...(s.service ? { service: s.service } : {}), expected: '…' })),
    },
    needs,
    spec: (title) => [
      `// ${title}: drafted from session ${o.session}. What was typed is never kept and what the person saw is not known:`,
      `// write every '…' and todo(), check what each step shows, keep the titles equal to Pasos, then laru check.`,
      `import { expect, step, story, todo } from '@laru/flow';`,
      '',
      `story(${q(title)}, async ({ page, observed${steps.some((s) => s.sent.some((m) => m.kind === 'mail')) ? ', mail' : ''}${steps.some((s) => s.sent.some((m) => m.kind === 'sms')) ? ', sms' : ''} }) => {`,
      ...steps.flatMap((s) => [
        `  await step(${q(s.m.title)}, async () => {`,
        ...(s.lines.length ? s.lines : ['    todo(); // no action of the person was recorded in this step']),
        `    await expect(page.getByText('…')).toBeVisible(); // what the person sees now`,
        ...(s.waits.length ? ['    // what the screen cannot show, as the session saw it'] : []),
        ...s.sent.flatMap((m) => [`    // the app sent ${m.kind === 'mail' ? 'a mail' : 'a text'} to ${m.to}: check it where it arrived, and use its link or code`, m.kind === 'mail' ? `    const mensaje = await mail.waitFor({ to: ${q(m.to.split(',')[0].trim())}${m.subject ? `, subject: ${q(m.subject)}` : ''} });` : `    const codigo = await sms.code(${q(m.to)});`]),
        ...s.waits.map((e) => `    await observed.wait({ from: ${q(e.from)}, to: ${q(e.to)}, method: ${q(e.method!)}, path: ${pathRe(e.path!)} });${e.ok ? '' : ` // it answered ${e.status ?? e.error ?? 'with an error'} in the session`}`),
        '  });',
      ]),
      '});',
      '',
    ].join('\n'),
  };
}
