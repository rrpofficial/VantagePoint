/**
 * Forward-only, idempotent schema migrations (US-8.3).
 *
 * Money columns are stored as `TEXT` decimal strings, never REAL — a float column
 * would reintroduce exactly the drift ADR-002 exists to prevent.
 */
import type { Database } from 'better-sqlite3-multiple-ciphers';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial-ledger',
    up: `
      CREATE TABLE assets (
        asset_id      TEXT PRIMARY KEY,
        asset_class   TEXT NOT NULL,
        jurisdiction  TEXT NOT NULL CHECK (jurisdiction IN ('DOMESTIC','FOREIGN')),
        currency      TEXT NOT NULL,
        symbol        TEXT,
        isin          TEXT,
        folio_ref     TEXT,
        liquidity     TEXT,
        position_closed INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE lots (
        lot_id             TEXT PRIMARY KEY,
        asset_id           TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
        acquisition_date   TEXT NOT NULL,
        settlement_date    TEXT NOT NULL,
        quantity           TEXT NOT NULL,
        remaining_quantity TEXT NOT NULL,
        cost_per_unit      TEXT NOT NULL,
        cost_currency      TEXT NOT NULL,
        fees               TEXT NOT NULL DEFAULT '0',
        stt                TEXT NOT NULL DEFAULT '0',
        other_charges      TEXT NOT NULL DEFAULT '0',
        valuation_rate     TEXT,
        tax_rate           TEXT,
        rate_source        TEXT,
        grandfathered_fmv  TEXT,
        perquisite_value   TEXT,
        is_bonus           INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_lots_asset ON lots(asset_id);
      CREATE INDEX idx_lots_acquisition ON lots(acquisition_date);

      CREATE TABLE liabilities (
        liability_id         TEXT PRIMARY KEY,
        kind                 TEXT NOT NULL,
        principal_outstanding TEXT NOT NULL,
        currency             TEXT NOT NULL,
        interest_rate_pct    TEXT NOT NULL,
        as_of                TEXT NOT NULL
      );

      CREATE TABLE hand_loans (
        asset_id          TEXT PRIMARY KEY REFERENCES assets(asset_id) ON DELETE CASCADE,
        borrower_ref      TEXT NOT NULL,
        principal         TEXT NOT NULL,
        currency          TEXT NOT NULL,
        interest_rate_pct TEXT NOT NULL,
        interest_basis    TEXT NOT NULL CHECK (interest_basis IN ('SIMPLE','COMPOUND')),
        start_date        TEXT NOT NULL
      );

      CREATE TABLE snapshots (
        snapshot_id  TEXT PRIMARY KEY,
        kind         TEXT NOT NULL,
        scope        TEXT NOT NULL,
        as_of        TEXT NOT NULL,
        payload      TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX idx_snapshots_as_of ON snapshots(as_of);
    `,
  },
  {
    version: 2,
    name: 'asset-round-trip',
    up: `
      -- v1 could store an Asset only partially: income events, corporate actions
      -- and hand-loan repayments had nowhere to go, so saving a holding and
      -- reading it back silently dropped its dividends and its splits. A ledger
      -- that loses income events understates taxable income, which is the exact
      -- failure this product exists to prevent.
      CREATE TABLE income_events (
        event_id              TEXT PRIMARY KEY,
        asset_id              TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
        kind                  TEXT NOT NULL,
        date                  TEXT NOT NULL,
        gross_amount          TEXT NOT NULL,
        tax_withheld          TEXT NOT NULL,
        net_amount            TEXT NOT NULL,
        currency              TEXT NOT NULL,
        withholding_rate_pct  TEXT,
        eligible_for_ftc      INTEGER NOT NULL DEFAULT 0,
        taxable_inr           TEXT
      );
      CREATE INDEX idx_income_events_asset ON income_events(asset_id);

      CREATE TABLE corporate_actions (
        action_id   TEXT PRIMARY KEY,
        asset_id    TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
        kind        TEXT NOT NULL,
        record_date TEXT NOT NULL,
        ratio_from  TEXT NOT NULL,
        ratio_to    TEXT NOT NULL
      );
      CREATE INDEX idx_corporate_actions_asset ON corporate_actions(asset_id);

      CREATE TABLE hand_loan_repayments (
        repayment_id TEXT PRIMARY KEY,
        asset_id     TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
        date         TEXT NOT NULL,
        principal    TEXT NOT NULL,
        currency     TEXT NOT NULL
      );
      CREATE INDEX idx_hand_loan_repayments_asset ON hand_loan_repayments(asset_id);

      -- A mutual fund's tax character is DERIVED from these two (ADR-016); losing
      -- them on a round trip would silently reclassify an equity-oriented fund.
      ALTER TABLE assets ADD COLUMN scheme_category TEXT;
      ALTER TABLE assets ADD COLUMN equity_allocation_pct TEXT;

      -- v1 had a single rate_source column but DualRate carries two independent
      -- rates with independent provenance (ADR-003). One column cannot record
      -- that a valuation rate was authoritative while the tax rate was a fallback.
      ALTER TABLE lots ADD COLUMN tax_rate_source TEXT;
      ALTER TABLE lots ADD COLUMN fx_is_fallback INTEGER;
      ALTER TABLE lots ADD COLUMN fx_fallback_note TEXT;
    `,
  },
  {
    version: 3,
    name: 'exits',
    up: `
      -- A disposal left no trace: lots recorded that quantity had gone, but not
      -- that a SELL caused it. Two consequences, both bad. Re-importing an
      -- overlapping statement re-applied every sell, depleting holdings twice,
      -- because a sell could not be recognised as one already seen. And realised
      -- gains had no source record to compute from.
      CREATE TABLE exits (
        txn_id           TEXT PRIMARY KEY,
        asset_id         TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
        exit_date        TEXT NOT NULL,
        acquisition_date TEXT,
        quantity         TEXT NOT NULL,
        price_per_unit   TEXT NOT NULL,
        currency         TEXT NOT NULL,
        fees             TEXT NOT NULL DEFAULT '0',
        stt              TEXT NOT NULL DEFAULT '0',
        -- The lot breakdown is a value object of the exit and is never queried
        -- independently, so it is stored whole rather than in a child table.
        allocations      TEXT NOT NULL,
        valuation_rate   TEXT,
        tax_rate         TEXT,
        rate_source      TEXT,
        tax_rate_source  TEXT,
        fx_is_fallback   INTEGER,
        fx_fallback_note TEXT,
        valuation_inr    TEXT,
        taxable_inr      TEXT
      );
      CREATE INDEX idx_exits_asset ON exits(asset_id);
      CREATE INDEX idx_exits_date ON exits(exit_date);
    `,
  },
  {
    version: 4,
    name: 'settings',
    up: `
      -- Small, singular application state that is not ledger data: the income
      -- profile behind an advance-tax figure, for one. Held in the encrypted
      -- vault like everything else — salary is exactly as sensitive as holdings.
      -- Previously this lived in a module-level variable and was lost on every
      -- restart, so a computed tax figure silently reverted to "zero income".
      CREATE TABLE settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 5,
    name: 'hand-loan-register',
    up: `
      -- The borrower's real NAME, which the register is filtered and sorted by.
      -- It lives here, inside the encrypted database, and nowhere else: exports
      -- and AI payloads continue to carry the opaque borrower_ref.
      ALTER TABLE hand_loans ADD COLUMN borrower_name TEXT;
      ALTER TABLE hand_loans ADD COLUMN notes TEXT;
      -- When the lender considers the loan closed, which is NOT the same as the
      -- principal being repaid: interest can outlive the principal.
      ALTER TABLE hand_loans ADD COLUMN closed_date TEXT;

      -- How a repayment arrived, and anything said about it. A spreadsheet kept
      -- this in a comment column; it is what a disputed payment turns on.
      ALTER TABLE hand_loan_repayments ADD COLUMN mode TEXT;
      ALTER TABLE hand_loan_repayments ADD COLUMN notes TEXT;

      -- Interest received, kept in its own table because it does NOT reduce the
      -- principal. Storing both in one table invites summing them together, and
      -- that writes off principal silently.
      CREATE TABLE hand_loan_interest_payments (
        payment_id TEXT PRIMARY KEY,
        asset_id   TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
        date       TEXT NOT NULL,
        amount     TEXT NOT NULL,
        currency   TEXT NOT NULL,
        mode       TEXT NOT NULL,
        notes      TEXT
      );
      CREATE INDEX idx_hand_loan_interest_asset ON hand_loan_interest_payments(asset_id);
      CREATE INDEX idx_hand_loan_interest_date ON hand_loan_interest_payments(date);
    `,
  },
  {
    version: 6,
    name: 'hand-loan-audit',
    up: `
      -- The audit trail for hand loans: who changed what, from what, to what, why.
      --
      -- Deliberately WITHOUT a foreign key to assets. Every other child table
      -- cascades on delete, which is right for them and wrong for this one: a
      -- trail that disappears along with the record it describes cannot answer
      -- the only question ever asked of it, which is what happened to a loan that
      -- is no longer there.
      --
      -- Append-only by construction. There is no update or delete statement for
      -- this table anywhere in the codebase, and a correction is a further row
      -- rather than an edit to an existing one.
      CREATE TABLE hand_loan_audit (
        entry_id    TEXT PRIMARY KEY,
        asset_id    TEXT NOT NULL,
        action      TEXT NOT NULL,
        field       TEXT,
        old_value   TEXT,
        new_value   TEXT,
        reason      TEXT,
        recorded_at TEXT NOT NULL
      );
      CREATE INDEX idx_hand_loan_audit_asset ON hand_loan_audit(asset_id);
      CREATE INDEX idx_hand_loan_audit_time ON hand_loan_audit(recorded_at);
    `,
  },
  {
    version: 7,
    name: 'chit-fund-register',
    up: `
      -- A chit is a commitment to an instalment every month for a fixed term.
      --
      -- target_amount is the chit's FACE value — what the pot pays out — and is
      -- deliberately NOT what the asset is worth. A chit is carried at what has
      -- been paid into it; storing the two in one column would guarantee the
      -- face value eventually reached net worth.
      CREATE TABLE chit_funds (
        asset_id         TEXT PRIMARY KEY REFERENCES assets(asset_id) ON DELETE CASCADE,
        org              TEXT NOT NULL,
        label            TEXT NOT NULL,
        target_amount    TEXT NOT NULL,
        currency         TEXT NOT NULL,
        start_date       TEXT NOT NULL,
        end_date         TEXT NOT NULL,
        duration_months  INTEGER NOT NULL,
        emi_type         TEXT NOT NULL CHECK (emi_type IN ('CONSTANT','VARYING')),
        schedule_label   TEXT,
        status           TEXT NOT NULL CHECK (status IN ('ACTIVE','WITHDRAWN')),
        withdrawn_date   TEXT,
        withdrawn_amount TEXT,
        comments         TEXT
      );
      CREATE INDEX idx_chit_funds_status ON chit_funds(status);
      CREATE INDEX idx_chit_funds_org ON chit_funds(org);

      -- Instalments actually paid. These continue AFTER a withdrawal: drawing
      -- the pot in month 6 of 25 ends the chit as an asset but not the
      -- obligation, and a schema that stopped recording them would lose a real
      -- outgoing.
      CREATE TABLE chit_emis (
        emi_id   TEXT PRIMARY KEY,
        asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
        date     TEXT NOT NULL,
        amount   TEXT NOT NULL,
        currency TEXT NOT NULL,
        mode     TEXT NOT NULL,
        paid_to  TEXT NOT NULL,
        comments TEXT
      );
      CREATE INDEX idx_chit_emis_asset ON chit_emis(asset_id);
      CREATE INDEX idx_chit_emis_date ON chit_emis(date);

      -- What the chit company pays out for a withdrawal in a given month.
      --
      -- Reference data in its own table rather than columns on each chit: every
      -- chit of the same shape shares one schedule, and copying it per chit
      -- would let two "5L / 25 months" chits disagree about what month 12 is
      -- worth.
      CREATE TABLE chit_withdrawal_schedules (
        label      TEXT PRIMARY KEY,
        currency   TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE chit_withdrawal_schedule_rows (
        label  TEXT NOT NULL REFERENCES chit_withdrawal_schedules(label) ON DELETE CASCADE,
        month  INTEGER NOT NULL,
        amount TEXT NOT NULL,
        PRIMARY KEY (label, month)
      );
    `,
  },
  {
    version: 8,
    name: 'fx-rate-store',
    up: `
      -- FX rates, in the vault rather than in memory (US-2.1, FR-2.1).
      --
      -- The store was a process-level Map, which meant every rate was lost on
      -- restart. That is survivable for a display figure and not for a tax one:
      -- a capital gain on a foreign share is computed from the rate on the day
      -- the shares vested, which may be six years before the sale, and re-deriving
      -- it later from a source that no longer publishes that far back is not
      -- possible. A rate used in a filed figure has to be kept.
      --
      -- WRITE-ONCE per (currency, rate_date, source), enforced by the primary key
      -- and by the repository refusing a differing value. A corrected rate is an
      -- amendment (US-2.6), never an overwrite — silently changing a stored rate
      -- would retroactively alter a frozen snapshot with no trace.
      CREATE TABLE fx_rates (
        currency            TEXT NOT NULL,
        rate_date           TEXT NOT NULL,
        source              TEXT NOT NULL,
        -- Decimal string, never REAL (ADR-002). A float here reintroduces drift
        -- into the multiplication that produces a taxable amount.
        rate                TEXT NOT NULL,
        rate_type           TEXT NOT NULL CHECK (rate_type IN ('TTBR','TTSR','REFERENCE')),
        retrieved_at        TEXT NOT NULL,
        -- Which document this came from, so a figure can be traced to its source
        -- years later. Required, not nullable: a rate with no provenance cannot
        -- be defended to an assessing officer.
        source_document_ref TEXT NOT NULL,
        PRIMARY KEY (currency, rate_date, source)
      );

      -- The resolver walks BACKWARDS from a date over non-publishing days, one
      -- source at a time, so the index leads with the columns it filters on and
      -- ends with the one it ranges over.
      CREATE INDEX idx_fx_rates_lookup ON fx_rates(currency, source, rate_date);
    `,
  },
  {
    version: 9,
    name: 'disposal-rupee-legs',
    up: `
      -- Both legs of a disposal in rupees, stored rather than re-derived.
      --
      -- For a lot vested on d1 at vp$ and sold on d2 at sp$, quantity q:
      --
      --   valuation_inr      = sp$ × q × rate(d2)                  display only
      --   proceeds_tax_inr   = sp$ × q × rate(month-end before d2)
      --   cost_basis_tax_inr = vp$ × q × rate(month-end before d1)
      --   taxable_gain_inr   = proceeds_tax_inr − cost_basis_tax_inr
      --
      -- Only the last is charged to tax. valuation_inr uses a DIFFERENT rate
      -- (ADR-003) and must never reach a tax computation.
      --
      -- The rename is the point of this migration. The column was taxable_inr,
      -- sitting beside valuation_inr, and the pair read as one quantity at two
      -- rates — so it was populated at least once with converted PROCEEDS while
      -- the capital-gains engine reads it as the finished GAIN and returns it
      -- unchanged. That charges tax on the whole sale value instead of the
      -- profit, and the figure it produces looks entirely ordinary.
      --
      -- Safe as a rename rather than a rebuild: nothing in the product ever
      -- wrote this column (the projector did not set it), so every existing row
      -- holds NULL. There is no stored value to reinterpret.
      ALTER TABLE exits RENAME COLUMN taxable_inr TO taxable_gain_inr;
      ALTER TABLE exits ADD COLUMN proceeds_tax_inr TEXT;
      ALTER TABLE exits ADD COLUMN cost_basis_tax_inr TEXT;
    `,
  },
  {
    version: 10,
    name: 'equity-award-identity',
    up: `
      -- Grant → tranche → disposal, the three levels a stock plan actually has.
      --
      -- One grant vests in tranches over years; one tranche is commonly sold
      -- across several orders (a sell-to-cover on vest day, a manual sale
      -- later). Without the grant reference a lot is identified by the file it
      -- was read from, so the same vest appearing in a Gains & Losses export and
      -- in a holdings export becomes two lots.
      --
      -- ESPP carries no grant number, so grant_date stands in as the offering's
      -- identifier; the tranche is then the PURCHASE date, because one offering
      -- commonly has several purchase dates.
      ALTER TABLE lots ADD COLUMN award_kind   TEXT CHECK (award_kind IN ('RSU','ESPP'));
      ALTER TABLE lots ADD COLUMN grant_ref    TEXT;
      ALTER TABLE lots ADD COLUMN grant_date   TEXT;
      ALTER TABLE lots ADD COLUMN vest_date    TEXT;
      ALTER TABLE lots ADD COLUMN purchase_date TEXT;
      -- ESPP: what was actually PAID, which is NOT the cost basis. Section
      -- 49(2AA) sets the basis at fair market value on the acquisition date; the
      -- discount below it was already charged as a salary perquisite, and using
      -- the price paid would tax that discount a second time.
      ALTER TABLE lots ADD COLUMN purchase_price TEXT;
      ALTER TABLE lots ADD COLUMN discount_per_unit TEXT;
      ALTER TABLE lots ADD COLUMN fmv_at_acquisition TEXT;

      CREATE INDEX idx_lots_grant ON lots(grant_ref);

      -- Why the shares left, and under which order.
      --
      -- A sell-to-cover is a genuine transfer: the units deplete the lot and
      -- Schedule FA counts them. Whether it is CHARGED to capital gains is a
      -- position the taxpayer takes, so it is flagged rather than dropped.
      ALTER TABLE exits ADD COLUMN disposal_kind TEXT
        CHECK (disposal_kind IN ('SALE','SELL_TO_COVER'));
      ALTER TABLE exits ADD COLUMN order_ref TEXT;
    `,
  },
  {
    version: 11,
    name: 'lot-matching-method',
    up: `
      -- Which lot-identification convention produced a disposal's allocations.
      --
      -- FIFO comes from CBDT Circular 768 (1998), which addresses securities
      -- held in DEMATERIALISED form. Its rationale is fungibility: demat shares
      -- have no individual identity, so a convention is needed. That does not
      -- obviously extend to a foreign stock-plan account, where the plan
      -- administrator tracks every share to its grant and release and says so on
      -- the statement — and where matching FIFO produces a figure the taxpayer
      -- cannot reconcile against their own broker report.
      --
      -- Stored rather than assumed because the two methods give different
      -- answers, and a filed figure should record which one it rests on. Rows
      -- written before this column existed were all FIFO, which is what a NULL
      -- reads as.
      ALTER TABLE exits ADD COLUMN lot_matching TEXT
        CHECK (lot_matching IN ('SPECIFIC','FIFO'));
    `,
  },
  {
    version: 12,
    name: 'stated-remaining-quantity',
    up: `
      -- What the BROKER says is left of a tranche, beside what the ledger works
      -- out for itself.
      --
      -- Deliberately a second column rather than a correction to
      -- remaining_quantity. When they disagree, disposals exist that were never
      -- imported — and that is invisible any other way, because every figure
      -- derived from the ledger is internally consistent and simply wrong.
      --
      -- Stored rather than compared at import time: an import-time check only
      -- fires on the file that carried the stated figure, so loading holdings
      -- first and disposals second would compare nothing at all.
      ALTER TABLE lots ADD COLUMN stated_remaining_quantity TEXT;
    `,
  },
  {
    version: 13,
    name: 'advance-tax-payments',
    up: `
      -- Advance tax already paid, per instalment.
      --
      -- Instalments are CUMULATIVE — 15/45/75/100% of the year's liability — so
      -- each quarter's demand is net of everything paid before it. Without this
      -- the engine was handed a hardcoded zero and every quarter after the first
      -- re-demanded tax that had already been paid.
      --
      -- The challan reference is the taxpayer's evidence that a payment happened,
      -- so it is stored beside the amount rather than left to memory.
      CREATE TABLE advance_tax_payments (
        payment_id     TEXT PRIMARY KEY,
        financial_year TEXT NOT NULL,
        quarter        TEXT NOT NULL CHECK (quarter IN ('Q1','Q2','Q3','Q4')),
        amount         TEXT NOT NULL,
        currency       TEXT NOT NULL,
        paid_on        TEXT NOT NULL,
        challan_ref    TEXT,
        notes          TEXT
      );
      CREATE INDEX idx_advance_tax_payments_fy
        ON advance_tax_payments(financial_year, quarter);
    `,
  },
  {
    version: 14,
    name: 'asset-prices',
    up: `
      -- Market prices, so a holding can be carried at what it is WORTH rather
      -- than at what it cost.
      --
      -- Everything on screen was cost basis: the valuation engine looks for a
      -- price source, finds none wired, and falls back to cost. Three screens
      -- then labelled that cost "value" and "net worth".
      --
      -- There is no live feed and there will not be one — the API container sits
      -- on a network with no gateway (ADR-010). Prices arrive the way everything
      -- else does: inside a statement the user imports. So each price carries the
      -- document it came from and the date it was recorded, and a figure derived
      -- from it can always be traced back and dated.
      --
      -- Keyed on the INSTRUMENT, not the asset id: one symbol may be held as an
      -- RSU and as plain foreign equity, and both are worth the same per share.
      CREATE TABLE asset_prices (
        instrument      TEXT NOT NULL,
        price_date      TEXT NOT NULL,
        source          TEXT NOT NULL,
        -- Decimal string, never REAL (ADR-002).
        price           TEXT NOT NULL,
        currency        TEXT NOT NULL,
        source_document TEXT,
        PRIMARY KEY (instrument, price_date, source)
      );

      -- The resolver asks for the latest price at or before a date, so the index
      -- leads with what it filters on and ends with what it ranges over.
      CREATE INDEX idx_asset_prices_lookup ON asset_prices(instrument, price_date);
    `,
  },
  {
    version: 15,
    name: 'fold-equity-awards-into-foreign-equity',
    up: `
      -- RSU and ESPP stop being asset classes and become properties of a LOT.
      --
      -- They split one company's shares across two holdings: the same symbol
      -- bought outright and received as an RSU became two assets — double
      -- counted on every screen, and matched FIFO in two separate queues when
      -- the law treats them as one pool of one security.
      --
      -- Nothing justified the split. RSU, ESPP and FOREIGN_EQUITY were identical
      -- in every tax dimension: same 24-month holding period, same jurisdiction,
      -- same settlement lag, same bucket. What actually differs is the
      -- ACQUISITION — which perquisite was charged, what the cost basis became —
      -- and that already lives on the lot as award_kind/grant_ref.
      --
      -- Merging, not renaming. A vault may hold ast_rsu_crm AND
      -- ast_foreign_equity_crm; both become the latter, and their lots and exits
      -- move with them. Ordered so the destination exists before anything is
      -- repointed at it.

      -- 1. Create the FOREIGN_EQUITY destination for any symbol that lacks one.
      INSERT INTO assets (asset_id, asset_class, jurisdiction, currency, symbol,
                          isin, folio_ref, liquidity, position_closed)
      SELECT DISTINCT
             'ast_foreign_equity_' || LOWER(REPLACE(COALESCE(a.symbol, a.asset_id), '.', '_')),
             'FOREIGN_EQUITY', 'FOREIGN', a.currency, a.symbol,
             a.isin, a.folio_ref, a.liquidity, 0
        FROM assets a
       WHERE a.asset_class IN ('RSU','ESPP')
         AND NOT EXISTS (
               SELECT 1 FROM assets d
                WHERE d.asset_class = 'FOREIGN_EQUITY'
                  AND d.symbol IS a.symbol);

      -- 2. Move every lot and disposal onto the destination asset.
      UPDATE lots SET asset_id = (
        SELECT d.asset_id FROM assets d
          JOIN assets s ON s.asset_id = lots.asset_id
         WHERE d.asset_class = 'FOREIGN_EQUITY' AND d.symbol IS s.symbol
         LIMIT 1)
      WHERE asset_id IN (SELECT asset_id FROM assets WHERE asset_class IN ('RSU','ESPP'));

      UPDATE exits SET asset_id = (
        SELECT d.asset_id FROM assets d
          JOIN assets s ON s.asset_id = exits.asset_id
         WHERE d.asset_class = 'FOREIGN_EQUITY' AND d.symbol IS s.symbol
         LIMIT 1)
      WHERE asset_id IN (SELECT asset_id FROM assets WHERE asset_class IN ('RSU','ESPP'));

      -- 3. The now-empty RSU/ESPP shells go. Their lots carry award_kind, so
      --    nothing about how those shares were acquired is lost.
      DELETE FROM assets WHERE asset_class IN ('RSU','ESPP');
    `,
  },
];

const SCHEMA_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );
`;

export function currentVersion(db: Database): number {
  db.exec(SCHEMA_TABLE);
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
    v: number | null;
  };
  return row.v ?? 0;
}

/** Applies every migration above the current version. Idempotent. */
export function runMigrations(db: Database, appliedAt: string): number {
  db.exec(SCHEMA_TABLE);
  let version = currentVersion(db);

  const record = db.prepare(
    'INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)',
  );

  for (const migration of MIGRATIONS) {
    if (migration.version <= version) continue;
    // Each migration is its own transaction: a failure leaves the previous
    // version intact rather than a half-applied schema.
    db.transaction(() => {
      db.exec(migration.up);
      record.run(migration.version, migration.name, appliedAt);
    })();
    version = migration.version;
  }

  return version;
}
