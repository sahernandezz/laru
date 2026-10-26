import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { WS } from './api.ts';
import { App } from './App.tsx';
import { AskHost } from './components/ui.tsx';
import { Home } from './pages/Home.tsx';
import './styles.css';

// A workspace's page lives under its path (/w/<id>/, then the hash route); the service's home page is /.
createRoot(document.getElementById('root')!).render(<StrictMode>{WS ? <><App /><AskHost /></> : <Home />}</StrictMode>);
