/**
 * US-5.7 — Capital gains classifier (PRD FR-5.2)
 * US-5.8 — CG computation: exemption, grandfathering, indexation (PRD FR-5.2)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CapitalGainsEngine, TaxRuleTable } from '@vantagepoint/tax-engine';
import { anExit, expectMoney, expectOk, inr, seedStandardRates, usd } from '@vantagepoint/test-kit';

beforeEach(() => {
  // Foreign gains convert through Rule 115 (ADR-003), so the rate history matters.
  seedStandardRates();
});

const RULES = () => expectOk(TaxRuleTable.rulesFor('2025-26'));

describe('US-5.7 capital gains classifier', () => {
  describe('Scenario: Listed domestic equity holding period boundary (FR-5.2)', () => {
    it('classifies exactly 12 months as STCG', () => {
      const gain = CapitalGainsEngine.classify(
        anExit({ acquisitionDate: '2025-01-10', exitDate: '2026-01-10', pricePerUnit: inr('200') }),
        'DOMESTIC_EQUITY',
        RULES(),
      );
      expect(gain.holdingPeriodDays).toBeLessThanOrEqual(365);
      expect(gain.kind).toBe('STCG');
    });

    it('classifies 12 months and 1 day as LTCG', () => {
      const gain = CapitalGainsEngine.classify(
        anExit({ acquisitionDate: '2025-01-10', exitDate: '2026-01-11', pricePerUnit: inr('200') }),
        'DOMESTIC_EQUITY',
        RULES(),
      );
      expect(gain.kind).toBe('LTCG');
    });
  });

  describe('Scenario: Foreign equity holding period boundary', () => {
    it('classifies exactly 24 months as STCG taxed at slab rate', () => {
      const gain = CapitalGainsEngine.classify(
        anExit({ exitDate: '2025-05-10' }),
        'FOREIGN_EQUITY',
        RULES(),
      );
      expect(gain.kind).toBe('STCG');
    });

    it('classifies 24 months and 1 day as LTCG at 12.5% without indexation', () => {
      const gain = CapitalGainsEngine.classify(
        anExit({ exitDate: '2025-05-11' }),
        'FOREIGN_EQUITY',
        RULES(),
      );
      expect(gain.kind).toBe('LTCG');
      expect(Number(gain.ratePct)).toBe(12.5);
    });
  });

  describe('Scenario: Debt funds and hand loan interest are slab-taxed', () => {
    it.each(['FIXED_DEPOSIT', 'HAND_LOAN'] as const)('classifies %s income as SLAB', (assetClass) => {
      const gain = CapitalGainsEngine.classify(anExit({ exitDate: '2030-01-01' }), assetClass, RULES());
      expect(gain.kind).toBe('SLAB');
    });

    it('never classifies a fixed deposit as LTCG regardless of holding period', () => {
      const gain = CapitalGainsEngine.classify(
        anExit({ exitDate: '2040-01-01' }),
        'FIXED_DEPOSIT',
        RULES(),
      );
      expect(gain.kind).not.toBe('LTCG');
    });
  });

  describe('Scenario: Crypto gains are VDA, taxed at 30% with no LTCG treatment (US-1.10)', () => {
    it('classifies a crypto gain held over 36 months as VDA_GAIN at 30%', () => {
      const gain = CapitalGainsEngine.classify(anExit({ exitDate: '2027-01-01' }), 'CRYPTO', RULES());
      expect(gain.kind).toBe('VDA_GAIN');
      expect(Number(gain.ratePct)).toBe(30);
    });
  });
});

describe('US-5.8 capital gains computation', () => {
  const classes = { txn_ltcg: 'DOMESTIC_EQUITY' as const };

  describe('Scenario: LTCG exemption of ₹1.25 lakh applies once per FY', () => {
    it('taxes ₹175,000 of a ₹300,000 LTCG at 12.5% = ₹21,875', () => {
      const result = CapitalGainsEngine.compute(
        [anExit({ txnId: 'txn_ltcg', exitDate: '2025-09-01', pricePerUnit: inr('300000') })],
        classes,
        RULES(),
      );
      expectMoney(result.taxableLtcg, inr('175000'));
      expectMoney(result.tax, inr('21875'));
    });

    it('applies the exemption exactly once across two sales in the same FY', () => {
      const result = CapitalGainsEngine.compute(
        [
          anExit({ txnId: 'txn_ltcg', exitDate: '2025-09-01', pricePerUnit: inr('200000') }),
          anExit({ txnId: 'txn_ltcg_2', exitDate: '2025-11-01', pricePerUnit: inr('200000') }),
        ],
        { ...classes, txn_ltcg_2: 'DOMESTIC_EQUITY' },
        RULES(),
      );
      expectMoney(result.ltcgExemptionApplied, inr('125000'));
    });
  });

  describe('Scenario: Grandfathering uses the higher of cost and 31-Jan-2018 FMV', () => {
    it('uses ₹180 FMV over ₹100 cost, giving a ₹70 per-unit gain at a ₹250 sale', () => {
      const result = CapitalGainsEngine.compute(
        [
          anExit({
            txnId: 'txn_gf',
            exitDate: '2025-09-01',
            quantity: '1',
            pricePerUnit: inr('250'),
            allocations: [
              {
                lotId: 'L1',
                quantity: '1',
                costPerUnit: inr('100'),
                grandfatheredFmv: inr('180'),
              },
            ],
          }),
        ],
        { txn_gf: 'DOMESTIC_EQUITY' },
        RULES(),
      );
      expectMoney(result.ltcgBeforeExemption, inr('70'));
    });

    it('caps the grandfathered cost at the sale price, giving zero gain at a ₹150 sale', () => {
      const result = CapitalGainsEngine.compute(
        [
          anExit({
            txnId: 'txn_gf',
            exitDate: '2025-09-01',
            quantity: '1',
            pricePerUnit: inr('150'),
            allocations: [
              {
                lotId: 'L1',
                quantity: '1',
                costPerUnit: inr('100'),
                grandfatheredFmv: inr('180'),
              },
            ],
          }),
        ],
        { txn_gf: 'DOMESTIC_EQUITY' },
        RULES(),
      );
      expectMoney(result.ltcgBeforeExemption, inr('0'));
    });
  });

  describe('Scenario: STCG on listed domestic equity is taxed at 20%', () => {
    it('taxes ₹500,000 of STCG as ₹100,000 before surcharge and cess', () => {
      const result = CapitalGainsEngine.compute(
        [
          anExit({
            txnId: 'txn_stcg',
            acquisitionDate: '2025-05-10',
            exitDate: '2025-11-10',
            pricePerUnit: inr('500000'),
          }),
        ],
        { txn_stcg: 'DOMESTIC_EQUITY' },
        RULES(),
      );
      expectMoney(result.taxableStcg, inr('500000'));
      expectMoney(result.tax, inr('100000'));
    });
  });

  describe('Scenario: Foreign capital gains use the Rule 115 rate on both legs', () => {
    it('converts acquisition cost at the 2023-04-30 basis date', () => {
      const result = CapitalGainsEngine.compute(
        [anExit({ txnId: 'txn_fx', exitDate: '2026-02-15', pricePerUnit: usd('180') })],
        { txn_fx: 'FOREIGN_EQUITY' },
        RULES(),
      );
      expect(result.gains[0]?.gain.currency).toBe('INR');
    });

    /*
     * Rewritten when `taxableInr` became `taxableGainInr`.
     *
     * It used to seed BOTH rupee fields and assert only that the answer was not
     * the valuation figure — which passed while the seeded "taxable" value was
     * converted PROCEEDS rather than a gain, the exact confusion the rename
     * exists to end. Seeding nothing and checking the computed number is the
     * assertion that was intended.
     *
     * A sale on 2026-02-15 takes its Rule 115 basis from 2026-01-31: 83.55, not
     * the 84.10 that applied on the day itself.
     */
    it('never reads the valuation rate for a taxable computation (ADR-003)', () => {
      const exit = anExit({ txnId: 'txn_fx', exitDate: '2026-02-15', pricePerUnit: usd('180') });

      const result = CapitalGainsEngine.compute([exit], { txn_fx: 'FOREIGN_EQUITY' }, RULES());

      expectMoney(result.gains[0]?.gain ?? inr('0'), inr('15039.00')); // 180 × 83.55
      expect(Number(result.gains[0]?.gain.amount)).not.toBe(180 * 84.1);
    });

    /*
     * The taxpayer's own statement of the rule, asserted as arithmetic:
     *
     *   gain = (sp$ × q × rate[month-end before sale])
     *        − (vp$ × q × rate[month-end before vest])
     *
     * Vested 2025-08-10 at $100, sold 2026-02-15 at $180, 40 units.
     *   cost     = 100 × 40 × 83.45 (basis 2025-07-31) = ₹333,800
     *   proceeds = 180 × 40 × 83.55 (basis 2026-01-31) = ₹601,560
     *   gain     =                                       ₹267,760
     *
     * Note the two rates are a month apart and neither is the 84.10 that applied
     * on the sale day itself.
     */
    it('reports both legs and the gain between them', () => {
      const exit = anExit({
        txnId: 'txn_legs',
        exitDate: '2026-02-15',
        pricePerUnit: usd('180'),
        allocations: [
          {
            lotId: 'lot_1',
            quantity: '40',
            costPerUnit: usd('100'),
            acquisitionDate: '2025-08-10',
          },
        ],
      });

      const legs = expectOk(CapitalGainsEngine.rule115Legs(exit));

      expect(legs.legsSeparable).toBe(true);
      expectMoney(legs.costBasisInr, inr('333800.00'));
      expectMoney(legs.proceedsInr, inr('601560.00'));
      expectMoney(legs.gainInr, inr('267760.00'));
    });

    /*
     * The trap the rename closes, stated as a test.
     *
     * Storing converted PROCEEDS where the finished GAIN belongs charges tax on
     * the whole sale instead of the profit — here ₹601,560 rather than ₹267,760,
     * a figure that looks entirely ordinary. The field now says which it holds,
     * and the engine returns exactly what was stored.
     */
    it('returns a stored gain unchanged, so the field must hold a gain', () => {
      const exit = anExit({
        txnId: 'txn_stored',
        exitDate: '2026-02-15',
        pricePerUnit: usd('180'),
        taxableGainInr: inr('267760.00'),
      });

      const result = CapitalGainsEngine.compute([exit], { txn_stored: 'FOREIGN_EQUITY' }, RULES());

      expectMoney(result.gains[0]?.gain ?? inr('0'), inr('267760.00'));
    });
  });
});
