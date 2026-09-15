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

  /*
   * Every `vp-` class a component names must exist in the stylesheet.
   *
   * The Deposits form shipped with `vp-form__full`, which was invented — the
   * real class is `vp-form__wide`. An unknown class is not an error anywhere:
   * TypeScript does not check `className`, the linter does not read CSS, and
   * the browser silently applies nothing. The visible result was a form whose
   * labels sat in the input column, because the element that should have
   * spanned the grid took a single cell and shifted every pair after it.
   *
   * A misspelling is indistinguishable from a deletion here, so this compares
   * the two sets rather than trusting either.
   */
  it('names no CSS class that the stylesheet does not define', () => {
    const declared = new Set<string>();
    for (const sheet of globSync(`${ROOT}/apps/web/src/**/*.css`)) {
      for (const match of readFileSync(sheet, 'utf8').matchAll(/\.(vp-[a-zA-Z0-9_-]+)/g)) {
        if (match[1] !== undefined) declared.add(match[1]);
      }
    }
    expect(declared.size).toBeGreaterThan(0);

    const used = new Map<string, string>();
    for (const file of globSync(`${ROOT}/apps/web/src/**/*.tsx`)) {
      const source = readFileSync(file, 'utf8');
      // Only literal className strings; a template literal builds its name at
      // runtime and cannot be checked from here.
      for (const attr of source.matchAll(/className="([^"{]+)"/g)) {
        for (const name of (attr[1] ?? '').split(/\s+/).filter((n) => n.startsWith('vp-'))) {
          if (!declared.has(name)) used.set(name, file.replace(ROOT, ''));
        }
      }
    }

    expect(
      [...used].map(([name, file]) => `${name} (${file})`),
      'a class with no rule applies nothing, and silently breaks the layout around it',
    ).toEqual([]);
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
