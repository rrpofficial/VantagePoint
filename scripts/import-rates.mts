/**
 * Imports a historical SBI TT Buy archive into the vault.
 *
 * Source and format are documented in the README under "Where FX rates come
 * from". In short: SBI publishes today's card and no history, so rates have to be
 * captured from an archive of its published PDFs —
 * https://github.com/sahilgupta/sbi-fx-ratekeeper
 *
 * An operator script rather than a route, for the same reason `diagnose-vault`
 * is: it opens the vault directly, so it works against a stopped stack and
 * against a checkout whose TypeScript has never been built. Run it with
 * `npx tsx`, as with `emit-templates.mts`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { EditModeUC, RatesUC, VaultUC, resetPorts } from '../packages/app-services/src/index.js';
import { Vault } from '../packages/persistence/src/index.js';
import type { Currency } from '../packages/shared-kernel/src/index.js';

const [, , file, currencyArg, dataDirArg] = process.argv;
const currency = (currencyArg ?? 'USD').toUpperCase() as Currency;
const dataDir = dataDirArg ?? './data';
const passphrase = process.env.VANTAGEPOINT_PASSPHRASE ?? '';

if (file === undefined || passphrase.length === 0) {
  console.error(
    [
      'usage: VANTAGEPOINT_PASSPHRASE=... pnpm vault:rates:import <csv> [currency] [data-dir]',
      '',
      'Type the passphrase into a prompt rather than the command line, so it does',
      'not land in your shell history:',
      '',
      "  read -rs -p 'passphrase: ' VANTAGEPOINT_PASSPHRASE && export VANTAGEPOINT_PASSPHRASE",
      '  pnpm vault:rates:import ./SBI_REFERENCE_RATES_USD.csv USD ./data',
      '  unset VANTAGEPOINT_PASSPHRASE',
      '',
      'Get the CSV from:',
      '  https://github.com/sahilgupta/sbi-fx-ratekeeper/blob/main/csv_files/SBI_REFERENCE_RATES_USD.csv',
    ].join('\n'),
  );
  process.exit(2);
}

if (!existsSync(file)) {
  console.error(`no such file: ${file}`);
  process.exit(2);
}

const open = await Vault.open({ dataDir: resolve(dataDir), fileName: 'vault.db' });
if (!open.ok) {
  console.error(`could not open the vault at ${dataDir}: ${open.error.message}`);
  process.exit(1);
}

const unlocked = await VaultUC.unlock(passphrase);
if (!unlocked.ok) {
  console.error('could not unlock the vault — wrong passphrase, or run `pnpm vault:diagnose`');
  await Vault.close();
  process.exit(1);
}
resetPorts();

// Writing rates is gated like any other change to existing records.
const enabled = await EditModeUC.enable(passphrase);
if (!enabled.ok) {
  console.error('could not enable edit mode');
  await Vault.close();
  process.exit(1);
}

const report = await RatesUC.importArchive({
  csv: readFileSync(file, 'utf8'),
  currency,
  // Names the archive. Rows carrying their own PDF link keep that instead — it
  // points at SBI's published document, which is better provenance.
  documentRef: `sbi-fx-ratekeeper/${basename(file)}`,
});

if (!report.ok) {
  console.error(`\nREFUSED: ${report.error.message}`);
  console.error('\nNothing was written. Any bad row rejects the whole file, because a');
  console.error('half-imported archive leaves gaps that later resolve as if SBI never published.');
  await Vault.close();
  process.exit(1);
}

const { parsed, stored, alreadyPresent, earliest, latest, skipped, revisions } = report.value;
console.log(`\nimported ${currency} rates from ${file}`);
console.log(`  parsed          : ${String(parsed)}`);
console.log(`  newly stored    : ${String(stored)}`);
console.log(`  already present : ${String(alreadyPresent)}`);
console.log(`  range           : ${earliest} .. ${latest}`);

if (skipped.length > 0) {
  console.log(`\n  ${String(skipped.length)} day(s) SBI published no TT buy rate. A lookup on these`);
  console.log('  walks back to the previous published day, and reports that it did:');
  for (const day of skipped.slice(0, 5)) console.log(`     ${day.date}`);
  if (skipped.length > 5) console.log(`     ... and ${String(skipped.length - 5)} more`);
}

const changed = revisions.filter((revision) => revision.ratesDiffer);
if (changed.length > 0) {
  console.log(`\n  ${String(changed.length)} day(s) SBI republished at a DIFFERENT rate. The last card`);
  console.log('  of the day was taken. Worth checking if a figure turns on one of these:');
  for (const revision of changed) {
    console.log(`     ${revision.date}  took ${revision.taken}, discarded ${revision.discarded.join(', ')}`);
  }
}

const coverage = await RatesUC.coverage();
if (coverage.ok) {
  console.log('\nvault now holds:');
  for (const row of coverage.value) {
    console.log(
      `  ${row.currency} / ${row.source}: ${String(row.count)} rates, ${row.earliest} .. ${row.latest}`,
    );
  }
}

await VaultUC.lock();
await Vault.close();
