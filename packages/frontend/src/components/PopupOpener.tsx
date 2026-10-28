import { useState } from 'react';
import { OAuthPopupError, useOAuthPopup, type LaunchTarget, type PopupResult } from '../hooks/useOAuthPopup';

interface Props {
  label: string;
  allowedOrigins: string[];
  /** Called synchronously inside the click so the popup is not blocked. */
  launch: () => string | LaunchTarget | Promise<LaunchTarget>;
  onSuccess: (result: PopupResult) => void | Promise<void>;
  disabled?: boolean;
}

type Status = { kind: 'idle' } | { kind: 'waiting' } | { kind: 'error'; reason: string };

export function PopupOpener({ label, allowedOrigins, launch, onSuccess, disabled }: Props) {
  const { open } = useOAuthPopup({
    allowedOrigins,
    onRejectedOrigin: (origin) => console.warn('[popup] ignored a message from', origin),
  });
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const onClick = () => {
    setStatus({ kind: 'waiting' });
    open(launch())
      .then(async (result) => {
        await onSuccess(result);
        setStatus({ kind: 'idle' });
      })
      .catch((err: unknown) => {
        setStatus({ kind: 'error', reason: err instanceof OAuthPopupError ? err.reason : String((err as Error).message ?? err) });
      });
  };

  return (
    <span className="action">
      <button type="button" onClick={onClick} disabled={disabled || status.kind === 'waiting'}>
        {status.kind === 'waiting' ? 'Waiting for popup…' : label}
      </button>
      {status.kind === 'error' && <small className="error">Not connected: {status.reason}</small>}
    </span>
  );
}
