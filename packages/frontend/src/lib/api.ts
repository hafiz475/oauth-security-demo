import { buildOAuthUrl } from './buildOAuthUrl';

const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '');

/** Origin that serves backend pages, i.e. the expected origin of popup completion messages. */
export const apiOrigin = () => new URL(API_BASE || window.location.origin, window.location.origin).origin;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown, query?: Record<string, string>): Promise<T> {
  const url = buildOAuthUrl(`${API_BASE}${path}`, query);
  const res = await fetch(url.toString(), {
    method,
    credentials: 'include',
    headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `http_${res.status}`);
  return data as T;
}

export type Pattern = 'popup' | 'redirect' | 'embedded' | 'callback';
export type SpaFlowKind = 'redirect' | 'callback';

export interface PublicProvider {
  id: string;
  name: string;
  pattern: Pattern;
  scopes: string[];
  requiresPKCE: boolean;
  isMeta: boolean;
}

export interface Connection {
  payloadId: string;
  provider: string;
  connectedAt: number;
  details: Record<string, unknown>;
}

export interface PublicPage {
  pageId: string;
  name: string;
  category: string | null;
  tasks: string[];
}

export interface EmbeddedConfig {
  payloadId: string;
  state: string;
  appId: string;
  configId: string | null;
  allowedOrigins: string[];
  signupUrl: string;
}

/** Meta's shared handler has no provider segment; Instagram's page does. */
const spaPath = (kind: SpaFlowKind, provider: string, action: string) =>
  kind === 'redirect' ? `/oauth/redirect/${action}` : `/oauth/callback/${provider}/${action}`;

export const api = {
  async ensureSession() {
    try {
      return await request<{ businessUid: string; memberId: string }>('GET', '/session');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return request<{ businessUid: string; memberId: string }>('POST', '/session/demo', {});
      throw err;
    }
  },
  providers: () => request<{ providers: PublicProvider[] }>('GET', '/providers'),
  connections: () => request<{ connections: Connection[] }>('GET', '/connections'),

  startPopup: (provider: string) => request<{ payloadId: string; launchUrl: string }>('POST', `/oauth/popup/${provider}/start`, {}),
  getByPayload: (payloadId: string) => request<Connection>('GET', `/google-oauth2/${payloadId}/getByPayload`),

  startSpaFlow: (kind: SpaFlowKind, provider: string, clientNonce: string) =>
    request<{ payloadId: string; authUrl: string }>('POST', `/oauth/${kind}/${provider}/start`, { clientNonce }),
  verifyState: (kind: SpaFlowKind, provider: string, state: string) =>
    request<{ valid: boolean }>('POST', spaPath(kind, provider, 'verify-state'), { state }),
  exchange: (kind: SpaFlowKind, provider: string, code: string, state: string) =>
    request<{ status: 'success'; provider: string; payloadId: string }>('POST', spaPath(kind, provider, 'exchange'), { code, state }),

  embeddedConfig: (provider: string) => request<EmbeddedConfig>('POST', `/oauth/embedded/${provider}/config`, {}),
  embeddedComplete: (provider: string, body: { state: string; code: string; wabaId: string; phoneNumberId: string }) =>
    request<{ status: 'success'; payloadId: string }>('POST', `/oauth/embedded/${provider}/complete`, body),

  createPending: (body: { app: string; connectionName: string; credentials: Record<string, unknown> }) =>
    request<{ pendingId: string; expiresAt: number; connectUrl: string }>('POST', '/integration/pending', body),

  metaPages: () => request<{ pages: PublicPage[] }>('GET', '/meta/pages'),
  metaForms: (pageId: string) =>
    request<{ forms: Array<{ id: string; name: string; status: string }> }>('GET', `/meta/pages/${encodeURIComponent(pageId)}/forms`),
  metaFields: (pageId: string, formId: string) =>
    request<{ fields: Array<{ key: string; label: string; type: string }> }>('GET', `/meta/pages/${encodeURIComponent(pageId)}/fields`, undefined, {
      formId,
    }),
};
