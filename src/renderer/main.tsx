/**
 * Renderer entry point.
 *
 * Fonts are bundled (no network dependency at runtime), which matters because
 * MERQO runs in shops with no reliable internet. Noto Sans Bengali is used for
 * the interface so conjuncts and kars shape correctly on every Windows machine,
 * regardless of which Bengali fonts happen to be installed.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/noto-sans-bengali/400.css';
import '@fontsource/noto-sans-bengali/500.css';
import '@fontsource/noto-sans-bengali/600.css';
import '@fontsource/noto-sans-bengali/700.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import './styles/tokens.css';
import './styles/app.css';
import App from './App';
import { hasBridge } from './api';

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error) {
    // Surfaced to the operator instead of a blank white window.
    console.error('MERQO renderer error', error);
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="lock-screen">
          <div className="lock-card">
            <div className="lock-brand">MERQO</div>
            <h2 style={{ marginTop: 16 }}>কিছু একটা ভুল হয়েছে</h2>
            <p className="muted">
              {this.state.error.message}
              <br />
              <span className="small">
                Data is safe — the database was not touched. Restart the application, or contact
                support with the log file from the data folder.
              </span>
            </p>
            <button className="btn btn-primary" onClick={() => window.location.reload()}>
              আবার চেষ্টা করুন / Retry
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const container = document.getElementById('root');
if (!container) throw new Error('Root element missing');

if (!hasBridge()) {
  container.innerHTML = `
    <div class="lock-screen">
      <div class="lock-card">
        <div class="lock-brand">MERQO</div>
        <h2>Desktop bridge unavailable</h2>
        <p class="muted">This interface must run inside the MERQO desktop application.
        Opening it in a browser cannot reach the database.</p>
      </div>
    </div>`;
} else {
  createRoot(container).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}
