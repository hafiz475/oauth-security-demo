import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { useOAuthPopup, type UseOAuthPopupOptions } from '../src/hooks/useOAuthPopup';

const API_ORIGIN = 'http://localhost:5173';

describe('popup-completion', () => {
  let frame: HTMLIFrameElement;
  let popup: Window;

  beforeEach(() => {
    // A real WindowProxy stands in for the popup so event.source checks are genuine.
    frame = document.createElement('iframe');
    document.body.appendChild(frame);
    popup = frame.contentWindow!;
    vi.spyOn(window, 'open').mockReturnValue(popup);
  });
  afterEach(() => {
    cleanup();
    frame.remove();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  const send = (data: unknown, origin = API_ORIGIN, source: Window = popup) =>
    window.dispatchEvent(new MessageEvent('message', { data, origin, source }));

  const hook = (opts: Partial<UseOAuthPopupOptions> = {}) =>
    renderHook(() => useOAuthPopup({ allowedOrigins: [API_ORIGIN], ...opts })).result.current;

  const isPending = async (p: Promise<unknown>) => {
    let settled = false;
    p.then(
      () => (settled = true),
      () => (settled = true),
    );
    for (let i = 0; i < 5; i++) await Promise.resolve();
    return !settled;
  };

  it('success event: resolves with the payloadId and removes its listener', async () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const result = hook().open({ url: `${API_ORIGIN}/oauth/popup/zoom?payloadId=p-1`, payloadId: 'p-1' });
    expect(window.open).toHaveBeenCalledWith(`${API_ORIGIN}/oauth/popup/zoom?payloadId=p-1`, 'oauth', 'popup,width=800,height=600');

    send({ status: 'success', payloadId: 'p-1' });
    await expect(result).resolves.toEqual({ status: 'success', payloadId: 'p-1' });
    expect(removeSpy).toHaveBeenCalledWith('message', expect.any(Function));
  });

  it('error event: rejects with the provider error code', async () => {
    const result = hook().open({ url: '/oauth/popup/zoom?payloadId=p-2', payloadId: 'p-2' });
    send({ status: 'error', payloadId: 'p-2', error: 'access_denied' });
    await expect(result).rejects.toMatchObject({ name: 'OAuthPopupError', reason: 'access_denied', payloadId: 'p-2' });
  });

  it('wrong-origin rejected: messages from other origins or other windows never complete the flow', async () => {
    const onRejectedOrigin = vi.fn();
    const result = hook({ onRejectedOrigin }).open({ url: '/oauth/popup/zoom?payloadId=p-3', payloadId: 'p-3' });

    send({ status: 'success', payloadId: 'p-3' }, 'https://evil.example');
    send({ status: 'success', payloadId: 'p-3' }, API_ORIGIN, window); // right origin, wrong window
    expect(await isPending(result)).toBe(true);
    expect(onRejectedOrigin).toHaveBeenCalledWith('https://evil.example');

    send({ status: 'success', payloadId: 'p-3' });
    await expect(result).resolves.toEqual({ status: 'success', payloadId: 'p-3' });
  });

  it('timeout: no message within 30 s rejects with "timeout"', async () => {
    vi.useFakeTimers();
    const result = hook().open('/oauth/popup/zoom?payloadId=p-4');
    const assertion = expect(result).rejects.toMatchObject({ reason: 'timeout' });
    vi.advanceTimersByTime(29_999);
    expect(await isPending(result)).toBe(true);
    vi.advanceTimersByTime(1);
    await assertion;
  });

  it('early-close: focus returning without a message rejects with "closed"; going back to the popup cancels it', async () => {
    vi.useFakeTimers();
    const result = hook({ closeGraceMs: 1_500 }).open('/oauth/popup/zoom?payloadId=p-5');

    window.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(1_000);
    window.dispatchEvent(new Event('blur')); // user went back to the popup
    vi.advanceTimersByTime(5_000);
    expect(await isPending(result)).toBe(true);

    const assertion = expect(result).rejects.toMatchObject({ reason: 'closed' });
    window.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(1_500);
    await assertion;
  });

  it('stale payloadId ignored: a late message from an earlier attempt does not complete this one', async () => {
    const result = hook().open({ url: '/oauth/popup/zoom?payloadId=p-new', payloadId: 'p-new' });
    send({ status: 'success', payloadId: 'p-old' });
    send({ status: 'error', payloadId: 'p-old', error: 'access_denied' });
    expect(await isPending(result)).toBe(true);

    send({ status: 'success', payloadId: 'p-new' });
    await expect(result).resolves.toEqual({ status: 'success', payloadId: 'p-new' });
  });

  it('configurable abandon timeout: VITE_POPUP_ABANDON_MS sets the default grace period; invalid values fall back to 1500 ms', async () => {
    // The default is read when the module loads, so reload it under each env value.
    const loadWith = async (value: string) => {
      vi.stubEnv('VITE_POPUP_ABANDON_MS', value);
      vi.resetModules();
      return import('../src/hooks/useOAuthPopup');
    };
    for (const invalid of ['', 'soon', '0', '-250']) {
      expect((await loadWith(invalid)).DEFAULT_CLOSE_GRACE_MS, invalid).toBe(1_500);
    }
    const configured = await loadWith('4000');
    expect(configured.DEFAULT_CLOSE_GRACE_MS).toBe(4_000);

    // With no closeGraceMs option, the hook waits the configured 4 s, not 1.5 s.
    vi.useFakeTimers();
    const { open } = renderHook(() => configured.useOAuthPopup({ allowedOrigins: [API_ORIGIN] })).result.current;
    const result = open('/oauth/popup/zoom?payloadId=p-env');
    window.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(3_999);
    expect(await isPending(result)).toBe(true);

    const assertion = expect(result).rejects.toMatchObject({ reason: 'closed' });
    vi.advanceTimersByTime(1);
    await assertion;
  });
});
