/** The piece a finding belongs to: the one it names, the service it is about, else the application. */
export function ownerOf(subject: string, ids: ReadonlySet<string>, appId: string): string {
  if (ids.has(subject)) return subject;
  const ep = subject.match(/^ep:([^:]+):/);
  const svc = `svc:${(ep ? ep[1] : subject).replace(/^svc:/, '')}`;
  return ids.has(svc) ? svc : appId;
}
