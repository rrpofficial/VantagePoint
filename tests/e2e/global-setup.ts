/**
 * Refuses to start against a vault that already holds data.
 *
 * The suite is cumulative and assumes a vault it has not seen before: it asserts
 * that net worth CHANGED after recording a loan, that a chit carries exactly the
 * instalments just paid, that a second loan to one borrower raises the duplicate
 * prompt. Re-run against its own leftovers, every one of those is false — and it
 * reports six unrelated-looking failures scattered across three describe blocks,
 * none of which names the actual cause.
 *
 * That cost a full debugging session. So the dependency is now explicit: this
 * fails immediately, once, with the command that fixes it.
 */
import type { FullConfig } from '@playwright/test';

const PASSPHRASE = process.env.PORTTRACK_TEST_PASSPHRASE ?? 'correct horse battery staple';

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL ?? 'http://localhost:5173';

  const unlock = await fetch(`${baseURL}/api/vault/unlock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passphrase: PASSPHRASE }),
  }).catch(() => undefined);

  if (unlock === undefined) {
    throw new Error(
      [
        `Cannot reach the app at ${baseURL}.`,
        '',
        'Start the testing instance first:',
        '  pnpm docker:test:up',
      ].join('\n'),
    );
  }

  if (!unlock.ok) {
    throw new Error(
      [
        `The vault at ${baseURL} did not unlock with the test passphrase.`,
        '',
        'That usually means this is NOT the testing instance — check the port, and',
        'that .env.test points PORTTRACK_DATA_DIR somewhere of its own.',
        '',
        'If you meant to point the suite elsewhere, set PORTTRACK_BASE_URL.',
      ].join('\n'),
    );
  }

  const ledger = (await (await fetch(`${baseURL}/api/ledger/assets`)).json()) as {
    assets?: readonly unknown[];
  };
  const held = ledger.assets?.length ?? 0;

  if (held > 0) {
    throw new Error(
      [
        `The vault at ${baseURL} already holds ${String(held)} asset(s).`,
        '',
        'This suite needs a vault it has not seen before — it asserts that figures',
        'CHANGED, which is false the second time around. Running anyway produces',
        'failures that look like real defects and are not.',
        '',
        'Reset it and run in one step:',
        '  pnpm test:e2e:fresh',
      ].join('\n'),
    );
  }
}
