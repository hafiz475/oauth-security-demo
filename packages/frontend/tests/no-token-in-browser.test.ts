import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MetaPagesDemo } from '../src/pages/MetaPagesDemo';
import { createHarness, injectFetch, runSpaFlow } from '../../backend/tests/helpers';

// Shares the "failure-modes" group with packages/backend/tests/failure-modes.test.ts.
describe('failure-modes', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('FM-11 page token reaching the browser: after a real Lead Ads connection, no page token is in the DOM, storage, cookies, query cache or any response', async () => {
    // Real backend + mock IdP, in-process. Connect Lead Ads so the vault holds real page tokens.
    const h = await createHarness();
    const cookie = await h.login('biz-browser', 'member-1');
    expect((await runSpaFlow(h, cookie, 'redirect', 'facebook-lead-ads')).exchange.statusCode).toBe(200);
    const pages = h.ctx.vault.listPages('biz-browser');
    const pageTokens = pages.map((p) => h.ctx.vault.getPageToken('biz-browser', p.pageId));
    expect(pageTokens).toHaveLength(2);

    // The browser's fetch goes to that backend; every response it receives is recorded.
    const responses: string[] = [];
    vi.stubGlobal('fetch', injectFetch(() => h.app, { cookie: () => cookie, onResponse: (_path, _status, body) => responses.push(body) }));

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(createElement(QueryClientProvider, { client: queryClient }, createElement(MetaPagesDemo)));

    // Click through page -> forms -> fields, as a reviewer would.
    fireEvent.click(await screen.findByRole('button', { name: pages[0]!.name }));
    fireEvent.click(await screen.findByRole('button', { name: 'Request a callback' }));
    await screen.findByText('Full name');
    expect(screen.queryByRole('alert')).toBeNull(); // the dev-only M2 tripwire did not fire

    const surfaces = [
      document.documentElement.outerHTML,
      JSON.stringify({ ...window.localStorage }),
      JSON.stringify({ ...window.sessionStorage }),
      document.cookie,
      JSON.stringify(queryClient.getQueryCache().getAll().map((q) => q.state.data)),
      ...responses,
    ];
    expect(responses).toHaveLength(3);
    for (const token of pageTokens) for (const surface of surfaces) expect(surface).not.toContain(token);
    for (const body of responses) expect(body).not.toMatch(/"[^"]*token[^"]*"\s*:/i);

    await h.close();
  });
});
