import { Component, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './lib/api';
import { IntegrationsGrid } from './pages/IntegrationsGrid';
import { CallbackPage } from './pages/CallbackPage';
import { MetaPagesDemo } from './pages/MetaPagesDemo';

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    return this.state.error ? (
      <section className="card wide" role="alert">
        <h2 className="error">Stopped</h2>
        <pre>{this.state.error.message}</pre>
      </section>
    ) : (
      this.props.children
    );
  }
}

function Route({ path }: { path: string }) {
  if (path === '/oauth/meta/callback') return <CallbackPage kind="redirect" provider="meta" />;
  const callback = /^\/oauth\/callback\/([\w-]+)$/.exec(path);
  if (callback) return <CallbackPage kind="callback" provider={callback[1]!} />;
  if (path === '/demo/meta-pages') return <MetaPagesDemo />;
  return <IntegrationsGrid />;
}

export function App() {
  // Existing sessions are reused, which matters on callback routes: the state
  // is bound to the session that started the flow.
  const session = useQuery({ queryKey: ['session'], queryFn: api.ensureSession, staleTime: Infinity });

  return (
    <main>
      <header className="top">
        <a href="/" className="brand">
          OAuth Security Demo
        </a>
        {session.data && (
          <small className="muted">
            signed in as {session.data.memberId} @ {session.data.businessUid}
          </small>
        )}
      </header>
      <ErrorBoundary>
        {session.isPending && <p className="muted">Starting demo session…</p>}
        {session.isError && <p className="error">Backend unreachable: {session.error.message}</p>}
        {session.isSuccess && <Route path={window.location.pathname} />}
      </ErrorBoundary>
    </main>
  );
}
