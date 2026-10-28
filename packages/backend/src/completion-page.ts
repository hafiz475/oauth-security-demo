import { randomBytes } from 'node:crypto';
import type { FastifyReply } from 'fastify';

export interface CompletionMessage {
  status: 'success' | 'error';
  payloadId: string;
  error?: string;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * The last page a popup shows (M4). It posts one message to its opener with an
 * explicit target origin, so the browser drops it if the opener is anything else.
 * It also strips the query string from the popup's history entry.
 */
export function sendCompletionPage(reply: FastifyReply, message: CompletionMessage, targetOrigin: string) {
  const nonce = randomBytes(16).toString('base64');
  const json = JSON.stringify(message).replace(/</g, '\\u003c');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Connecting…</title></head>
<body style="font-family:system-ui,sans-serif;padding:2rem">
<p id="status">Finishing up…</p>
<script type="application/json" id="oauth-result" data-target-origin="${escapeHtml(targetOrigin)}">${json}</script>
<script nonce="${nonce}">
(function () {
  var el = document.getElementById('oauth-result');
  var msg = JSON.parse(el.textContent);
  history.replaceState(null, '', location.pathname);
  if (window.opener) window.opener.postMessage(msg, el.getAttribute('data-target-origin'));
  document.getElementById('status').textContent = msg.status === 'success'
    ? 'Connected. You can close this window.'
    : 'Connection failed (' + msg.error + '). You can close this window.';
  setTimeout(function () { window.close(); }, 600);
})();
</script>
</body></html>`;
  return reply
    .type('text/html; charset=utf-8')
    .header('content-security-policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'`)
    .send(html);
}

export function sendErrorPage(reply: FastifyReply, status: number, title: string, detail: string) {
  return reply
    .code(status)
    .type('text/html; charset=utf-8')
    .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>` +
        `<body style="font-family:system-ui,sans-serif;padding:2rem"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></body></html>`,
    );
}
