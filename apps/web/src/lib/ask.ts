/**
 * A call that can answer 409 with what it would delete ("Aplicar" a scenario on an env that keeps its data, a run of a
 * flow that starts from one): the page shows the question, and a yes sends the call again with `confirm`. The dialog
 * is `AskHost` in ui.tsx, mounted once; a call that cannot be asked about is not caught here.
 */
export class Cancelled extends Error {}

type Host = (q: { text: string; label: string; title?: string }) => Promise<boolean>;
let host: Host | undefined;
export const setAskHost = (h: Host | undefined) => { host = h; };

/** `go()` first; if the service wants a yes, `go(true)` once the person gives it. «No» is a `Cancelled`, which no one reports. */
export async function askFirst<T>(go: (confirm?: true) => Promise<T>, label: string, title?: string): Promise<T> {
  try { return await go(); } catch (e) {
    if ((e as { status?: number }).status !== 409 || !host) throw e;
    if (!(await host({ text: (e as Error).message, label, title }))) throw new Cancelled();
    return go(true);
  }
}

/** A plain question in the app's own dialog (never the browser's): true on a yes. */
export const ask = (text: string, label: string, title?: string): Promise<boolean> => (host ? host({ text, label, title }) : Promise.resolve(confirm(text)));
