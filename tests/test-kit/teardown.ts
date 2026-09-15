/**
 * Removes the vaults the suite leaves behind.
 *
 * Nearly every functional test opens a real encrypted vault in a fresh
 * `mkdtempSync` directory — 27 call sites — and not one of them deletes it. Each
 * holds a SQLite database plus its WAL, so a full run leaves hundreds of
 * directories and tens of megabytes in the system temp directory, and they
 * accumulate across every run for as long as the machine is up.
 *
 * That is not theoretical: a long working session filled a 59 GB root filesystem
 * to 100% with 13,036 of them. The failure it produced was ENOSPC surfacing as
 * `VAULT_UNLOCK_FAILED` from unrelated tests — a disk problem wearing the mask of
 * a crypto one, which is an expensive hour to spend.
 *
 * Cleaning up centrally rather than in 27 `afterEach` blocks: a test that forgets
 * the call is the normal case, and this cannot be forgotten.
 */
import { readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Only directories this suite creates. Matched on the prefixes the tests pass to
 * `mkdtempSync`, so nothing outside the suite is ever a candidate for deletion.
 */
const PREFIXES = ['vantagepoint-', 'vantagepoint_'];

export default function teardown(): void {
  const root = tmpdir();
  let removed = 0;

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue;

    try {
      rmSync(join(root, entry.name), { recursive: true, force: true });
      removed++;
    } catch {
      // A directory another run still holds open is left alone; the next run
      // collects it. Failing teardown over it would turn tidy-up into a red suite.
    }
  }

  if (removed > 0) {
    console.log(`\n  cleaned ${String(removed)} temporary vault director${removed === 1 ? 'y' : 'ies'}`);
  }
}
