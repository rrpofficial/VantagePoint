/**
 * Hash routing (US-8.5).
 *
 * Hash rather than history API, and no router dependency. The SPA is served by
 * Caddy with a `try_files` fallback, so both would work — but a hash keeps the
 * routed state entirely inside the document, which means a deep link cannot
 * depend on server configuration staying correct. One less thing that can break
 * an offline, self-hosted install.
 */
import { useEffect, useState } from 'react';

export const SECTIONS = [
  'Dashboard',
  'Ledger',
  // Its own section rather than a corner of the Ledger: money lent to people is
  // tracked by who owes it and what they have paid, which is a different shape
  // from a portfolio of instruments.
  'Loans',
  // Also its own section: a chit is a monthly commitment with a term and a
  // draw, tracked by instalments paid rather than by units held.
  'Chits',
  'Import',
  'Snapshots',
  'Tax',
  'Compliance',
  'Settings',
] as const;

export type Section = (typeof SECTIONS)[number];

export const hrefFor = (section: Section) => `#/${section.toLowerCase()}`;

function sectionFromHash(hash: string): Section {
  const slug = hash.replace(/^#\/?/, '').toLowerCase();
  return SECTIONS.find((section) => section.toLowerCase() === slug) ?? 'Dashboard';
}

/** Current section, kept in step with the address bar in both directions. */
export function useSection(): Section {
  const [section, setSection] = useState<Section>(() => sectionFromHash(window.location.hash));

  useEffect(() => {
    const onChange = (): void => {
      setSection(sectionFromHash(window.location.hash));
    };
    // Covers the back button and a pasted link, not just in-app clicks.
    window.addEventListener('hashchange', onChange);
    return () => {
      window.removeEventListener('hashchange', onChange);
    };
  }, []);

  return section;
}

export function navigate(section: Section): void {
  window.location.hash = hrefFor(section);
}
