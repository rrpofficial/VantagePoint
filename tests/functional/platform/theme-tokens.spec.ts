/**
 * US-8.5 / PRD FR-9 — the theme is driven by tokens, not scattered literals.
 *
 * These are guard tests: they should be green from the moment the UI exists and
 * must stay green. A raw hex colour in a component is how a design system stops
 * being one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, globSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');
const TOKENS = resolve(ROOT, 'apps/web/src/theme/tokens.css');

const sources = () => [
  ...globSync(`${ROOT}/apps/web/src/**/*.tsx`),
  ...globSync(`${ROOT}/apps/web/src/**/*.css`),
].filter((file) => !file.endsWith('tokens.css'));

describe('FR-9.1 the theme resolves from tokens', () => {
  it('ships a token sheet', () => {
    expect(existsSync(TOKENS)).toBe(true);
  });

  it('carries the palette sampled from the reference design', () => {
    const tokens = readFileSync(TOKENS, 'utf8');
    for (const value of ['#8891a9', '#e8eaec', '#0e1124', '#e4482f']) {
      expect(tokens.toLowerCase()).toContain(value);
    }
  });

  it('finds application sources to check', () => {
    // Without this the two assertions below would pass on an empty glob.
    expect(sources().length).toBeGreaterThan(0);
  });

  it('declares no raw hex colour outside the token sheet', () => {
    const offenders = sources().filter((file) => /#[0-9a-fA-F]{3,8}\b/.test(readFileSync(file, 'utf8')));
    expect(offenders.map((f) => f.replace(ROOT, ''))).toEqual([]);
  });

  it('uses no hardcoded radius or spacing pixel values in components', () => {
    const offenders = globSync(`${ROOT}/apps/web/src/**/*.tsx`).filter((file) =>
      /style=\{\{[^}]*\d+px/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map((f) => f.replace(ROOT, ''))).toEqual([]);
  });
});

describe('FR-9.2 colour never carries financial direction alone', () => {
  const primitives = () => readFileSync(resolve(ROOT, 'apps/web/src/components/primitives.tsx'), 'utf8');

  it('pairs every delta with an arrow as well as a colour', () => {
    // ~1 man in 12 cannot separate the gain and loss hues reliably.
    expect(primitives()).toMatch(/▲/);
    expect(primitives()).toMatch(/▼/);
  });

  it('renders a zero change as neither gain nor loss', () => {
    expect(primitives()).toContain('flat');
  });

  it('never styles a delta with the brand accent (ADR-017)', () => {
    const css = readFileSync(resolve(ROOT, 'apps/web/src/theme/app.css'), 'utf8');
    const deltaRules = css.match(/\.vp-delta--\w+\s*\{[^}]*\}/g) ?? [];
    expect(deltaRules.length).toBeGreaterThan(0);
    for (const rule of deltaRules) expect(rule).not.toContain('--vp-accent');
  });
});

describe('FR-9.3 fonts are bundled, never fetched', () => {
  it('references no external font origin', () => {
    for (const file of [...sources(), TOKENS]) {
      const content = readFileSync(file, 'utf8');
      expect(content).not.toMatch(/fonts\.googleapis|fonts\.gstatic|use\.typekit|@import\s+url\(/);
    }
  });

  it('renders monetary values with tabular figures', () => {
    expect(readFileSync(TOKENS, 'utf8')).toContain('tabular-nums');
  });
});

describe('The SPA holds no domain logic', () => {
  it('imports no domain package', () => {
    const offenders = globSync(`${ROOT}/apps/web/src/**/*.tsx`).filter((file) =>
      /@vantagepoint\/(core-domain|tax-engine|fx-itbr|snapshot|ingestion|compliance|persistence)/.test(
        readFileSync(file, 'utf8'),
      ),
    );
    expect(offenders, 'the browser must not disagree with the server about a tax figure').toEqual([]);
  });
});
