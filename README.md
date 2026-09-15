# portTrack

Global multi-asset portfolio tracking and Indian tax compliance for Indian tax residents —
local-first, privacy-first, containerized.

| Document | Purpose |
|---|---|
| [`Global_Portfolio_Tracker_PRD.md`](./Global_Portfolio_Tracker_PRD.md) | Product requirements (source of truth) |
| [`implementation_plan_portrack.md`](./implementation_plan_portrack.md) | ADRs, 80 user stories, acceptance criteria, DoD, milestone tracker |
| [`ARCHITECTURE_portrack.md`](./ARCHITECTURE_portrack.md) | C4 component views + 7 data-flow sequence diagrams |

## Current status — all milestones complete

```
unit + functional   992 passing   0 failing   0 skipped
container (Docker)   38 passing   0 failing
E2E (Playwright)     69 passing   0 failing
typecheck  clean     docker compose up ✓
```

> 16 pre-existing lint errors remain in `tests/test-kit`, `tests/manual` and three functional specs.
> They predate the current work and are listed rather than hidden.

**Every one of the eleven packages is green**, and the containerised stack runs: `docker compose up`
on a host with only Docker brings up the API and SPA, with your encrypted database on your own disk.

M0–M10 are done: kernel, asset ledger, FX and dual-rate conversion, snapshots, tax engine, ingestion,
PII masking, API/UI/CLI, containers, and the Schedule FA/AL exports.

> ⚠ **Tax rates are PROVISIONAL.** Computation works; `assertFilingReady` refuses to emit any filing
> artifact until the rates are sourced from the Finance Act and marked `VERIFIED`. The dashboard
> shows a provisional banner wherever a tax figure appears. **This is the one thing standing between
> the product and real use.**

> ⚠ **Name masking over-masks by design**, and the egress guard cannot catch a name the detector
> never recognised — see `packages/pii-masker/src/verifier.ts`.

> ⚠ **Schedule FA Table A3 is unavailable, by choice.** It requires the peak value over the calendar
> year, which needs a daily price and exchange-rate series this build does not record. It returns an
> explicit error rather than rows computed from the closing value, which would understate the peak —
> the dangerous direction under the Black Money Act. Table D and Schedule AL work.

## Running it

```bash
cp .env.example .env     # set PORTTRACK_DATA_DIR and your UID/GID
docker compose up
```

Then open <http://localhost:5173>. Nothing else is required — no Node, no pnpm, no toolchain.

### Two instances: one you use, one you break

Keep using portTrack while testing changes against it. `.env` describes the **production**
instance; `.env.test` describes the **testing** one, and the two share nothing:

|  | Production | Testing |
|---|---|---|
| Start | `pnpm docker:up` | `pnpm docker:test:up` |
| Stop | `pnpm docker:down` | `pnpm docker:test:down` |
| `PORTTRACK_PROJECT` | `porttrack` | `porttrack-test` |
| Containers | `porttrack-api` / `-web` | `porttrack-test-api` / `-web` |
| Image tag | `porttrack-*:prod` | `porttrack-*:test` |
| Vault | `./data` | `./data-test` |
| URL | <http://localhost:5273> | <http://localhost:5274> |

Everything Docker can namespace is namespaced — project, containers, networks, images — so
rebuilding the testing stack cannot replace the image production is serving from, and
`docker compose down` on one leaves the other running. **The published port is the exception:**
Docker cannot namespace a host port, so the two `PORTTRACK_WEB_PORT` values must differ or the
second stack simply refuses to start.

The vaults are separate files with separate passphrases. Nothing in the testing instance can read,
change or delete production data — which matters more now that edit mode makes deletion real.

```bash
pnpm docker:test:up        # bring the testing instance up
pnpm test:e2e              # Playwright, against the TESTING instance
pnpm test:e2e:fresh        # ...after recreating its vault from empty
```

`pnpm test:e2e` reads `.env.test` in preference to `.env`, so a test run has to be pointed at
production deliberately (`PORTTRACK_BASE_URL=...`) rather than landing there by accident.

**The suite needs a vault it has not seen before.** It asserts that figures *changed* — net worth
after recording a loan, a chit carrying exactly the instalments just paid — which is false the
second time around. A re-run used to produce half a dozen failures scattered across three describe
blocks, none of which named the cause. It now refuses to start against a populated vault and points
at `pnpm test:e2e:fresh`, which resets and runs in one step. `pnpm test:container` is separate again: it builds its own
project, tag and port, and leaves both instances untouched.

To promote a tested build to production, rebuild production's tag and restart it:

```bash
pnpm docker:up             # rebuilds porttrack-*:prod and recreates the stack
```

