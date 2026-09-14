/**
 * US-1.3 — Partial and complete exit with FIFO lot allocation (PRD FR-1.2)
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { FifoAllocator } from '@porttrack/core-domain';
import { aLot, expectErr, expectOk, inr } from '@porttrack/test-kit';

const L1 = aLot({
  lotId: 'L1',
  acquisitionDate: '2023-01-10',
  quantity: '100',
  remainingQuantity: '100',
  costPerUnit: inr('100'),
});
const L2 = aLot({
  lotId: 'L2',
  acquisitionDate: '2024-06-01',
  quantity: '50',
  remainingQuantity: '50',
  costPerUnit: inr('150'),
});

describe('US-1.3 FIFO allocation', () => {
  describe('Scenario: Partial exit consumes oldest lot first', () => {
    it('allocates 100 units from L1 and 20 from L2 for a 120-unit sell', () => {
      const { allocations } = expectOk(FifoAllocator.allocate([L1, L2], '120'));
      expect(allocations.map((a) => [a.lotId, a.quantity])).toEqual([
        ['L1', '100'],
        ['L2', '20'],
      ]);
    });

    it('leaves L1 fully consumed and L2 with 30 remaining', () => {
      const { updatedLots } = expectOk(FifoAllocator.allocate([L1, L2], '120'));
      const byId = new Map(updatedLots.map((l) => [l.lotId, l.remainingQuantity]));
      expect(byId.get('L1')).toBe('0');
      expect(byId.get('L2')).toBe('30');
    });

    it('yields a realised gain of ₹11,000 at a ₹200 sale price', () => {
      const { allocations } = expectOk(FifoAllocator.allocate([L1, L2], '120'));
      const cost = allocations.reduce(
        (sum, a) => sum + Number(a.quantity) * Number(a.costPerUnit.amount),
        0,
      );
      const proceeds = 120 * 200;
      expect(proceeds - cost).toBe(11000);
    });

    it('ignores input ordering and allocates by acquisition date', () => {
      const { allocations } = expectOk(FifoAllocator.allocate([L2, L1], '120'));
      expect(allocations[0]?.lotId).toBe('L1');
    });
  });

  describe('Scenario: Oversell is rejected atomically', () => {
    it('fails with INSUFFICIENT_QUANTITY when selling 151 of 150', () => {
      expectErr(FifoAllocator.allocate([L1, L2], '151'), 'INSUFFICIENT_QUANTITY');
    });

    it('mutates no lot on rejection', () => {
      const lots = [L1, L2];
      const snapshot = JSON.stringify(lots);
      FifoAllocator.allocate(lots, '151');
      expect(JSON.stringify(lots)).toBe(snapshot);
    });
  });

  describe('Scenario: Complete exit zeroes the position', () => {
    it('leaves remainingQuantity 0 after selling the whole lot', () => {
      const { updatedLots } = expectOk(FifoAllocator.allocate([L1], '100'));
      expect(updatedLots[0]?.remainingQuantity).toBe('0');
    });
  });

  describe('DoD: property-based FIFO invariants over 1,000 random sequences', () => {
    it('allocated quantity always equals the quantity sold', () => {
      fc.assert(
        fc.property(
          fc.array(fc.integer({ min: 1, max: 500 }), { minLength: 1, maxLength: 20 }),
          fc.integer({ min: 1, max: 100 }),
          (quantities, pct) => {
            const lots = quantities.map((q, i) =>
              aLot({
                lotId: `L${String(i)}`,
                acquisitionDate: `20${String(20 + (i % 6))}-01-01`,
                quantity: String(q),
                remainingQuantity: String(q),
              }),
            );
            const total = quantities.reduce((a, b) => a + b, 0);
            const sell = Math.max(1, Math.floor((total * pct) / 100));
            const result = FifoAllocator.allocate(lots, String(sell));
            if (!result.ok) return true;
            const allocated = result.value.allocations.reduce(
              (sum, a) => sum + Number(a.quantity),
              0,
            );
            return allocated === sell;
          },
        ),
        { numRuns: 1000 },
      );
    });

    it('remaining quantity is non-increasing across successive exits', () => {
      fc.assert(
        fc.property(
          fc.array(fc.integer({ min: 1, max: 50 }), { minLength: 2, maxLength: 10 }),
          (sells) => {
            let lots = [aLot({ lotId: 'L', quantity: '1000', remainingQuantity: '1000' })];
            let previous = 1000;
            for (const sell of sells) {
              const result = FifoAllocator.allocate(lots, String(sell));
              if (!result.ok) break;
              lots = [...result.value.updatedLots];
              const current = lots.reduce((sum, l) => sum + Number(l.remainingQuantity), 0);
              if (current > previous) return false;
              previous = current;
            }
            return true;
          },
        ),
        { numRuns: 1000 },
      );
    });
  });
});

/**
 * The inverse: what a deleted disposal has to put back.
 *
 * Driven by the disposal's own allocations rather than by running FIFO
 * backwards. FIFO would return units to the OLDEST lots, which is not
 * necessarily where they came from once several exits have been recorded — and a
 * lot handed back units it never gave up carries the wrong acquisition date,
 * which is what long-term versus short-term turns on.
 */
