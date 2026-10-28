import type { AppConfig } from './config.js';

export type Pattern = 'popup' | 'redirect' | 'embedded' | 'callback';

export interface ProviderDef {
  id: string;
  name: string;
  pattern: Pattern;
  scopes: string[];
  requiresPKCE: boolean;
  isMeta: boolean;
}

export interface Provider extends ProviderDef {
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string | undefined;
}

export const PROVIDER_DEFS: readonly ProviderDef[] = [
  // Pattern 1: backend-driven popup, completion via postMessage.
  { id: 'google-calendar', name: 'Google Calendar', pattern: 'popup', scopes: ['calendar.events', 'calendar.readonly'], requiresPKCE: true, isMeta: false },
  { id: 'google-sheets', name: 'Google Sheets', pattern: 'popup', scopes: ['spreadsheets', 'drive.file'], requiresPKCE: true, isMeta: false },
  { id: 'zoho-crm', name: 'Zoho CRM', pattern: 'popup', scopes: ['crm.modules.all', 'crm.settings.read'], requiresPKCE: false, isMeta: false },
  { id: 'zoho-bigin', name: 'Zoho Bigin', pattern: 'popup', scopes: ['bigin.modules.all'], requiresPKCE: false, isMeta: false },
  { id: 'zoho-books', name: 'Zoho Books', pattern: 'popup', scopes: ['books.invoices.read', 'books.contacts.read'], requiresPKCE: false, isMeta: false },
  { id: 'hubspot', name: 'HubSpot', pattern: 'popup', scopes: ['crm.objects.contacts.read', 'crm.objects.deals.read'], requiresPKCE: false, isMeta: false },
  { id: 'zoom', name: 'Zoom', pattern: 'popup', scopes: ['meeting:read', 'meeting:write'], requiresPKCE: false, isMeta: false },
  { id: 'razorpay', name: 'Razorpay', pattern: 'popup', scopes: ['read_only'], requiresPKCE: false, isMeta: false },

  // Pattern 2: Meta full-page redirect. One shared handler; only scopes differ.
  { id: 'facebook-lead-ads', name: 'Facebook Lead Ads', pattern: 'redirect', scopes: ['leads_retrieval', 'pages_show_list', 'pages_manage_metadata'], requiresPKCE: false, isMeta: true },
  { id: 'meta-capi', name: 'Meta Conversions API', pattern: 'redirect', scopes: ['ads_management', 'business_management'], requiresPKCE: false, isMeta: true },
  { id: 'meta-catalogue', name: 'Meta Catalogue', pattern: 'redirect', scopes: ['catalog_management', 'business_management'], requiresPKCE: false, isMeta: true },

  // Pattern 3: WhatsApp Embedded Signup (Meta SDK popup + postMessage events).
  { id: 'whatsapp-embedded-signup', name: 'WhatsApp Embedded Signup', pattern: 'embedded', scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'], requiresPKCE: false, isMeta: true },

  // Pattern 4: dedicated SPA callback page.
  { id: 'instagram', name: 'Instagram', pattern: 'callback', scopes: ['instagram_business_basic', 'instagram_business_manage_messages'], requiresPKCE: false, isMeta: true },
];

/** OAUTH_<ID>_<SUFFIX>, e.g. OAUTH_GOOGLE_SHEETS_CLIENT_ID. */
export const providerEnvKey = (id: string, suffix: string) =>
  `OAUTH_${id.toUpperCase().replace(/-/g, '_')}_${suffix}`;

/** Every endpoint and client id comes from env; the mock IdP is only the default. */
export function buildRegistry(cfg: AppConfig): Map<string, Provider> {
  return new Map(
    PROVIDER_DEFS.map((def) => [
      def.id,
      {
        ...def,
        authUrl: cfg.env[providerEnvKey(def.id, 'AUTH_URL')] ?? `${cfg.idpPublicBase}/authorize`,
        tokenUrl: cfg.env[providerEnvKey(def.id, 'TOKEN_URL')] ?? `${cfg.idpInternalBase}/token`,
        clientId: cfg.env[providerEnvKey(def.id, 'CLIENT_ID')] ?? `mock-${def.id}`,
        clientSecret: cfg.env[providerEnvKey(def.id, 'CLIENT_SECRET')],
      },
    ]),
  );
}

export const toPublicProvider = ({ id, name, pattern, scopes, requiresPKCE, isMeta }: ProviderDef) => ({
  id,
  name,
  pattern,
  scopes,
  requiresPKCE,
  isMeta,
});