### Manual entry — CSV templates

Not everything has a broker export. For hand loans, property, cash, chit funds and unlisted shares,
download a template from **Import → Manual entry**, fill it in a spreadsheet, and import it with
*portTrack CSV template* selected.

| Template | Records | Key columns |
|---|---|---|
| `Custom_HandLoans` | Loans, with repayment and interest history | `borrower_name`, `notes`, `loan_date`, `closed_date`, `loan_amount`, `interest_rate_pct`, `status`, two `principal_repayment_n`/`principal_date_n` pairs, four `interest_payment_n`/`date_n` pairs |
| `Custom_RealEstate` | Land and buildings, at cost | `property_name`, `purchase_date`, `purchase_price`, `stamp_duty`, `registration_fee` |
| `Custom_Cash` | Cash and bank balances | `account_label`, `as_of_date`, `balance` |
| `Custom_ChitFunds` | Chit funds and savings schemes | `scheme_name`, `start_date`, `monthly_instalment`, `total_months` |
| `Custom_UnlistedShares` | Private company shares | `company_name`, `acquisition_date`, `quantity`, `price_per_share` |
| `Custom_GenericBroker` | Any broker without a parser | `trade_date`, `symbol`, `isin`, `trade_type`, `quantity`, `price` |

The same files are committed at [`templates/`](./templates), generated from the parser's own column
definitions by `npx tsx scripts/emit-templates.mts` — so the header you fill in and the header the
importer matches against can never drift apart.

Choosing **portTrack CSV template** as the statement type reveals a second dropdown listing the six
templates. Leave it on *Detect from the file's header* and the header decides, as before. Naming one
buys a better failure: a mismatch then reports the exact columns at fault —

```
Custom_Cash template header mismatch — missing column(s): balance
```

— rather than `this header matches no portTrack template: …`. It also catches a Hand Loans file
uploaded under Cash, which would otherwise import cleanly as the wrong asset class, and therefore
under the wrong tax treatment.

The hand-loan template also accepts the five **derived** columns a tracking sheet keeps —
`status`, `total_interest_months`, `interest_balance_months`, `interest_per_month`,
`total_overall_interest`, `interest_balance` — so an existing spreadsheet pastes in unchanged. They
are **recomputed**, not trusted: where a stated figure disagrees with the computed one the import
reports it rather than silently overriding either. A sheet that says only *"Repaid"*, with no
repayment row, has the repayment reconstructed on its closing date — otherwise the loan would show
its full principal outstanding, contradicting its own status.

**The template is identified by its header row**, which is why the header must stay exactly as
downloaded. Each template declares the asset class it holds; nothing is inferred from the file, since
asset class drives tax treatment and a wrong guess would be invisible. The `#` guidance lines at the
top are ignored on import — fill the file in and upload it as-is.

> `borrower_name` is hashed to an opaque reference that identifies the loan; the name itself is kept
> in your encrypted vault so the register can be filtered and sorted by it. It never appears in an
> AI payload or a log line. A **loan export you ask for does carry it** — that is what makes the file
> readable to the accountant or borrower you hand it to.

### Unlocking takes a moment, on purpose

The first unlock **sets** the passphrase; there is no default and no recovery path. Deriving the key
runs Argon2id at the OWASP baseline, which occupies a core for a few hundred milliseconds — that cost
is the point, since it is what makes guessing expensive.

The button therefore disables itself and says so while it works. Derivation runs on a worker thread,
so the rest of the API stays responsive: a health probe issued mid-unlock returns in 0.8 ms, against
310 ms when the KDF ran on the main thread and froze everything.

> A browser tab left open on the unlock screen will re-submit as soon as the API comes back. If you
> are deliberately wiping `data/`, close or reload that tab first, or it will recreate the vault
> under its old passphrase before you get there.

### Loans — the hand-loan register

A dedicated **Loans** tab replaces a hand-loan tracking spreadsheet. Record a loan, take interest
against it, take part of the principal back, and see what is still owed.

| It tracks | Because |
|---|---|
| Several loans to one borrower | Same day, different days, different years — each keeps its own rate and dates |
| Interest payments, unlimited | A spreadsheet had four columns and lost the fifth |
| Partial principal repayments | Interest accrues on the **declining balance** from the repayment date |
| Payment mode and notes | What a disputed payment turns on |
| Status: active / partially repaid / repaid | Derived from the principal, never typed in |

**Two tiles for pending interest, not one.** Interest owed on a loan whose principal has already
come back has no repayment arriving alongside it, so it is the balance most easily forgotten. Folded
into a single figure it disappears inside the larger number for live loans.

