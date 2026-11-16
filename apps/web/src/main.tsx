import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { WS } from './api.ts';
import { App } from './App.tsx';
import { AskHost } from './components/ui.tsx';
import './styles.css';

// A text cut with «…» (a long name in a table, a path) says itself whole on hover: the title is put the first time the
// pointer reaches it, and only when it is really cut.
addEventListener('mouseover', (e) => {
  const el = (e.target as Element | null)?.closest?.<HTMLElement>('.chip, td, .clip, .ellipsis, h1, h2, h3, h4, .crumbs span');
  if (el && !el.title && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)) el.title = el.textContent?.trim() ?? '';
});

// The machine's home page is fetched only there: a workspace's page never loads it.
const Home = lazy(() => import('./pages/Home.tsx').then((m) => ({ default: m.Home })));

// A workspace's page lives under its path (/w/<id>/, then the hash route); the service's home page is /.
createRoot(document.getElementById('root')!).render(<StrictMode>{WS ? <><App /><AskHost /></> : <Suspense fallback={null}><Home /></Suspense>}</StrictMode>);
