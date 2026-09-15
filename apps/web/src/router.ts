/**
 * Hash routing, two levels deep (US-8.5).
 *
 * Hash rather than the history API, and still no router dependency. The SPA is
 * served by Caddy with a `try_files` fallback so both would work — but a hash
 * keeps the routed state entirely inside the document, which means a deep link
 * cannot depend on server configuration staying correct. One less thing that can
 * break an offline, self-hosted install.
 *
 * **Why two levels.** The nav previously mixed two taxonomies at one level:
 * Equity, Non-Equity, Immovable, Loans and Chits all answer "what do I own?",
 * while Import, Snapshots, Tax and Compliance are each a distinct activity.
 * Presenting them as peers asked the reader to hold two mental models in one row,
 * and eleven items is past where a nav bar stays scannable — worse at phone
 * width, where it wraps to three lines.
 *
 * The asset tabs stay visible as a secondary row throughout the Assets area, so
 * the extra level is paid once on entry rather than on every lateral move.
 */
import { useEffect, useState } from 'react';

/*
 * Nav order follows how often a section is opened, not the order work happens
 * in. Import sits late beside Settings because it is where you go to LOAD data,
 * which is occasional; Dashboard, Assets and Tax are where you go to read it.
 */
export const SECTIONS = [
  'Dashboard',
  'Assets',
  'Snapshots',
  'Tax',
  'Compliance',
  'Import',
  'Settings',
] as const;

export type Section = (typeof SECTIONS)[number];

/**
 * Overview first, and it is a real screen rather than a redirect to Equity.
 *
 * A grouping level that only forwards somewhere else is dead weight — it costs a
 * click and returns nothing. This one shows the split across all five buckets,
 * which is the question the grouping itself implies.
 */
export const ASSET_TABS = [
  'Overview',
  'Equity',
  'Non-Equity',
  'Immovable',
  'Loans',
  'Chits',
] as const;

export type AssetTab = (typeof ASSET_TABS)[number];

const slug = (value: string) => value.toLowerCase();

export const hrefFor = (section: Section) => `#/${slug(section)}`;
export const assetHrefFor = (tab: AssetTab) =>
  tab === 'Overview' ? '#/assets' : `#/assets/${slug(tab)}`;

export interface Route {
  readonly section: Section;
  /** Only meaningful when `section` is 'Assets'. */
  readonly assetTab: AssetTab;
}

function routeFromHash(hash: string): Route {
  const parts = hash
    .replace(/^#\/?/, '')
    .split('/')
    .filter((part) => part.length > 0)
    .map(slug);

  const [head, tail] = parts;

  /*
   * A bare asset-tab slug still resolves, so links made before the grouping —
   * `#/equity`, `#/loans` — keep working rather than silently landing on the
   * Dashboard. Bookmarks outlive refactors.
   */
  const bareTab = ASSET_TABS.find((tab) => slug(tab) === head && tab !== 'Overview');
  if (bareTab !== undefined) return { section: 'Assets', assetTab: bareTab };

  const section = SECTIONS.find((candidate) => slug(candidate) === head);
  if (section === undefined) return { section: 'Dashboard', assetTab: 'Overview' };
  if (section !== 'Assets') return { section, assetTab: 'Overview' };

  const assetTab = ASSET_TABS.find((tab) => slug(tab) === tail);
  return { section: 'Assets', assetTab: assetTab ?? 'Overview' };
}

/** Current route, kept in step with the address bar in both directions. */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => routeFromHash(window.location.hash));

  useEffect(() => {
    const onChange = (): void => {
      setRoute(routeFromHash(window.location.hash));
    };
    // Covers the back button and a pasted link, not just in-app clicks.
    window.addEventListener('hashchange', onChange);
    return () => {
      window.removeEventListener('hashchange', onChange);
    };
  }, []);

  return route;
}

export function navigate(section: Section): void {
  window.location.hash = hrefFor(section);
}

export function navigateToAsset(tab: AssetTab): void {
  window.location.hash = assetHrefFor(tab);
}
