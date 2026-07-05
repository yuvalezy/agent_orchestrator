// Pure email-domain derivation (blueprint §1). Prefer the BP website host; fall
// back to the domain of a known email. Used to populate agent_customers.
// email_domain, which the contact-resolution `propose` path matches against.

function stripWww(host: string): string {
  return host.replace(/^www\./, '');
}

function hostFromUrl(website: string): string | undefined {
  const raw = website.trim();
  if (!raw) return undefined;
  // new URL() needs a scheme; assume http for bare hosts like "acme.example.com".
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const host = new URL(withScheme).hostname.toLowerCase();
    const stripped = stripWww(host);
    return stripped || undefined;
  } catch {
    return undefined;
  }
}

function domainFromEmail(email: string): string | undefined {
  const at = email.lastIndexOf('@');
  if (at < 0) return undefined;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain ? stripWww(domain) : undefined;
}

/** Derive an email domain from a website (preferred) or a fallback email. */
export function deriveEmailDomain(
  website?: string | null,
  emailFallback?: string | null,
): string | undefined {
  if (website) {
    const fromSite = hostFromUrl(website);
    if (fromSite) return fromSite;
  }
  if (emailFallback) {
    const fromEmail = domainFromEmail(emailFallback);
    if (fromEmail) return fromEmail;
  }
  return undefined;
}
