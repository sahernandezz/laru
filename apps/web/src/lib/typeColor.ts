/** One colour per kind of piece, so a piece is known at a glance by its icon: a container or a facet, wherever it is drawn. */
export const TYPE_COLOR: Record<string, string> = {
  application: '#6d8cff', module: '#a78bfa', process: '#34d399', repository: '#94a3b8', service: '#22d3ee', datastore: '#2dd4bf', external: '#fb7185',
  plan: '#c084fc', decision: '#fbbf24', contract: '#fb923c', 'data-model': '#818cf8', convention: '#a3e635', guide: '#38bdf8', 'test-plan': '#e879f9',
  flow: '#4ade80', scenario: '#f472b6', runbook: '#f87171', architecture: '#67e8f9', artifact: '#e0a458', versioning: '#a5b4fc', stack: '#7dd3fc',
  infrastructure: '#94d2bd', secrets: '#fcd34d', glossary: '#86efac', term: '#9ca3af', note: '#9ca3af',
};
export const typeColor = (type: string) => TYPE_COLOR[type] ?? '#9ca3af';
