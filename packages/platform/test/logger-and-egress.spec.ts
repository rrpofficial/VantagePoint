/**
 * US-8.9  — No-PII logging guarantee (DoD D7)
 * US-8.10 — EgressGateway / offline-by-default (ADR-010)
 */
import { describe, it, expect } from 'vitest';
import {
  createEgressGateway,
  createLogger,
  type LogRecord,
  type LogSink,
} from '@vantagepoint/platform';
import type { EgressRequest } from '@vantagepoint/shared-kernel';
import { expectNoPii, SYNTHETIC } from '@vantagepoint/test-kit';

const NOW = () => '2026-08-02T12:00:00.000+05:30';

function capturingSink(): LogSink & { records: LogRecord[] } {
  const records: LogRecord[] = [];
  return { records, write: (record) => void records.push(record) };
}

describe('US-8.9 Scenario: Logs never contain PII', () => {
  it('masks a PAN in the log message', () => {
    const sink = capturingSink();
    createLogger({ sink, now: NOW }).info(`processing PAN ${SYNTHETIC.PAN}`);
    expect(sink.records[0]?.message).toContain('[REDACTED_PAN]');
    expectNoPii(sink.records[0]?.message ?? '');
  });

  it('masks PII in nested context objects', () => {
    const sink = capturingSink();
    createLogger({ sink, now: NOW }).info('import complete', {
      user: { pan: SYNTHETIC.PAN, email: SYNTHETIC.EMAIL },
      holdings: [{ folio: SYNTHETIC.FOLIO, symbol: 'TCS', quantity: 500 }],
    });
    expectNoPii(JSON.stringify(sink.records[0]?.context));
  });

  it('preserves non-PII context values', () => {
    const sink = capturingSink();
    createLogger({ sink, now: NOW }).info('valued', { symbol: 'TCS', quantity: 500 });
    expect(sink.records[0]?.context).toMatchObject({ symbol: 'TCS', quantity: 500 });
  });

  it('masks PII inside an error message and its cause chain', () => {
    const sink = capturingSink();
    const cause = new Error(`folio ${SYNTHETIC.DPID} rejected`);
    createLogger({ sink, now: NOW }).error('import failed', {
      error: new Error(`PAN ${SYNTHETIC.PAN} invalid`, { cause }),
    });
    expectNoPii(JSON.stringify(sink.records[0]?.context));
  });

  it('survives a cyclic context without hanging', () => {
    const sink = capturingSink();
    const cyclic: Record<string, unknown> = { pan: SYNTHETIC.PAN };
    cyclic.self = cyclic;
    createLogger({ sink, now: NOW }).warn('cyclic', cyclic);
    expectNoPii(JSON.stringify(sink.records[0]?.context));
  });

  it('stamps a deterministic timestamp from the injected clock', () => {
    const sink = capturingSink();
    createLogger({ sink, now: NOW }).info('x');
    expect(sink.records[0]?.timestamp).toBe('2026-08-02T12:00:00.000+05:30');
  });

  it('respects the minimum level', () => {
    const sink = capturingSink();
    const logger = createLogger({ sink, now: NOW, minLevel: 'warn' });
    logger.debug('nope');
    logger.info('nope');
    logger.warn('yes');
    expect(sink.records.map((r) => r.level)).toEqual(['warn']);
  });
});

