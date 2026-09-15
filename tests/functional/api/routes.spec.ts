/**
 * US-8.11 — Backend API service (PRD FR-8.1)
 *
 * Exercises the Fastify app in-process via `inject` — no listening socket, so the
 * hermetic-network guarantee still holds.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, globSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { buildApp } from '../../../apps/api/src/app.js';
import { expectNoPii } from '@porttrack/test-kit';

const ROOT = resolve(import.meta.dirname, '../../..');

/**
 * Built per test rather than in a `beforeAll`: a throwing hook marks the whole
 * file SKIPPED, which hides red tests behind a green-looking count.
 */
/**
 * One throwaway directory per run. A fixed path let a vault from an EARLIER run
 * survive — created with a different passphrase — so unlock failed for reasons
 * that had nothing to do with the code under test.
 */
const DATA_DIR = mkdtempSync(join(tmpdir(), 'porttrack-api-'));
const app = () => buildApp({ dataDir: DATA_DIR });

describe('US-8.11 Scenario: API exposes the use cases the SPA needs', () => {
  it.each([
    ['POST', '/api/vault/unlock'],
    ['GET', '/api/portfolio/valuation'],
    ['POST', '/api/snapshots'],
    ['GET', '/api/snapshots/DOM_31MAR2026/compare'],
    ['POST', '/api/imports'],
    ['GET', '/api/tax/advance'],
  ])('routes %s %s', async (method, url) => {
    const response = await (await app()).inject({ method: method as 'GET' | 'POST', url });
    expect(response.statusCode).not.toBe(404);
  });

  it('returns JSON validated against the shared contract schema', async () => {
    const response = await (await app()).inject({ method: 'GET', url: '/api/health/live' });
    expect(response.headers['content-type']).toMatch(/application\/json/);
    // The arrow must not RETURN the parsed value: `JSON.parse` is `any`, and
    // returning it leaks that through the assertion. Parsing for the throw is
    // the whole point here.
    expect(() => {
      JSON.parse(response.body);
    }).not.toThrow();
  });
});