**The tiles describe the filtered set.** Filter to one borrower and the totals become that
borrower's. Filter by any combination of status and borrower; sort by borrower, status, loan date or
amount; export what you are looking at as **CSV or PDF**.

Everything is computed by the API, never in the browser — summing decimal strings in JavaScript
would reintroduce the float drift ADR-002 exists to prevent, and these are amounts someone owes you.

**A live loan counts toward net worth** as outstanding principal plus the interest **still owed**.
Interest already received is deliberately excluded: that money is sitting in a bank account, and
counting it again as a receivable would report it twice.

Loans appear in the **Ledger** under *Loans receivable*, not under Holdings. A loan is a receivable,
not a holding of units — it has no lots, no quantity and no cost per unit — so it is carried at
principal outstanding plus interest owed, and those carrying values sum to exactly the hand-loan
figure in net worth.

Amounts can be typed the way you write them — `1,00,000`, `100,000`, `₹1,00,000` all read as one
lakh. A comma is always a digit separator, never a decimal point.

> Borrower **names** live in the encrypted vault because the register is filtered and sorted by them.
> Anything that leaves this machine carries the opaque `borrowerRef` instead — except an export you
> ask for by name, which necessarily carries the name, since that is what makes it readable.

### Edit mode — changing and deleting is off until you say so

Everything portTrack holds is a record of money that has already **moved**. Adding to that is
routine: a wrong entry is visible on the screen, and correcting it leaves a trail. Changing or
deleting one is neither — a mistaken delete looks exactly like a record that was never made, and
there is nothing left to notice it by.

So the destructive half of the application is **off by default**, and turning it on is an act that
cannot happen by accident: **Settings → Edit mode**, re-enter the vault passphrase.

| Always available | Needs edit mode |
|---|---|
| Record a loan, a chit, a trade | Edit a loan or a chit |
| Record an interest payment, a repayment, a monthly instalment | Close or reopen a loan |
| Import a statement | Mark a chit drawn, or put it back to active |
| Enter this year's income for the first time | Replace the income already recorded |
| Save a withdrawal schedule under a **new** label | Replace an existing schedule's rows |
| | **Delete** a loan, chit, holding, disposal or schedule |

It applies across **every tab** from a single enable, shows in the top bar wherever you are, and
**ends with the session** — locking the vault or restarting the API turns it off. It is never
remembered, and there is no expiry setting: both would turn one deliberate decision into a standing
permission, which is the state it exists to avoid.

The passphrase is checked against the **vault key itself** — nothing extra is stored for this, so
there is no second secret on disk and none to keep in step after a passphrase change. That means it
is as slow as an unlock, for the same reason.

**The SPA hiding its buttons is courtesy, not the control.** The API refuses a gated request with
**403 EDIT_MODE_REQUIRED** whatever the browser believes, so a script, a `curl`, or a second client
is refused the same way. A UI-only gate is bypassed by anything that speaks HTTP.

Deleting is honest about what goes with it:

- a **holding** takes its lots, income events and the disposals recorded against it — an exit left
  behind would report a gain on units the book no longer says were ever acquired;
- a **disposal** returns its units to the lots it took them from, so the holding is whole again;
- a **hand loan** leaves its **audit trail behind**, with an entry saying it was deleted and why.
  That trail does not cascade with the loan, by design — it is the only remaining answer to "what
  happened to the loan I remember";
- a **withdrawal schedule** is refused while a chit still names it, rather than silently orphaning
  the figure that chit was showing.

There is no undo. The way back is your own backup of the data directory.

### Where FX rates come from

Every INR figure derived from a foreign holding passes through an exchange rate, and for tax the
rate is not a matter of choice. **Rule 115 of the Income-tax Rules, 1962** mandates the *telegraphic
transfer buying rate of the State Bank of India*, and for capital gains it names a specific date:

> *"the last day of the month immediately preceding the month in which the capital asset is
> transferred"*

The Income Tax Department publishes no rates itself — it specifies SBI's and leaves sourcing to you.
That is the whole problem: **SBI publishes today's card and does not serve history**, so a rate not
captured when it was available cannot be recovered. A share vesting in 2020 and sold in 2026 needs
the 2020 rate, and no amount of asking SBI in 2026 will produce it.

#### The archive

