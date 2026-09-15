/**
 * Chit withdrawal schedules (US-1.12).
 *
 * Reference data: what the chit company pays out for a withdrawal in a given
 * month, keyed by a label the holder picks when creating a fixed-instalment
 * chit. Kept in its own table rather than on each chit so that two chits of the
 * same shape cannot disagree about what month 12 is worth.
 *
 * Saving a schedule replaces its rows wholesale. A schedule is a single agreed
 * table, and a partial update that left a stale month behind would produce a
 * withdrawal figure that matches no agreement anyone made.
 */
import { Err, Money, Ok, VaultStateError, type Currency, type Result } from '@vantagepoint/shared-kernel';
import type { ChitWithdrawalSchedule } from '@vantagepoint/core-domain';
import { Vault } from './vault.js';

interface ScheduleRow {
  readonly label: string;
  readonly currency: string;
}

interface ScheduleAmountRow {
  readonly label: string;
  readonly month: number;
  readonly amount: string;
}

export const ChitScheduleRepository = {
  save(schedule: ChitWithdrawalSchedule): Promise<Result<void>> {
    if (!Vault.isUnlocked()) {
      return Promise.resolve(Err(new VaultStateError('vault is locked')));
    }
    if (schedule.label.trim().length === 0) {
      return Promise.resolve(Err(new VaultStateError('a schedule needs a label')));
    }

    const db = Vault.connection();
    const currency = schedule.rows[0]?.amount.currency ?? 'INR';

    db.transaction(() => {
      db.prepare(
        `INSERT INTO chit_withdrawal_schedules (label, currency, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(label) DO UPDATE SET currency = excluded.currency`,
      ).run(schedule.label, currency, new Date().toISOString());

      db.prepare('DELETE FROM chit_withdrawal_schedule_rows WHERE label = ?').run(schedule.label);
      const insert = db.prepare(
        'INSERT INTO chit_withdrawal_schedule_rows (label, month, amount) VALUES (?, ?, ?)',
      );
      for (const row of schedule.rows) {
        insert.run(schedule.label, row.month, row.amount.amount);
      }
    })();

    return Promise.resolve(Ok(undefined));
  },

  all(): Promise<readonly ChitWithdrawalSchedule[]> {
    if (!Vault.isUnlocked()) return Promise.resolve([]);
    const db = Vault.connection();

    const schedules = db
      .prepare('SELECT * FROM chit_withdrawal_schedules ORDER BY label')
      .all() as ScheduleRow[];
    const rows = db
      .prepare('SELECT * FROM chit_withdrawal_schedule_rows ORDER BY label, month')
      .all() as ScheduleAmountRow[];

    return Promise.resolve(
      schedules.map((schedule) => ({
        label: schedule.label,
        rows: rows
          .filter((row) => row.label === schedule.label)
          .map((row) => ({
            month: row.month,
            amount: Money.fromStorage(row.amount, schedule.currency as Currency),
          })),
      })),
    );
  },

  findByLabel(label: string): Promise<ChitWithdrawalSchedule | undefined> {
    return ChitScheduleRepository.all().then((all) =>
      all.find((schedule) => schedule.label === label),
    );
  },

  delete(label: string): Promise<Result<void>> {
    if (!Vault.isUnlocked()) {
      return Promise.resolve(Err(new VaultStateError('vault is locked')));
    }
    const db = Vault.connection();
    db.transaction(() => {
      db.prepare('DELETE FROM chit_withdrawal_schedule_rows WHERE label = ?').run(label);
      db.prepare('DELETE FROM chit_withdrawal_schedules WHERE label = ?').run(label);
    })();
    return Promise.resolve(Ok(undefined));
  },
};