describe('US-8.11 Scenario: Health endpoints distinguish liveness from readiness', () => {
  it('returns 200 from /api/health/live when the process is up', async () => {
    const response = await (await app()).inject({ method: 'GET', url: '/api/health/live' });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).status).toBe('ok');
  });

  it('returns 503 VAULT_LOCKED from /api/health/ready while locked', async () => {
    const response = await (await app()).inject({ method: 'GET', url: '/api/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body).reason).toBe('VAULT_LOCKED');
  });

  /*
   * The Lock vault button posted no body under a JSON content-type. Fastify
   * answered 400 FST_ERR_CTP_EMPTY_JSON_BODY, the error handler reported it as
   * an internal error, and the button silently did nothing on every click — the
   * vault stayed unlocked while the screen said something had gone wrong.
   */
  it('locks the vault when the browser posts no body under a JSON content-type', async () => {
    const instance = await app();
    await instance.inject({
      method: 'POST',
      url: '/api/vault/unlock',
      payload: { passphrase: 'correct horse battery staple' },
    });

    const response = await instance.inject({
      method: 'POST',
      url: '/api/vault/lock',
      headers: { 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(200);
    const ready = await instance.inject({ method: 'GET', url: '/api/health/ready' });
    expect(ready.statusCode).toBe(503);
  });

  it('reports a malformed request as the client error it is, not as INTERNAL_ERROR', async () => {
    const response = await (
      await app()
    ).inject({
      method: 'POST',
      url: '/api/vault/unlock',
      headers: { 'content-type': 'application/json' },
      payload: 'this is not json',
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
    // Masking a 4xx as an internal error sends the reader looking for a server
    // defect that is not there.
    expect(JSON.parse(response.body).error.code).not.toBe('INTERNAL_ERROR');
  });

  it('returns 200 from /api/health/ready once unlocked', async () => {
    const instance = await app();
    await instance.inject({
      method: 'POST',
      url: '/api/vault/unlock',
      payload: { passphrase: 'correct horse battery staple' },
    });
    const response = await (await app()).inject({ method: 'GET', url: '/api/health/ready' });
    expect(response.statusCode).toBe(200);
  });
});

describe('US-8.11 Scenario: The API is a thin shell with no business logic', () => {
  it('has route handlers that import only app-services', () => {
    const routeFiles = globSync(`${ROOT}/apps/api/src/routes/**/*.ts`);
    expect(routeFiles.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of routeFiles) {
      const source = readFileSync(file, 'utf8');
      if (
        /@porttrack\/(core-domain|tax-engine|fx-itbr|snapshot|ingestion|compliance|persistence)/.test(
          source,
        )
      ) {
        offenders.push(file.replace(ROOT, ''));
      }
    }
    expect(offenders, 'routes must delegate to app-services, not domain packages').toEqual([]);
  });
});

describe('US-8.11 Scenario: Vault passphrase is never logged or persisted (ADR-014)', () => {
  const PASSPHRASE = 'correct horse battery staple';

  it('does not echo the passphrase in the unlock response', async () => {
    const response = await (await app()).inject({
      method: 'POST',
      url: '/api/vault/unlock',
      payload: { passphrase: PASSPHRASE },
    });
    expect(response.body).not.toContain(PASSPHRASE);
  });

  it('does not echo the passphrase in a failed unlock error', async () => {
    const response = await (await app()).inject({
      method: 'POST',
      url: '/api/vault/unlock',
      payload: { passphrase: 'wrong' },
    });
    expect(response.body).not.toContain('wrong');
  });

  it('leaks no PII in any error response', async () => {
    const response = await (await app()).inject({ method: 'GET', url: '/api/portfolio/valuation' });
    expectNoPii(response.body);
  });
});

/**
 * The edit/update/delete mode, over HTTP.
 *
 * These matter more than the use-case tests they duplicate. The SPA hides its
 * edit and delete controls when the mode is off, and that is worth nothing on
 * its own — a curl, a script, or a second client walks straight past a hidden
 * button. What makes the mode a control rather than a courtesy is that the API
 * refuses the request, and that is what is asserted here.
 */
describe('Scenario: Edit mode is enforced by the API, not only by the SPA', () => {
  const PASSPHRASE = 'correct horse battery staple';

  /** A fresh vault per scenario, so an enabled mode cannot leak between them. */
  const unlocked = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'porttrack-edit-mode-api-'));
    const instance = await buildApp({ dataDir: dir });
    await instance.inject({
      method: 'POST',
      url: '/api/vault/unlock',
      payload: { passphrase: PASSPHRASE },
    });
    return instance;
  };

  const enable = (instance: Awaited<ReturnType<typeof unlocked>>, passphrase = PASSPHRASE) =>
    instance.inject({
      method: 'POST',
      url: '/api/edit-mode/enable',
      payload: { passphrase },
    });

  /** The new chit's id, typed rather than read off an `any` from JSON.parse. */
  const chitIdOf = (response: { body: string }): string =>
    (JSON.parse(response.body) as { chitId: string }).chitId;

  const openChit = (instance: Awaited<ReturnType<typeof unlocked>>) =>
    instance.inject({
      method: 'POST',
      url: '/api/chits',
      payload: {
        org: 'Sri Balaji Chits',
        label: '5L / 25 months',
        targetAmount: { amount: '500000', currency: 'INR' },
        startDate: '2025-04-01',
        durationMonths: 25,
        emiType: 'CONSTANT',
      },
    });

  it('reports the mode as off on a freshly unlocked vault', async () => {
    const response = await (await unlocked()).inject({ method: 'GET', url: '/api/edit-mode' });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).enabled).toBe(false);
  });

  it('turns it on for the vault passphrase', async () => {
    const instance = await unlocked();

    const response = await enable(instance);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).enabled).toBe(true);
  });

  it('answers 401 to a wrong passphrase, and stays off', async () => {
    const instance = await unlocked();

    const response = await enable(instance, 'not the passphrase');

    expect(response.statusCode).toBe(401);
    const state = await instance.inject({ method: 'GET', url: '/api/edit-mode' });
    expect(JSON.parse(state.body).enabled).toBe(false);
  });

  it('never echoes the passphrase it refused', async () => {
    const response = await enable(await unlocked(), 'hunter2');

    expect(response.body).not.toContain('hunter2');
  });

  it('turns it off again without one', async () => {
    const instance = await unlocked();
    await enable(instance);

    const response = await instance.inject({ method: 'POST', url: '/api/edit-mode/disable' });

    expect(JSON.parse(response.body).enabled).toBe(false);
  });

  it('turns it off when the vault is locked', async () => {
    const instance = await unlocked();
    await enable(instance);

    await instance.inject({ method: 'POST', url: '/api/vault/lock' });

    const state = await instance.inject({ method: 'GET', url: '/api/edit-mode' });
    expect(JSON.parse(state.body).enabled).toBe(false);
  });

  /*
   * 403, not 422. The distinction is what lets the SPA respond usefully: 422
   * sends the user back to the form to re-check a field, 403 sends them to
   * Settings to turn the mode on. Answering 422 here would have them hunting a
   * typo that was never the problem.
   */
  it('answers 403 EDIT_MODE_REQUIRED to an edit while the mode is off', async () => {
    const instance = await unlocked();
    const chitId = chitIdOf(await openChit(instance));

    const response = await instance.inject({
      method: 'PUT',
      url: `/api/chits/${chitId}`,
      payload: { label: 'renamed' },
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error.code).toBe('EDIT_MODE_REQUIRED');
  });

  it('answers 403 to a delete while the mode is off', async () => {
    const instance = await unlocked();
    const chitId = chitIdOf(await openChit(instance));

    const response = await instance.inject({ method: 'DELETE', url: `/api/chits/${chitId}` });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error.code).toBe('EDIT_MODE_REQUIRED');
  });

  it('still accepts an addition while the mode is off', async () => {
    const response = await openChit(await unlocked());

    expect(response.statusCode).toBe(201);
  });

  it('accepts the same edit and delete once the mode is on', async () => {
    const instance = await unlocked();
    const chitId = chitIdOf(await openChit(instance));
    await enable(instance);

    const edited = await instance.inject({
      method: 'PUT',
      url: `/api/chits/${chitId}`,
      payload: { label: 'renamed' },
    });
    const deleted = await instance.inject({ method: 'DELETE', url: `/api/chits/${chitId}` });

    expect(edited.statusCode).toBe(200);
    expect(deleted.statusCode).toBe(200);
  });

  it('routes every delete endpoint the SPA calls', async () => {
    const instance = await unlocked();
    for (const url of [
      '/api/loans/nope',
      '/api/chits/nope',
      '/api/chits/schedules/nope',
      '/api/ledger/assets/nope',
      '/api/ledger/exits/nope',
    ]) {
      const response = await instance.inject({ method: 'DELETE', url });
      expect(response.statusCode, url).not.toBe(404);
    }
  });
});
