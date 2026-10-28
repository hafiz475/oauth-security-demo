import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, apiOrigin, type PublicProvider } from '../lib/api';
import { listenForEmbeddedSignup } from '../lib/embeddedSignup';
import { useOAuthState } from '../hooks/useOAuthState';
import { PopupOpener } from './PopupOpener';

export function ConnectButton({ provider }: { provider: PublicProvider }) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['connections'] });

  switch (provider.pattern) {
    case 'popup':
      return (
        <PopupOpener
          label="Connect"
          allowedOrigins={[apiOrigin()]}
          launch={() => api.startPopup(provider.id).then((r) => ({ url: r.launchUrl, payloadId: r.payloadId }))}
          onSuccess={async ({ payloadId }) => {
            await api.getByPayload(payloadId);
            await refresh();
          }}
        />
      );
    case 'redirect':
    case 'callback':
      return <RedirectButton provider={provider} />;
    case 'embedded':
      return <EmbeddedSignupButton provider={provider} onDone={refresh} />;
  }
}

function RedirectButton({ provider }: { provider: PublicProvider }) {
  const tab = useOAuthState();
  const start = useMutation({
    mutationFn: async () => {
      const clientNonce = tab.start();
      const { authUrl } = await api.startSpaFlow(provider.pattern as 'redirect' | 'callback', provider.id, clientNonce);
      window.location.assign(authUrl);
    },
  });
  return (
    <span className="action">
      <button type="button" onClick={() => start.mutate()} disabled={start.isPending}>
        {start.isPending ? 'Redirecting…' : 'Connect'}
      </button>
      {start.isError && <small className="error">Not connected: {start.error.message}</small>}
    </span>
  );
}

/**
 * Stand-in for FB.login with Embedded Signup. The real SDK opens its own popup
 * on facebook.com; the mock IdP plays that role here and emits the same events.
 */
function EmbeddedSignupButton({ provider, onDone }: { provider: PublicProvider; onDone: () => Promise<void> }) {
  const signup = useMutation({
    mutationFn: async (popup: Window | null) => {
      if (!popup) throw new Error('popup_blocked');
      const cfg = await api.embeddedConfig(provider.id);
      const listener = listenForEmbeddedSignup({ allowedOrigins: cfg.allowedOrigins });
      popup.location.replace(cfg.signupUrl);
      const outcome = await listener.result;
      if (outcome.status === 'cancelled') return `Cancelled at ${outcome.step ?? 'an unknown step'}`;
      if (outcome.status === 'error') throw new Error(outcome.reason);
      await api.embeddedComplete(provider.id, {
        state: cfg.state,
        code: outcome.code,
        wabaId: outcome.wabaId,
        phoneNumberId: outcome.phoneNumberId,
      });
      await onDone();
      return null;
    },
  });
  return (
    <span className="action">
      <button
        type="button"
        disabled={signup.isPending}
        onClick={() => signup.mutate(window.open('about:blank', 'wa-embedded-signup', 'popup,width=600,height=720'))}
      >
        {signup.isPending ? 'Waiting for signup…' : 'Connect'}
      </button>
      {signup.isError && <small className="error">Not connected: {signup.error.message}</small>}
      {signup.data && <small className="muted">{signup.data}</small>}
    </span>
  );
}
