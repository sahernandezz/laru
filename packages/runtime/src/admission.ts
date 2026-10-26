/**
 * Whether a start fits in the memory Docker has, decided from numbers so it can be tested: what every running container
 * holds (Laru's and anybody else's — the machine does not tell them apart), what an instance still starting will hold
 * once it settles (its first reading is small), and what this start needs. When it does not fit it names who holds the
 * memory and, if stopping one env of this workspace would make it fit, offers that.
 */
export interface Held { key: string; app: string; env: string; run: string; memBytes: number; startedAt?: string }
export interface Offer { app: string; env: string; memBytes: number }
export interface Decision {
  fits: boolean;
  totalBytes: number; needBytes: number; usedBytes: number; foreignBytes: number;
  others: Held[];
  /** the persistent env of this workspace whose stop would make it fit */
  offer?: Offer;
}

/** How long after it starts an env is still growing: its reading undercounts what it will hold. */
export const SETTLING_MS = 5 * 60_000;

export function decide(o: {
  total: number; need: number;
  /** every Laru env running (an instance has a `run`), with what its containers hold now */
  laru: Held[];
  /** every running container's memory, Laru's included */
  allBytes: number;
  /** what an env settles at, when this workspace knows it */
  settled: (h: Held) => number | undefined;
  /** the workspace and the env asking, so a stop is only offered for its own */
  mine: { key: string };
  now?: number;
}): Decision {
  const now = o.now ?? Date.now();
  const counted = o.laru.map((h) => {
    const young = h.startedAt && now - Date.parse(h.startedAt) < SETTLING_MS;
    return { ...h, memBytes: young ? Math.max(h.memBytes, o.settled(h) ?? 0) : h.memBytes };
  });
  const laruNow = o.laru.reduce((n, h) => n + h.memBytes, 0);
  // what is not Laru's counts as held, and so does the growth still to come of what is
  const foreignBytes = Math.max(0, o.allBytes - laruNow);
  const used = foreignBytes + counted.reduce((n, h) => n + h.memBytes, 0);
  const fits = !o.total || used + o.need <= 0.9 * o.total;
  const d: Decision = { fits, totalBytes: o.total, needBytes: o.need, usedBytes: used, foreignBytes, others: counted.sort((a, b) => b.memBytes - a.memBytes) };
  if (!fits) {
    const own = counted.filter((h) => h.key === o.mine.key && !h.run).sort((a, b) => b.memBytes - a.memBytes);
    // the smallest stop that is enough
    const enough = own.filter((h) => used - h.memBytes + o.need <= 0.9 * o.total).sort((a, b) => a.memBytes - b.memBytes)[0];
    if (enough) d.offer = { app: enough.app, env: enough.env, memBytes: enough.memBytes };
  }
  return d;
}
