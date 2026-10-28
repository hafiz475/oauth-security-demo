export type EmbeddedOutcome =
  | { status: 'finished'; code: string; wabaId: string; phoneNumberId: string }
  | { status: 'cancelled'; step: string | null }
  | { status: 'error'; reason: 'signup_error' | 'timeout' | 'disposed' };

export interface EmbeddedListenerOptions {
  allowedOrigins: string[];
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  timeoutMs?: number;
  /** Called for dropped messages. Receives the origin only, never the payload. */
  warn?: (message: string, origin: string) => void;
}

const parse = (data: unknown): Record<string, any> | null => {
  if (typeof data === 'string') {
    try {
      const v = JSON.parse(data);
      return v && typeof v === 'object' ? v : null;
    } catch {
      return null;
    }
  }
  return data && typeof data === 'object' ? (data as Record<string, any>) : null;
};

/**
 * Listens for WhatsApp Embedded Signup events (M4). Messages from origins not
 * in the allow-list are dropped and reported at WARN without their content.
 * The returned promise always settles (finished, cancelled, error or timeout),
 * so a "connecting…" indicator can never get stuck.
 *
 * The real SDK hands the auth code to the FB.login callback; pass it through
 * `provideCode`. The mock IdP posts it as an FB_LOGIN_RESPONSE message instead.
 */
export function listenForEmbeddedSignup(opts: EmbeddedListenerOptions) {
  const target = opts.target ?? window;
  const allowed = new Set(opts.allowedOrigins);
  const warn = opts.warn ?? ((message, origin) => console.warn(message, origin));

  let settle!: (outcome: EmbeddedOutcome) => void;
  let settled = false;
  let code: string | null = null;
  let session: { wabaId: string; phoneNumberId: string } | null = null;

  const result = new Promise<EmbeddedOutcome>((resolve) => {
    settle = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      target.removeEventListener('message', onMessage);
      resolve(outcome);
    };
  });

  const maybeFinish = () => {
    if (code && session) settle({ status: 'finished', code, ...session });
  };

  const onMessage = (event: MessageEvent) => {
    if (!allowed.has(event.origin)) {
      warn('[embedded-signup] dropped message from origin outside the allow-list', event.origin);
      return;
    }
    const msg = parse(event.data);
    if (!msg) return;
    if (msg.type === 'FB_LOGIN_RESPONSE' && typeof msg.authResponse?.code === 'string') {
      code = msg.authResponse.code;
      maybeFinish();
    } else if (msg.type === 'WA_EMBEDDED_SIGNUP') {
      if (msg.event === 'FINISH' && typeof msg.data?.waba_id === 'string' && typeof msg.data?.phone_number_id === 'string') {
        session = { wabaId: msg.data.waba_id, phoneNumberId: msg.data.phone_number_id };
        maybeFinish();
      } else if (msg.event === 'CANCEL') {
        settle({ status: 'cancelled', step: typeof msg.data?.current_step === 'string' ? msg.data.current_step : null });
      } else if (msg.event === 'ERROR') {
        settle({ status: 'error', reason: 'signup_error' });
      }
    }
  };

  target.addEventListener('message', onMessage);
  const timer = setTimeout(() => settle({ status: 'error', reason: 'timeout' }), opts.timeoutMs ?? 10 * 60 * 1000);

  return {
    result,
    provideCode(value: string) {
      code = value;
      maybeFinish();
    },
    dispose() {
      settle({ status: 'error', reason: 'disposed' });
    },
  };
}
