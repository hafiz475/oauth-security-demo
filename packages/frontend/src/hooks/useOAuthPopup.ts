import { useCallback, useEffect, useRef } from 'react';

export interface PopupResult {
  status: 'success';
  payloadId: string;
}

export type PopupFailure = 'blocked' | 'timeout' | 'closed' | 'unmounted' | (string & {});

export class OAuthPopupError extends Error {
  override name = 'OAuthPopupError';
  constructor(
    readonly reason: PopupFailure,
    readonly payloadId?: string,
  ) {
    super(reason);
  }
}

export interface UseOAuthPopupOptions {
  /** Origins allowed to deliver the completion message (usually the API origin). */
  allowedOrigins: string[];
  timeoutMs?: number;
  /**
   * The popup window is never polled. When focus returns to this window
   * and no completion message arrives within this grace period, the flow is
   * treated as abandoned. Going back to the popup (blur) cancels the countdown.
   */
  closeGraceMs?: number;
  /** Called with the origin of each message that was refused. */
  onRejectedOrigin?: (origin: string) => void;
}

export interface LaunchTarget {
  url: string;
  payloadId?: string;
}

const isCompletion = (d: unknown): d is { status: string; payloadId: string; error?: string } =>
  !!d && typeof d === 'object' && typeof (d as { status?: unknown }).status === 'string' && typeof (d as { payloadId?: unknown }).payloadId === 'string';

const envMs = Number(import.meta.env?.VITE_POPUP_ABANDON_MS);
export const DEFAULT_CLOSE_GRACE_MS = Number.isFinite(envMs) && envMs > 0 ? envMs : 1_500;

export function useOAuthPopup(options: UseOAuthPopupOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const active = useRef(new Set<() => void>());

  useEffect(() => {
    const flows = active.current;
    return () => {
      for (const abort of [...flows]) abort();
    };
  }, []);

  /**
   * Accepts a URL, or a promise of one. With a promise the window is opened
   * synchronously (inside the click, so it is not blocked) and navigated once
   * the backend has issued the launch URL.
   */
  const open = useCallback((target: string | LaunchTarget | Promise<LaunchTarget>): Promise<PopupResult> => {
    const { allowedOrigins, timeoutMs = 30_000, closeGraceMs = DEFAULT_CLOSE_GRACE_MS, onRejectedOrigin } = optionsRef.current;
    const immediate = typeof target === 'string' ? { url: target } : target instanceof Promise ? null : target;
    const popup = window.open(immediate?.url ?? 'about:blank', 'oauth', 'popup,width=800,height=600');

    return new Promise<PopupResult>((resolve, reject) => {
      if (!popup) return reject(new OAuthPopupError('blocked'));
      let expectedPayloadId = immediate?.payloadId;
      let graceTimer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        clearTimeout(timeoutTimer);
        clearTimeout(graceTimer);
        window.removeEventListener('message', onMessage);
        window.removeEventListener('focus', onFocus);
        window.removeEventListener('blur', onBlur);
        active.current.delete(abort);
      };
      const fail = (reason: PopupFailure, payloadId?: string) => {
        cleanup();
        reject(new OAuthPopupError(reason, payloadId));
      };
      const abort = () => fail('unmounted');

      const onMessage = (event: MessageEvent) => {
        if (event.source !== popup) return;
        if (!allowedOrigins.includes(event.origin)) {
          onRejectedOrigin?.(event.origin);
          return;
        }
        if (!isCompletion(event.data)) return;
        // A late message from an earlier attempt must not complete this one.
        if (expectedPayloadId && event.data.payloadId !== expectedPayloadId) return;
        cleanup();
        if (event.data.status === 'success') resolve({ status: 'success', payloadId: event.data.payloadId });
        else reject(new OAuthPopupError(event.data.error ?? 'provider_error', event.data.payloadId));
      };
      const onFocus = () => {
        clearTimeout(graceTimer);
        graceTimer = setTimeout(() => fail('closed'), closeGraceMs);
      };
      const onBlur = () => clearTimeout(graceTimer);

      window.addEventListener('message', onMessage);
      window.addEventListener('focus', onFocus);
      window.addEventListener('blur', onBlur);
      active.current.add(abort);
      const timeoutTimer = setTimeout(() => fail('timeout'), timeoutMs);

      if (!immediate) {
        (target as Promise<LaunchTarget>).then(
          (launch) => {
            expectedPayloadId = launch.payloadId;
            popup.location.replace(launch.url);
          },
          (err: unknown) => {
            popup.close();
            fail(err instanceof Error ? err.message : 'launch_failed');
          },
        );
      }
    });
  }, []);

  return { open };
}
