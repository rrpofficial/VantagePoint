/**
 * FUNCTIONAL — the privacy guarantees the whole product rests on.
 *
 * US-7.4  Fail-closed egress guard (ADR-007)
 * US-8.9  No-PII logging guarantee (DoD D7)
 * US-8.10 EgressGateway / offline-by-default (ADR-010)
 * US-9.2  Masker ships client-side, not server-side (ADR-013)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { resolve } from 'node:path';
import { inspect } from 'node:util';
import { AuditUC, ImportStatementUC, VaultUC } from '@porttrack/app-services';
import { MaskingPipeline, PiiVerifier } from '@porttrack/pii-masker';
import { expectNoPii, SYNTHETIC } from '@porttrack/test-kit';

const ROOT = resolve(import.meta.dirname, '../../..');

describe('FUNCTIONAL US-8.10 — offline by default (ADR-010)', () => {
  describe('Scenario: No network call occurs without explicit user action', () => {
    it('issues zero outbound requests on unlock', async () => {
      await VaultUC.unlock('correct horse battery staple');
      expect(await AuditUC.egressLog()).toEqual([]);
    });
  });

  describe('Scenario: All egress is auditable', () => {
    it('records destination, purpose, timestamp and payload size for every request', async () => {
      const log = await AuditUC.egressLog();
      for (const entry of log) {
        expect(entry.destination).toBeTruthy();
        expect(entry.purpose).toBeTruthy();
        expect(entry.timestamp).toBeTruthy();
        expect(typeof entry.payloadBytes).toBe('number');
      }
    });
  });
});

describe('FUNCTIONAL US-8.9 — no PII in logs (DoD D7)', () => {
  describe('Scenario: Logs never contain PII', () => {
    it('leaks no PII after processing a PAN, folio and borrower name', async () => {
      await VaultUC.unlock('correct horse battery staple');
      await ImportStatementUC.execute({
        file: new Uint8Array(readFileSync(resolve(ROOT, 'tests/fixtures/templates/hand-loans-filled.csv'))),
        fileName: 'hand-loans-filled.csv',
        parser: 'TEMPLATE',
        mode: 'LENIENT',
      });
      for (const line of await AuditUC.applicationLog()) expectNoPii(line);
    });

    it('carries no PII in errors thrown across package boundaries', async () => {
      const result = await ImportStatementUC.execute({
        file: new TextEncoder().encode(`borrower_name\n${SYNTHETIC.PERSON}\n`),
        fileName: 'bad.csv',
        parser: 'TEMPLATE',
        mode: 'STRICT',
      });
      if (!result.ok) {
        expectNoPii(result.error.message);
        // `cause` is `unknown`; stringify it explicitly rather than let template
        // coercion print "[object Object]" and pass a PII check on nothing.
        expectNoPii(inspect(result.error.cause ?? ''));
      }
    });
  });
});

describe('FUNCTIONAL US-7.4 — fail-closed AI egress (ADR-007)', () => {
  describe('Scenario: Residual PII aborts the AI call', () => {
    it('blocks a payload that survived masking with a PAN intact', () => {
      const leaky = `Analyze for [REDACTED_NAME], PAN: ${SYNTHETIC.PAN}`;
      const result = PiiVerifier.assertClean(leaky);
      expect(result.ok).toBe(false);
    });

    it('allows a fully masked payload through', () => {
      const clean = MaskingPipeline.maskText(
        `Analyze portfolio for ${SYNTHETIC.PERSON}, PAN: ${SYNTHETIC.PAN}`,
      );
      expect(PiiVerifier.assertClean(clean).ok).toBe(true);
    });
  });

  describe('Scenario: All AI egress is funnelled through the guard', () => {
    it('has no module outside the EgressGateway importing an HTTP client for AI endpoints', () => {
      const sources = globSync(`${ROOT}/packages/*/src/**/*.ts`);
      // Guard against a vacuous pass: an empty glob must fail, not silently succeed.
      expect(sources.length, 'no package sources found — the guard would be vacuous').toBeGreaterThan(
        0,
      );

      const offenders: string[] = [];
      for (const file of sources) {
        if (/egress/i.test(file)) continue;
        const source = readFileSync(file, 'utf8');
        if (/\bfetch\s*\(|from ['"](axios|undici|node-fetch)['"]/.test(source)) {
          offenders.push(file.replace(ROOT, ''));
        }
      }
      expect(offenders, `HTTP client used outside EgressGateway: ${offenders.join(', ')}`).toEqual(
        [],
      );
    });
  });
});

describe('FUNCTIONAL US-9.2 / ADR-013 — the masker stays client-side', () => {
  const apiSources = () => globSync(`${ROOT}/apps/api/src/**/*.ts`);

  describe('Scenario: The API never imports the masking entry point', () => {
    it('has API sources to inspect at all', () => {
      // Without this precondition the two assertions below pass on an empty
      // directory and would never detect a regression.
      expect(apiSources().length).toBeGreaterThan(0);
    });

    it('has no apps/api source importing MaskingPipeline', () => {
      const sources = apiSources();
      expect(sources.length).toBeGreaterThan(0);
      const offenders = sources.filter((file) =>
        /MaskingPipeline|NerMasker|Pseudonymiser/.test(readFileSync(file, 'utf8')),
      );
      expect(offenders, 'masking must run in the browser, not the API (ADR-013)').toEqual([]);
    });

    it('imports the fail-closed verifier in the API instead', () => {
      const sources = apiSources();
      expect(sources.length).toBeGreaterThan(0);
      expect(sources.some((file) => /PiiVerifier/.test(readFileSync(file, 'utf8')))).toBe(true);
    });
  });
});
