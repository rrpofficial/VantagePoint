/**
 * US-8.6 — Headless CLI runner (PRD §4.3)
 */
import { describe, it, expect } from 'vitest';
import { runCli } from '../../../apps/cli/src/main.js';
import { expectNoPii } from '@vantagepoint/test-kit';

describe('US-8.6 Scenario: CLI can import, snapshot and compute tax without the UI', () => {
  it('runs `import` and exits 0', async () => {
    const result = await runCli([
      'import',
      '--file',
      'tests/fixtures/zerodha/tradebook.csv',
      '--parser',
      'zerodha',
    ]);
    expect(result.exitCode).toBe(0);
  });

  it('runs `snapshot --as-of` and exits 0', async () => {
    expect((await runCli(['snapshot', '--as-of', '2026-03-31'])).exitCode).toBe(0);
  });

  it('runs `tax advance` and exits 0', async () => {
    expect((await runCli(['tax', 'advance', '--fy', '2025-26', '--quarter', 'Q3'])).exitCode).toBe(0);
  });

  it('exits non-zero with a machine-readable error on failure', async () => {
    const result = await runCli(['snapshot', '--as-of', 'not-a-date']);
    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stderr).code).toBeTruthy();
  });

  it('exits non-zero for an unknown command', async () => {
    expect((await runCli(['nonsense'])).exitCode).not.toBe(0);
  });

  it('leaks no PII to stdout or stderr', async () => {
    const result = await runCli([
      'import',
      '--file',
      'tests/fixtures/templates/hand-loans-filled.csv',
      '--parser',
      'template',
    ]);
    expectNoPii(result.stdout);
    expectNoPii(result.stderr);
  });
});
