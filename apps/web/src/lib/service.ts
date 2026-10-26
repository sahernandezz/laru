/** Whether the service answers: a miss is not «offline» until it repeats (a slow answer is not a dead service). */
export const MISSES = 2;
export function nextMisses(misses: number, answered: boolean): number { return answered ? 0 : misses + 1; }
export const isOffline = (misses: number) => misses >= MISSES;
/** The runs that have not finished, newest first: what the sidebar shows as «en curso». */
export const inProgress = <T extends { phase: string; startedAt: string }>(list: T[]): T[] => list.filter((r) => r.phase !== 'done').sort((a, b) => b.startedAt.localeCompare(a.startedAt));
