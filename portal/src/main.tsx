import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './index.css';
import './styles/neumorphic.css';
import App from './App';
import { AuthProvider } from './lib/auth';
import { I18nProvider } from './lib/i18n';
import { ToastProvider } from './components/ui';
import { applyStoredTheme } from './lib/theme';

applyStoredTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <I18nProvider>
        <ToastProvider>
          <AuthProvider>
            <App />
          </AuthProvider>
        </ToastProvider>
      </I18nProvider>
    </BrowserRouter>
  </StrictMode>,
);
