import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { ThemeProvider } from './theme/ThemeProvider';
import App from './App';
import { ToastProvider } from './state/ToastProvider';
import { ActionRegistryProvider } from './state/ActionRegistry';

const container = document.getElementById('root');
if (!container) throw new Error('Élément racine #root introuvable');

createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <ToastProvider>
        <ActionRegistryProvider>
          <App />
        </ActionRegistryProvider>
      </ToastProvider>
    </ThemeProvider>
  </StrictMode>,
);
