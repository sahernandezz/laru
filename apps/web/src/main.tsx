import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { WS } from './api.ts';
import { App } from './App.tsx';
import { AskHost } from './components/ui.tsx';
import './styles.css';

// The machine's home page is fetched only there: a workspace's page never loads it.
const Home = lazy(() => import('./pages/Home.tsx').then((m) => ({ default: m.Home })));

// A workspace's page lives under its path (/w/<id>/, then the hash route); the service's home page is /.
createRoot(document.getElementById('root')!).render(<StrictMode>{WS ? <><App /><AskHost /></> : <Suspense fallback={null}><Home /></Suspense>}</StrictMode>);
