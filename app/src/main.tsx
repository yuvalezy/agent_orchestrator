import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './index.css';
import { App } from './App';
import { registerServiceWorker, reportDisplayMode } from './swClient';

// basename '/app' matches the mount point; the backend SPA-fallbacks every non-file
// path under /app to index.html, so client routes like /app/customer/:id load directly.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename="/app">
      <App />
    </BrowserRouter>
  </StrictMode>,
);

// One worker owns the '/app/' scope: app shell + background push (see swClient.ts / push.ts).
// Telling it whether we are the INSTALLED app is part of registering: on a notification tap the
// worker must be able to prefer this window over a stray browser tab, and it cannot tell them
// apart on its own. Repeated on visibility changes because the controller is often still null
// on the very first load, right after the worker installs.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { void registerServiceWorker().then(() => reportDisplayMode()); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) reportDisplayMode(); });
}