describe('US-8.10 Scenario: No network call occurs without explicit user action', () => {
  const request: EgressRequest = {
    url: 'https://sbi.example/rates.csv',
    purpose: 'FX_RATE',
    body: 'q=1',
  };

  it('refuses every request under the default deny policy', async () => {
    const gateway = createEgressGateway({
      policy: { mode: 'deny', allowList: {} },
      transport: () => Promise.reject(new Error('should not be called')),
      now: NOW,
    });
    const result = await gateway.dispatch(request);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('EGRESS_DENIED');
  });

  it('never invokes the transport when denied', async () => {
    let called = false;
    const gateway = createEgressGateway({
      policy: { mode: 'deny', allowList: {} },
      transport: () => {
        called = true;
        return Promise.resolve('');
      },
      now: NOW,
    });
    await gateway.dispatch(request);
    expect(called).toBe(false);
  });

  it('refuses a host that is not allow-listed even when enabled', async () => {
    const gateway = createEgressGateway({
      policy: { mode: 'allow', allowList: { FX_RATE: ['rbi.example'] } },
      transport: () => Promise.resolve('ok'),
      now: NOW,
    });
    const result = await gateway.dispatch(request);
    expect(result.ok).toBe(false);
  });

  it('refuses a host allow-listed for a DIFFERENT purpose', async () => {
    const gateway = createEgressGateway({
      policy: { mode: 'allow', allowList: { AI_INSIGHT: ['sbi.example'] } },
      transport: () => Promise.resolve('ok'),
      now: NOW,
    });
    expect((await gateway.dispatch(request)).ok).toBe(false);
  });

  it('dispatches an allow-listed request when explicitly enabled', async () => {
    const gateway = createEgressGateway({
      policy: { mode: 'allow', allowList: { FX_RATE: ['sbi.example'] } },
      transport: () => Promise.resolve('rate-sheet'),
      now: NOW,
    });
    const result = await gateway.dispatch(request);
    expect(result.ok && result.value).toBe('rate-sheet');
  });

  it('aborts when the fail-closed guard rejects (ADR-007)', async () => {
    let called = false;
    const gateway = createEgressGateway({
      policy: { mode: 'allow', allowList: { AI_INSIGHT: ['ai.example'] } },
      transport: () => {
        called = true;
        return Promise.resolve('');
      },
      now: NOW,
      beforeDispatch: () => ({
        ok: false,
        error: Object.assign(new Error('residual PII'), { code: 'PII_LEAK' }),
      }),
    });
    const result = await gateway.dispatch({ url: 'https://ai.example/x', purpose: 'AI_INSIGHT' });
    expect(result.ok).toBe(false);
    expect(called, 'the transport must never run after the guard rejects').toBe(false);
  });
});

describe('US-8.10 Scenario: All egress is auditable', () => {
  it('records destination, purpose, timestamp and payload size for a dispatch', async () => {
    const gateway = createEgressGateway({
      policy: { mode: 'allow', allowList: { FX_RATE: ['sbi.example'] } },
      transport: () => Promise.resolve('ok'),
      now: NOW,
    });
    await gateway.dispatch({ url: 'https://sbi.example/r', purpose: 'FX_RATE', body: 'abcd' });

    const [entry] = gateway.auditLog();
    expect(entry?.destination).toBe('sbi.example');
    expect(entry?.purpose).toContain('FX_RATE');
    expect(entry?.timestamp).toBe('2026-08-02T12:00:00.000+05:30');
    expect(entry?.payloadBytes).toBe(4);
  });

  it('records refusals too, not only successes', async () => {
    const gateway = createEgressGateway({
      policy: { mode: 'deny', allowList: {} },
      transport: () => Promise.resolve('ok'),
      now: NOW,
    });
    await gateway.dispatch({ url: 'https://sbi.example/r', purpose: 'FX_RATE' });
    expect(gateway.auditLog()).toHaveLength(1);
    expect(gateway.auditLog()[0]?.purpose).toContain('DENIED');
  });

  it('starts with an empty audit log', () => {
    const gateway = createEgressGateway({
      policy: { mode: 'deny', allowList: {} },
      transport: () => Promise.resolve('ok'),
      now: NOW,
    });
    expect(gateway.auditLog()).toEqual([]);
  });

  it('returns a copy so callers cannot tamper with the audit trail', async () => {
    const gateway = createEgressGateway({
      policy: { mode: 'deny', allowList: {} },
      transport: () => Promise.resolve('ok'),
      now: NOW,
    });
    await gateway.dispatch({ url: 'https://sbi.example/r', purpose: 'FX_RATE' });
    (gateway.auditLog() as unknown[]).length = 0;
    expect(gateway.auditLog()).toHaveLength(1);
  });
});
