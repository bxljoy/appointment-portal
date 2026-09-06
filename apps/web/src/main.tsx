import { createRoot } from 'react-dom/client';
import { Providers } from './app/providers';
import { AppRouter } from './app/router';
import { loadPublicConfig } from './lib/config';
import './index.css';

// No React tree or auth client is created until runtime config has been validated.
async function bootstrap() {
  const rootElement = document.getElementById('root');
  if (!rootElement) throw new Error('Application root is missing.');
  try {
    const config = await loadPublicConfig();
    createRoot(rootElement).render(<Providers config={config}><AppRouter /></Providers>);
  } catch {
    createRoot(rootElement).render(<main className="auth-panel" role="alert"><p className="eyebrow">Appointment portal</p><h1>We could not start the portal</h1><p>Application configuration is unavailable or invalid. Reload the page to try again.</p><button className="reload-button" onClick={() => window.location.reload()}>Reload page</button></main>);
  }
}
void bootstrap();
