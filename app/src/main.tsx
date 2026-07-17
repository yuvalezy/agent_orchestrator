import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './index.css';
import { App } from './App';
import { registerServiceWorker } from './swClient';

// basename '/app' matches the mount point; the backend SPA-fallbacks every non-file
// path under /app to index.html, so client routes like /app/customer/:id load directly.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename="/app">
      <App />
    </BrowserRouter>
  </StrictMode>,
);

// One worker owns the '/app/' scope: app shell + Firebase background push. If push was
// enabled earlier, the persisted config rides in on the registration URL so the same
// push-enabled worker comes back on this cold start (see swClient.ts / push.ts).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { void registerServiceWorker(); });
}