Historical TT Buy rates are imported from **[sahilgupta/sbi-fx-ratekeeper](https://github.com/sahilgupta/sbi-fx-ratekeeper)**,
specifically:

```
https://github.com/sahilgupta/sbi-fx-ratekeeper/blob/main/csv_files/SBI_REFERENCE_RATES_USD.csv
```

It is a daily scrape of SBI's own published PDF rate cards, and **every row links to the PDF it was
read from** — so a rate is traceable to SBI's document rather than to the scraper. That link is what
portTrack stores as the rate's provenance, not the archive's name.

It is still a third party's transcription, so the parser is built around not trusting it:

| Guard | Catches |
|---|---|
| Card rate must fall in 10–1000 | A slipped decimal point |
| Day-over-day move ≤ 25% within a 7-day window | A slipped decimal the band admits — `7.132` beside `71.65` |
| `TT BUY = 0` skipped **and counted** | The 54 days SBI published no transfer rate, so the gap is known rather than assumed |
| Same-day republished cards reported | The 12 days SBI issued two cards, 9 of which changed the rate |
| Any bad row rejects the whole file | A half-imported archive, whose missing days silently resolve as if SBI never published |

Verified against the real 1,641-row file: **1,575 rates, 2020-01-06 → 2026-09-11**, no false positives.

```bash
# download the CSV from the link above, then:
pnpm vault:rates:import ./SBI_REFERENCE_RATES_USD.csv USD
```

Importing rates requires **edit mode**. Every other import adds records you can see and correct; this
one writes the denominators every foreign figure is computed through, where a wrong value is
invisible in the output.

#### Two bases, both recorded

ADR-003 stores **two** rates per foreign transaction, and risk R4 records why:

- **Transaction-date rate** — what an RSU's cost basis uses, because the perquisite was already taxed
  in rupees at the rate on the day it vested. Measuring the gain from any other INR figure taxes the
  same rupees twice.
- **Rule 115 rate** — the last day of the preceding month, which is what the rule names for capital
  gains.

They differ, and which applies is genuinely contested. portTrack computes and stores both, records
which was applied to each figure, and **does not decide for you** — confirm the basis with your CA.

> SBI does not publish on Sundays or holidays, so a month-end frequently has no card. The resolver
> walks back to the last published day and flags that it did. 31 May 2026 was a Sunday; a June
> transfer resolves to the card of 30 May.

### Where your data lives

`${PORTTRACK_DATA_DIR:-./data}/vault.db` **on your own disk**, bind-mounted into the container
(ADR-012). Deliberately not a Docker named volume: those live under `/var/lib/docker`, are owned by
root, are invisible to your backup tooling and vanish to `docker volume prune`.

```
data/
├── vault.db            encrypted database (AES-256-CBC + HMAC-SHA512, page level)
├── vault.db.meta.json  KDF salt and parameters — BACK THIS UP TOO
└── vault.db-wal/-shm   SQLite write-ahead log
```

> **Back up the whole directory, not just `vault.db`.** The salt lives in `vault.db.meta.json`. A
> backup of the database alone restores to a vault nobody can open — and you would only discover
> that when you needed it most. `pnpm` users get this right automatically via `Backup.backup`, which
> archives both.

Your data survives `docker compose down`, `docker compose build --no-cache`, container recreation and
Docker Engine upgrades. Verified by the container suite, not assumed.

> **`vault.db-wal` is not a scratch file.** A process killed without a clean close leaves every
> committed page in the write-ahead log, so a 4 KB `vault.db` beside a 600 KB `vault.db-wal` is
> normal — and means the database file on its own holds nothing. This is a second reason to back up
> the whole directory.

#### When it will not unlock

`unlock` reports a wrong passphrase and a damaged vault as the **same** error, on purpose: the
response must not reveal whether a vault holds data (ADR-014). That is correct for an API and no help
at all to you, so the distinction is available offline instead:

```bash
read -rs -p 'passphrase: ' PORTTRACK_PASSPHRASE && export PORTTRACK_PASSPHRASE
pnpm vault:diagnose ./data
unset PORTTRACK_PASSPHRASE
```

Type it into the prompt rather than the command line, so it stays out of your shell history. The
tool works on a **copy** it deletes afterwards — your vault is never opened, so nothing it does can
checkpoint, truncate or lock it — and it prints the cipher parameters, table names and row counts
only: no passphrase, no salt, no row contents.

| Exit | Meaning | What to do |
|---|---|---|
| `0` | Passphrase right, database sound | The vault is fine; the problem is elsewhere |
| `1` | Passphrase right, **integrity check failed** | Restore the whole directory from a backup |
| `3` | Passphrase wrong | No recovery path — the key exists nowhere but in what you type |
| `4` | No vault at that path | Nothing to check; see the warning below |

**A directory with no vault is the dangerous case.** The first unlock on an empty data directory
*sets* the passphrase rather than checking it — there is no confirmation prompt and no recovery — so
pointing the app at the wrong directory silently creates a new, empty vault that looks exactly like
your data having vanished. `vault:diagnose` refuses to create one, which is why it can tell you `4`
instead of cheerfully accepting a passphrase you have never used.

> A browser tab left open on the unlock screen re-submits as soon as the API comes back. If you are
> deliberately wiping a data directory, **close that tab first** — otherwise it recreates the vault
> under its old passphrase before you get there.

### Operator reference

| Task | Command |
|---|---|
| First run | `cp .env.example .env && docker compose up` |
| Match file ownership to you | set `PORTTRACK_UID=$(id -u)` and `PORTTRACK_GID=$(id -g)` in `.env` |
| Change where data lives | set `PORTTRACK_DATA_DIR=/path/on/your/disk` |
| Back up | copy the whole data directory while the stack is stopped |
| Restore | copy it back, then `docker compose up` |
| Diagnose a vault that will not unlock | `pnpm vault:diagnose ./data` — see above |
| Start the testing instance | `pnpm docker:test:up` |
| Upgrade | `git pull && docker compose up --build` — data is untouched |
| Logs | `docker compose logs -f api` |
| Allow outbound (FX/NAV) | `docker compose -f compose.yaml -f compose.egress.yaml up` |

The API publishes **no** host port and sits on an isolated network with no route to the internet.
That is not the application policing itself — the network has no gateway, so a compromised dependency
inside the API cannot exfiltrate a vault even if it tries.

### Developing without containers

```bash
pnpm install
pnpm --filter @porttrack/app-web dev   # SPA on :5173, proxying /api
node apps/api/build.mjs && node apps/api/dist/server.mjs
```

## Commands

```bash
pnpm install
pnpm test              # unit + functional (hermetic, no network)
pnpm typecheck         # strict TS, currently clean
pnpm bench             # NFR-2 performance budgets
pnpm test:container    # FR-8 Docker acceptance — needs a Docker daemon
pnpm test:e2e          # Playwright against the containerized stack
```

`test:e2e` needs the stack running and a matching browser:

```bash
npx playwright install chromium         # once; downloads ~115 MB
docker compose up -d
PORTTRACK_WEB_PORT=5273 pnpm test:e2e   # match the port in your .env
```

It asserts what each section **renders**, not that its link exists — the distinction that let a
completely dead navigation bar pass as DONE once already.

## Running the stack (from M9)

```bash
cp .env.example .env          # set PORTTRACK_DATA_DIR, PORTTRACK_UID/GID
docker compose up
```

Your encrypted database lives on **your own disk** at `${PORTTRACK_DATA_DIR:-./data}/vault.db` via a
bind mount — not in a Docker-managed volume. It survives `docker compose down`, image rebuilds and
Docker upgrades, and you can back it up with ordinary host tools (ADR-012).

## Design commitments

- **Dual FX rate per foreign transaction** (ADR-003) — trade-date ITBR for valuation, Rule 115 rate
  for taxable income. Resolves the PRD's FR-1 vs FR-2 conflict; both are stored with provenance.
- **All money is `Decimal`** (ADR-002). No `number` arithmetic on currency, anywhere.
- **Tax rates are FY-keyed data** (ADR-005), never literals in engine code.
- **Snapshots are immutable and content-addressed** (ADR-006).
- **PII masking runs in the browser and fails closed** (ADR-007, ADR-013). Two independent guards;
  neither warns-and-continues.
- **Zero network egress by default** (ADR-010), through a single audited gateway.
- **Periods are server-derived** (`GET /api/reference/periods`). The browser never decides which
  financial year it is — a client a timezone away would disagree with the engine computing the tax.
  The current FY and calendar year are always *offered*; the *default* is the most recent period that
  can actually be computed, which is not the same thing.

## Repository layout

```
packages/   shared-kernel · core-domain · fx-itbr · tax-engine · snapshot
            ingestion · compliance · pii-masker · persistence · adapters-fx · app-services
apps/       api (Fastify) · web (React SPA) · cli
docker/     api.Dockerfile · web.Dockerfile · Caddyfile · entrypoint
tests/      functional · container · e2e · fixtures · test-kit
```

Domain packages are pure — no `fs`, no `fetch`, no ambient clock. Time and identity are injected
ports, which is what makes the tax engine deterministically testable across financial years.

## Test fixtures

All fixtures are synthetic. No real PAN, Aadhaar, folio or account number is in this repository; a
guard test enforces it. The encrypted CAMS CAS fixture is generated by
[`tests/fixtures/cams/generate-cas-fixture.mjs`](./tests/fixtures/cams/generate-cas-fixture.mjs),
a zero-dependency implementation of the PDF standard security handler.
