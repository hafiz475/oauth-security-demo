import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiOrigin, type Pattern, type PublicProvider } from '../lib/api';
import { ConnectButton } from '../components/ConnectButton';
import { PopupOpener } from '../components/PopupOpener';

const PATTERN_LABEL: Record<Pattern, string> = {
  popup: 'Pattern 1 · Backend-driven popup',
  redirect: 'Pattern 2 · Meta full-page redirect',
  embedded: 'Pattern 3 · Embedded Signup (SDK popup)',
  callback: 'Pattern 4 · Dedicated callback page',
};

export function IntegrationsGrid() {
  const providers = useQuery({ queryKey: ['providers'], queryFn: api.providers });
  const connections = useQuery({ queryKey: ['connections'], queryFn: api.connections });

  if (providers.isPending) return <p className="muted">Loading providers…</p>;
  if (providers.isError) return <p className="error">Could not load providers: {providers.error.message}</p>;

  const connected = new Set(connections.data?.connections.map((c) => c.provider));
  const groups = (Object.keys(PATTERN_LABEL) as Pattern[]).map((pattern) => ({
    pattern,
    items: providers.data.providers.filter((p) => p.pattern === pattern),
  }));

  return (
    <>
      <p className="lede">
        Thirteen integrations, four connection patterns, one mock identity provider. Every flow below verifies its
        <code>state</code>, keeps tokens on the server and never puts a credential in a URL.{' '}
        <a href="/demo/meta-pages">Open the Meta pages demo →</a>
      </p>
      {groups.map(({ pattern, items }) => (
        <section key={pattern}>
          <h2>{PATTERN_LABEL[pattern]}</h2>
          <div className="grid">
            {items.map((p) => (
              <ProviderCard key={p.id} provider={p} connected={connected.has(p.id)} />
            ))}
          </div>
        </section>
      ))}
      <section>
        <h2>Credential hand-off (no OAuth) · M3</h2>
        <CredentialCard connected={connected.has('generic-api-key')} />
      </section>
    </>
  );
}

function ProviderCard({ provider, connected }: { provider: PublicProvider; connected: boolean }) {
  return (
    <article className="card">
      <header>
        <strong>{provider.name}</strong>
        {connected && <span className="badge ok">Connected</span>}
      </header>
      <small className="muted">{provider.scopes.join(' · ')}</small>
      <ConnectButton provider={provider} />
    </article>
  );
}

function CredentialCard({ connected }: { connected: boolean }) {
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState('');
  return (
    <article className="card wide">
      <header>
        <strong>Generic API key</strong>
        {connected && <span className="badge ok">Connected</span>}
      </header>
      <small className="muted">
        The key is sent in a POST body and exchanged for a single-use, five-minute handle. Only the handle is ever in a URL.
      </small>
      <input
        type="password"
        autoComplete="off"
        placeholder="Paste any 16+ character value"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
      />
      <PopupOpener
        label="Connect with API key"
        allowedOrigins={[apiOrigin()]}
        disabled={apiKey.length < 16}
        launch={() =>
          api
            .createPending({ app: 'generic-api-key', connectionName: 'Demo API key', credentials: { apiKey } })
            .then((r) => ({ url: r.connectUrl }))
        }
        onSuccess={async () => {
          setApiKey('');
          await queryClient.invalidateQueries({ queryKey: ['connections'] });
        }}
      />
    </article>
  );
}
