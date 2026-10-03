import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router';
import App from './App.js';
import { AuthProvider } from './lib/auth.js';
import { ProjectScopeProvider } from './lib/projects.js';
import { ThemeProvider } from './lib/theme.js';
import { ToastProvider } from './components/Toast.js';
import { AppErrorBoundary } from './components/AppErrorBoundary.js';
import './index.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5000 },
  },
});

createRoot(rootEl).render(
  <StrictMode>
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <ToastProvider>
            <BrowserRouter>
              <AuthProvider>
                <ProjectScopeProvider>
                  <App />
                </ProjectScopeProvider>
              </AuthProvider>
            </BrowserRouter>
          </ToastProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </AppErrorBoundary>
  </StrictMode>,
);
