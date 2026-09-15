/**
 * US-8.1 — Monorepo scaffolding and toolchain
 *
 * Architecture guard tests. Unlike feature tests these are expected to be GREEN
 * from day one and to stay green — they fail the moment someone violates a
 * layering rule or weakens strictness.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, globSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');
/*
 * Typed at the boundary rather than left as `any`. `JSON.parse` returns `any`,
 * and letting that spread means a typo in a config key reads as `undefined` and
 * the assertion quietly passes — in a test whose whole job is to assert that
 * strict settings are on.
 */
const readJson = (rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(ROOT, rel), 'utf8')) as Record<string, unknown>;

const DOMAIN_PACKAGES = [
  'shared-kernel',
  'core-domain',
  'fx-itbr',
  'tax-engine',
  'snapshot',
  'ingestion',
  'compliance',
  'pii-masker',
];

describe('US-8.1 Scenario: Strict TypeScript is enforced', () => {
  const base = () =>
    readJson('tsconfig.base.json').compilerOptions as Record<string, unknown>;

  it.each(['strict', 'noUncheckedIndexedAccess', 'exactOptionalPropertyTypes'])(
    'sets %s to true',
    (flag) => {
      expect(base()[flag]).toBe(true);
    },
  );

  it('has no `any` in any package source', () => {
    const offenders = globSync(`${ROOT}/packages/*/src/**/*.ts`).filter((file) =>
      /(:\s*any\b|<any>|as any\b)/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map((f) => f.replace(ROOT, ''))).toEqual([]);
  });

  it('has no non-null assertions in any package source (DoD D4)', () => {
    const offenders = globSync(`${ROOT}/packages/*/src/**/*.ts`).filter((file) =>
      /\w!\.|\w!\)|\w!;/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map((f) => f.replace(ROOT, ''))).toEqual([]);
  });
});

describe('US-8.1 Scenario: Layering violations fail the build', () => {
  it('has no domain package importing from apps/', () => {
    const offenders = globSync(`${ROOT}/packages/*/src/**/*.ts`).filter((file) =>
      /from ['"].*apps\//.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map((f) => f.replace(ROOT, ''))).toEqual([]);
  });

  it('has no pure domain package importing persistence or adapters', () => {
    const offenders: string[] = [];
    for (const pkg of DOMAIN_PACKAGES) {
      for (const file of globSync(`${ROOT}/packages/${pkg}/src/**/*.ts`)) {
        const source = readFileSync(file, 'utf8');
        if (/@porttrack\/(persistence|adapters-|app-services)/.test(source)) {
          offenders.push(file.replace(ROOT, ''));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('has no pure domain package touching the filesystem or the clock', () => {
    const offenders: string[] = [];
    for (const pkg of DOMAIN_PACKAGES) {
      for (const file of globSync(`${ROOT}/packages/${pkg}/src/**/*.ts`)) {
        const source = readFileSync(file, 'utf8');
        if (/from ['"]node:fs['"]|Date\.now\(\)|new Date\(\)/.test(source)) {
          offenders.push(file.replace(ROOT, ''));
        }
      }
    }
    expect(offenders, 'time and I/O must be injected via ports').toEqual([]);
  });
});

describe('US-8.1 Scenario: The workspace is coherent', () => {
  it('declares every package in the pnpm workspace', () => {
    expect(readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8')).toContain('packages/*');
  });

  it('gives every package a @porttrack-scoped name', () => {
    for (const manifest of globSync(`${ROOT}/packages/*/package.json`)) {
      expect((JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name).toMatch(
        /^@porttrack\//,
      );
    }
  });

  it('never commits the vault or secrets', () => {
    const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
    for (const pattern of ['data/', '*.db', '.env']) expect(ignore).toContain(pattern);
  });
});

describe('US-8.1 Scenario: Test hygiene rules from the plan hold', () => {
  const testFiles = () => [
    ...globSync(`${ROOT}/packages/*/test/**/*.spec.ts`),
    ...globSync(`${ROOT}/tests/**/*.spec.ts`),
  ];

  it('finds the acceptance test suite', () => {
    expect(testFiles().length).toBeGreaterThan(0);
  });

  it('uses no wall-clock time inside test bodies', () => {
    // Correctness assertions must use an injected Clock so results are reproducible.
    // Excluded: the container suite and benchmarks, where measuring real elapsed
    // time IS the assertion (NFR-2 budgets) and a fixed clock would be meaningless.
    const offenders = testFiles()
      .filter((file) => !file.includes('/tests/container/') && !file.endsWith('.bench.ts'))
      .filter((file) => /Date\.now\(\)|new Date\(\)(?!\.)/.test(readFileSync(file, 'utf8')));
    expect(offenders.map((f) => f.replace(ROOT, ''))).toEqual([]);
  });

  it('asserts money with exact equality, never toBeCloseTo on a Money amount', () => {
    const offenders = testFiles().filter((file) =>
      /toBeCloseTo\(\s*(?:inr|usd|money)\(/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map((f) => f.replace(ROOT, ''))).toEqual([]);
  });

  it('ships a fixture directory with no real PAN or Aadhaar', () => {
    expect(existsSync(join(ROOT, 'tests/fixtures'))).toBe(true);
    for (const file of globSync(`${ROOT}/tests/fixtures/**/*.csv`)) {
      const content = readFileSync(file, 'utf8');
      // The only PAN-shaped token permitted anywhere is the synthetic one.
      for (const match of content.match(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/g) ?? []) {
        expect(match).toBe('ABCDE1234F');
      }
    }
  });
});
