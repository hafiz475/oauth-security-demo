import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type PublicPage } from '../lib/api';

const TOKEN_LIKE_KEY = /token|secret/i;

/**
 * Dev-only tripwire for M2: if the API ever returns a token-shaped field on a
 * page object, rendering stops and the error is shown on screen.
 */
export function assertPublicPage(page: PublicPage): void {
  const leaked = Object.keys(page).filter((k) => TOKEN_LIKE_KEY.test(k));
  if (leaked.length > 0) throw new Error(`M2 violated: page ${page.pageId} arrived with ${leaked.join(', ')}`);
}

export function MetaPagesDemo() {
  const [pageId, setPageId] = useState<string | null>(null);
  const [formId, setFormId] = useState<string | null>(null);

  const pages = useQuery({ queryKey: ['meta-pages'], queryFn: api.metaPages });
  const forms = useQuery({ queryKey: ['meta-forms', pageId], queryFn: () => api.metaForms(pageId!), enabled: pageId !== null });
  const fields = useQuery({
    queryKey: ['meta-fields', pageId, formId],
    queryFn: () => api.metaFields(pageId!, formId!),
    enabled: pageId !== null && formId !== null,
  });

  if (import.meta.env.DEV) pages.data?.pages.forEach(assertPublicPage);

  return (
    <section className="card wide">
      <h2>Meta pages (M2: page tokens stay on the server)</h2>
      <p className="muted">
        The browser only ever holds page ids. Forms and fields are fetched by the backend with the page token from its vault.
      </p>
      {pages.isPending && <p className="muted">Loading pages…</p>}
      {pages.isError && <p className="error">{pages.error.message}</p>}
      {pages.data?.pages.length === 0 && (
        <p className="muted">
          No pages yet. <a href="/">Connect Facebook Lead Ads</a> first.
        </p>
      )}
      <ul className="list" aria-label="pages">
        {pages.data?.pages.map((p) => (
          <li key={p.pageId}>
            <button type="button" className={p.pageId === pageId ? 'selected' : ''} onClick={() => (setPageId(p.pageId), setFormId(null))}>
              {p.name}
            </button>{' '}
            <code>{p.pageId}</code> <small className="muted">{p.category}</small>
          </li>
        ))}
      </ul>
      {forms.data && (
        <>
          <h3>Lead forms</h3>
          <ul className="list" aria-label="forms">
            {forms.data.forms.map((f) => (
              <li key={f.id}>
                <button type="button" className={f.id === formId ? 'selected' : ''} onClick={() => setFormId(f.id)}>
                  {f.name}
                </button>{' '}
                <small className="muted">{f.status}</small>
              </li>
            ))}
          </ul>
        </>
      )}
      {forms.isError && <p className="error">{forms.error.message}</p>}
      {fields.data && (
        <>
          <h3>Fields</h3>
          <ul className="list" aria-label="fields">
            {fields.data.fields.map((f) => (
              <li key={f.key}>
                {f.label} <small className="muted">{f.type}</small>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
