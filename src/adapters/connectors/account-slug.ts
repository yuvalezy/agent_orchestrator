// Slug + generated-name helpers for dynamic Google accounts. Both account repos
// (channel-accounts-repo for Gmail over channel_instances, calendar-accounts-repo for
// calendar_accounts) turn a free-text label into a stable, URL/SQL-safe slug used to mint a
// UNIQUE channel name / credential ref. The reserved slugs `work`/`personal` are never
// re-minted so a new "Work" account never collides with the seeded Work/Personal rows.

/** The seeded accounts own these slugs (email:gmail:work, GOOGLE_CALENDAR_WORK_OAUTH, …). */
export const RESERVED_ACCOUNT_SLUGS = ['work', 'personal'] as const;

/** Normalize a label to a lowercase [a-z0-9-] slug ('account' when it reduces to empty). */
export function slugify(label: string): string {
  const s = label
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'account';
}

/** A unique slug for `label`: the base slug, else `<base>-2`, `<base>-3`, … skipping `taken`. */
export function uniqueSlug(label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = slugify(label);
  if (!used.has(base)) return base;
  for (let i = 2; ; i += 1) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
}
