/**
 * US-8.4 — Money and Decimal value objects (ADR-002)
 *
 * Relocated here from the persistence package: Money belongs to shared-kernel and
 * its tests must not sit behind a database dependency.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { CurrencyMismatchError, Money } from '@vantagepoint/shared-kernel';
import { expectMoney, inr, usd } from '@vantagepoint/test-kit';

describe('US-8.4 Money value object (ADR-002)', () => {
  describe('Scenario: Currency mismatch is an error', () => {
    // Asserted on the error type, not its wording: the message is diagnostic text,
    // the class and code are the contract callers actually branch on.
    const expectMismatch = (operation: () => unknown): void => {
      expect(operation).toThrowError(CurrencyMismatchError);
      try {
        operation();
      } catch (error) {
        expect((error as CurrencyMismatchError).code).toBe('CURRENCY_MISMATCH');
      }
    };

    it('throws when adding INR and USD', () => {
      expectMismatch(() => Money.add(inr('100'), usd('100')));
    });

    it('throws when subtracting mismatched currencies', () => {
      expectMismatch(() => Money.subtract(inr('100'), usd('100')));
    });

    it('throws when comparing mismatched currencies', () => {
      expectMismatch(() => Money.compare(inr('100'), usd('100')));
    });

    it('throws when summing a mixed-currency list', () => {
      expectMismatch(() => Money.sum([inr('100'), usd('100')], 'INR'));
    });

    it('does not leak amounts into the error message', () => {
      try {
        Money.add(inr('5000000'), usd('100'));
      } catch (error) {
        expect((error as Error).message).not.toContain('5000000');
      }
    });
  });

  describe('Scenario: Rounding is explicit and half-up by default for currency display', () => {
    it('rounds ₹2.005 to ₹2.01 under HALF_UP', () => {
      expectMoney(Money.round(inr('2.005'), 2, 'HALF_UP'), inr('2.01'));
    });

    it('rounds ₹2.005 to ₹2.00 under HALF_EVEN', () => {
      expectMoney(Money.round(inr('2.005'), 2, 'HALF_EVEN'), inr('2.00'));
    });

    it('rounds ₹2.015 to ₹2.02 under HALF_EVEN', () => {
      expectMoney(Money.round(inr('2.015'), 2, 'HALF_EVEN'), inr('2.02'));
    });

    it('truncates toward zero under DOWN', () => {
      expectMoney(Money.round(inr('2.019'), 2, 'DOWN'), inr('2.01'));
    });

    it('rounds away from zero under UP', () => {
      expectMoney(Money.round(inr('2.011'), 2, 'UP'), inr('2.02'));
    });

    it('rounds negative amounts symmetrically under HALF_UP', () => {
      expectMoney(Money.round(inr('-2.005'), 2, 'HALF_UP'), inr('-2.01'));
    });
  });

  describe('Scenario: Tax payable rounds to the nearest ₹10 per section 288B', () => {
    it.each([
      ['123456', '123460'],
      ['123454', '123450'],
      ['123455', '123460'],
      ['0', '0'],
      ['4', '0'],
      ['5', '10'],
    ])('rounds ₹%s to ₹%s', (input, expected) => {
      expectMoney(Money.roundToNearestTen(inr(input)), inr(expected));
    });
  });

  describe('D5: no float drift', () => {
    it('sums 0.1 + 0.2 to exactly 0.30', () => {
      expectMoney(Money.add(inr('0.1'), inr('0.2')), inr('0.30'));
    });

    it('sums a thousand ₹0.01 amounts to exactly ₹10.00', () => {
      expectMoney(Money.sum(Array.from({ length: 1000 }, () => inr('0.01')), 'INR'), inr('10.00'));
    });

    it('multiplies ₹0.10 by 3 to exactly ₹0.30', () => {
      expectMoney(Money.multiply(inr('0.10'), 3), inr('0.30'));
    });

    it('preserves precision far beyond float safety', () => {
      expectMoney(Money.add(inr('9007199254740993'), inr('1')), inr('9007199254740994'));
    });
  });

  describe('Arithmetic and comparison', () => {
    it('subtracts to a negative result', () => {
      expectMoney(Money.subtract(inr('100'), inr('150')), inr('-50'));
    });

    it('divides exactly', () => {
      expectMoney(Money.divide(inr('100'), 4), inr('25'));
    });

    it('negates', () => {
      expectMoney(Money.negate(inr('100')), inr('-100'));
    });

    it('detects zero regardless of scale', () => {
      expect(Money.isZero(inr('0.00'))).toBe(true);
      expect(Money.isZero(inr('0'))).toBe(true);
      expect(Money.isZero(inr('0.01'))).toBe(false);
    });

    it('compares by value, not by string', () => {
      expect(Money.compare(inr('2.0'), inr('2.00'))).toBe(0);
      expect(Money.compare(inr('10'), inr('9'))).toBe(1);
      expect(Money.compare(inr('9'), inr('10'))).toBe(-1);
    });

    it('treats equal values with different scales as equal', () => {
      expect(Money.equals(inr('2.0'), inr('2.00'))).toBe(true);
    });

    it('sums an empty list to zero in the requested currency', () => {
      expectMoney(Money.sum([], 'USD'), usd('0'));
    });

    it('builds zero in any currency', () => {
      expect(Money.zero('USD').currency).toBe('USD');
      expect(Money.isZero(Money.zero('USD'))).toBe(true);
    });

    it('rejects a non-numeric amount', () => {
      expect(() => Money.of('not-a-number', 'INR')).toThrowError();
    });

    it('accepts a numeric literal without introducing drift', () => {
      expectMoney(Money.of(1234.56, 'INR'), inr('1234.56'));
    });
  });

  describe('Property: Money arithmetic obeys algebraic laws (DoD D2)', () => {
    const amount = () =>
      fc.integer({ min: -10_000_000, max: 10_000_000 }).map((n) => inr((n / 100).toFixed(2)));

    it('is commutative under addition', () => {
      fc.assert(
        fc.property(amount(), amount(), (a, b) =>
          Money.equals(Money.add(a, b), Money.add(b, a)),
        ),
        { numRuns: 500 },
      );
    });

    it('is associative under addition', () => {
      fc.assert(
        fc.property(amount(), amount(), amount(), (a, b, c) =>
          Money.equals(Money.add(Money.add(a, b), c), Money.add(a, Money.add(b, c))),
        ),
        { numRuns: 500 },
      );
    });

    it('round-trips add then subtract', () => {
      fc.assert(
        fc.property(amount(), amount(), (a, b) =>
          Money.equals(Money.subtract(Money.add(a, b), b), a),
        ),
        { numRuns: 500 },
      );
    });

    it('agrees between sum() and repeated add()', () => {
      fc.assert(
        fc.property(fc.array(amount(), { minLength: 0, maxLength: 40 }), (items) =>
          Money.equals(
            Money.sum(items, 'INR'),
            items.reduce((acc, m) => Money.add(acc, m), Money.zero('INR')),
          ),
        ),
        { numRuns: 300 },
      );
    });

    it('never rounds a value further from the original than half the unit', () => {
      fc.assert(
        fc.property(amount(), (a) => {
          const rounded = Money.round(a, 0, 'HALF_UP');
          return Math.abs(Number(rounded.amount) - Number(a.amount)) <= 0.5;
        }),
        { numRuns: 500 },
      );
    });
  });
});
