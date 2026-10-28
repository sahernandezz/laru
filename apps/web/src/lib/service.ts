/**
 * Whether the service answers: a miss is not «offline» until it repeats. A ping refused counts whole: nothing listens. One
 * that only ran out of time counts a third: the service is alive and busy, or the browser held the ping behind other
 * requests (six at a time to one host, live streams among them), and a busy service is not a dead one.
 */
export const MISSES = 6;
export function nextMisses(misses: number, answered: boolean, slow = false): number { return answered ? 0 : misses + (slow ? 1 : 3); }
export const isOffline = (misses: number) => misses >= MISSES;
/** The runs that have not finished, newest first: what the sidebar shows as «en curso». */
export const inProgress = <T extends { phase: string; startedAt: string }>(list: T[]): T[] => list.filter((r) => r.phase !== 'done').sort((a, b) => b.startedAt.localeCompare(a.startedAt));
