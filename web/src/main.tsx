import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// An error that an error boundary caught is already shown to the person (the Markdown preview falls back to
// plain text with a notice), so it is a warning here, not an uncaught error.
createRoot(document.getElementById('root')!, {
  onCaughtError: (error, info) => console.warn('Caught by an error boundary:', error, info.componentStack),
  // When an error comes up while rendering concurrently, React retries synchronously and reports this
  // wrapper (#520) as "recoverable", even though the boundary then handled the real error.
  onRecoverableError: (error) => console.warn('React recovered from an error:', error),
}).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