describe('US-1.3 Restoring a reversed allocation', () => {
  describe('Scenario: The disposal is undone', () => {
    it('returns each lot exactly what that disposal took', () => {
      const { allocations, updatedLots } = expectOk(FifoAllocator.allocate([L1, L2], '120'));

      const restored = expectOk(FifoAllocator.restore(updatedLots, allocations));

      const byId = new Map(restored.map((lot) => [lot.lotId, lot.remainingQuantity]));
      expect(byId.get('L1')).toBe('100');
      expect(byId.get('L2')).toBe('50');
    });

    it('leaves lots the disposal never touched alone', () => {
      const { allocations, updatedLots } = expectOk(FifoAllocator.allocate([L1, L2], '40'));

      const restored = expectOk(FifoAllocator.restore(updatedLots, allocations));

      expect(restored.find((lot) => lot.lotId === 'L2')?.remainingQuantity).toBe('50');
    });

    /*
     * Undoing the SECOND of two sells must put back only that sell's units. This
     * is the case a FIFO-backwards implementation gets wrong: it would credit the
     * oldest lot, which the first sell had already emptied.
     */
    it('undoes one sell of several without disturbing the earlier ones', () => {
      const first = expectOk(FifoAllocator.allocate([L1, L2], '100'));
      const second = expectOk(FifoAllocator.allocate(first.updatedLots, '30'));

      const restored = expectOk(FifoAllocator.restore(second.updatedLots, second.allocations));

      const byId = new Map(restored.map((lot) => [lot.lotId, lot.remainingQuantity]));
      // L1 stays emptied by the first sell; only L2's 30 come back.
      expect(byId.get('L1')).toBe('0');
      expect(byId.get('L2')).toBe('50');
    });
  });

  describe('Scenario: The allocations no longer describe this book', () => {
    it('refuses rather than clamping when a lot would exceed what it acquired', () => {
      // Restoring twice: the second would leave L1 holding 200 of an original 100.
      const { allocations } = expectOk(FifoAllocator.allocate([L1, L2], '100'));

      expectErr(FifoAllocator.restore([L1, L2], allocations), 'INSUFFICIENT_QUANTITY');
    });

    it('refuses when the lot it must credit is no longer on the book', () => {
      const { allocations, updatedLots } = expectOk(FifoAllocator.allocate([L1, L2], '120'));

      expectErr(
        FifoAllocator.restore(
          updatedLots.filter((lot) => lot.lotId !== 'L1'),
          allocations,
        ),
        'INSUFFICIENT_QUANTITY',
      );
    });
  });

  describe('Property: allocate then restore is the identity', () => {
    it('returns the book to exactly what it was, for any legal quantity', () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 150 }), (quantity) => {
          const { allocations, updatedLots } = expectOk(
            FifoAllocator.allocate([L1, L2], String(quantity)),
          );
          const restored = expectOk(FifoAllocator.restore(updatedLots, allocations));

          expect(restored.map((lot) => lot.remainingQuantity)).toEqual(['100', '50']);
        }),
      );
    });
  });
});
