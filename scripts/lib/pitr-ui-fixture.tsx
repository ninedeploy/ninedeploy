import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '/src/lib/auth.tsx';
import { LocaleProvider } from '/src/lib/i18n.tsx';
import { ToastProvider } from '/src/components/Toast.tsx';
import { RemotePitrCard } from '/src/routes/database/RemotePitrCard.tsx';
import '/src/index.css';
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <AuthProvider>
      <LocaleProvider>
        <ToastProvider>
          <main className="mx-auto max-w-4xl p-4">
            <RemotePitrCard db={{ id: 7, name: 'production', engine: 'postgres', serverId: 3 } as never} />
          </main>
        </ToastProvider>
      </LocaleProvider>
    </AuthProvider>
  </QueryClientProvider>,
);
