/**
 * US-7.1 — Regex-based PII masking rules (PRD FR-7.2)
 * US-7.2 — NER-based name masking
 * US-7.3 — Full masking pipeline (PRD FR-7 AC)
 * US-7.4 — Fail-closed egress guard (ADR-007)
 * US-7.5 — Deterministic pseudonymisation
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  EntityDetector,
  MaskingPipeline,
  NerMasker,
  PiiVerifier,
  Pseudonymiser,
  RegexRules,
} from '@vantagepoint/pii-masker';
import { expectNoPii, SYNTHETIC } from '@vantagepoint/test-kit';

describe('US-7.1 regex masking rules', () => {
  describe('Scenario: PAN is masked', () => {
    it('replaces a PAN with [REDACTED_PAN]', () => {
      const { masked } = RegexRules.mask(`PAN: ${SYNTHETIC.PAN}`);
      expect(masked).toContain('[REDACTED_PAN]');
    });

    it('leaves no trace of the original PAN', () => {
      expect(RegexRules.mask(`PAN: ${SYNTHETIC.PAN}`).masked).not.toContain(SYNTHETIC.PAN);
    });
  });

  describe('Scenario: Aadhaar is masked in spaced and unspaced forms', () => {
    it.each([SYNTHETIC.AADHAAR_SPACED, SYNTHETIC.AADHAAR_PLAIN])('masks %s', (aadhaar) => {
      const { masked } = RegexRules.mask(`Aadhaar ${aadhaar}`);
      expect(masked).toContain('[REDACTED_AADHAAR]');
      expect(masked).not.toContain(aadhaar);
    });
  });

  describe('Scenario: DP ID / Client ID / Folio are masked', () => {
    it('masks a 16-digit DP ID', () => {
      expect(RegexRules.mask(`DPID: ${SYNTHETIC.DPID}`).masked).toContain(
        '[REDACTED_DEMAT_ACCOUNT]',
      );
    });

    it('masks a folio number', () => {
      expect(RegexRules.mask(`Folio No: ${SYNTHETIC.FOLIO}`).masked).toContain(
        '[REDACTED_DEMAT_ACCOUNT]',
      );
    });
  });

  describe('Scenario: Email, phone and address are masked', () => {
    it.each([SYNTHETIC.EMAIL, SYNTHETIC.PHONE, SYNTHETIC.ADDRESS])('masks %s', (value) => {
      const { masked } = RegexRules.mask(`Contact ${value}`);
      expect(masked).toContain('[REDACTED_CONTACT]');
      expect(masked).not.toContain(value);
    });
  });

  describe('Scenario: Transaction and order IDs are masked', () => {
    it('masks an order ID', () => {
      expect(RegexRules.mask(`Order ID: ${SYNTHETIC.ORDER_ID}`).masked).toContain(
        '[REDACTED_TXN_ID]',
      );
    });
  });

  describe('Scenario: Non-PII numerics are preserved', () => {
    const text = 'holding 500 shares of TCS at ₹3,850.00';

    it('preserves the quantity', () => {
      expect(RegexRules.mask(text).masked).toContain('500');
    });

    it('preserves the symbol', () => {
      expect(RegexRules.mask(text).masked).toContain('TCS');
    });

    it('preserves the price', () => {
      expect(RegexRules.mask(text).masked).toContain('3,850.00');
    });
  });

  describe('Masking is idempotent', () => {
    it('produces the same output when applied twice', () => {
      const once = RegexRules.mask(`PAN: ${SYNTHETIC.PAN}`).masked;
      expect(RegexRules.mask(once).masked).toBe(once);
    });
  });
});

describe('US-7.2 NER name masking', () => {
  describe('Scenario: Person names are masked while company names survive', () => {
    const text = `Analyze portfolio for ${SYNTHETIC.PERSON} holding 500 shares of ${SYNTHETIC.ORG}`;

    it('masks the person name', () => {
      const { masked } = NerMasker.maskPersonNames(text);
      expect(masked).toContain('[REDACTED_NAME]');
      expect(masked).not.toContain(SYNTHETIC.PERSON);
    });

    it('preserves the organisation name', () => {
      expect(NerMasker.maskPersonNames(text).masked).toContain(SYNTHETIC.ORG);
    });
  });

  describe('Scenario: NER runs entirely locally', () => {
    it('masks a name without issuing a network request', () => {
      // The global fetch trap (tests/test-kit/setup.ts) throws on any network use,
      // so a successful mask proves the model ran locally.
      const { masked } = NerMasker.maskPersonNames(`Hello ${SYNTHETIC.PERSON}`);
      expect(masked).toBe('Hello [REDACTED_NAME]');
    });

    it('detects the person entity with its span', () => {
      const { entities } = NerMasker.maskPersonNames(`Hello ${SYNTHETIC.PERSON}`);
      expect(entities).toEqual([
        { kind: 'NAME', start: 6, end: 6 + SYNTHETIC.PERSON.length },
      ]);
    });
  });
});

describe('US-7.3 full masking pipeline', () => {
  describe('Scenario: PII scrubbing prior to LLM prompt submission (PRD FR-7 AC)', () => {
    const RAW = `Analyze portfolio for ${SYNTHETIC.PERSON}, PAN: ${SYNTHETIC.PAN}, DPID: ${SYNTHETIC.DPID} holding 500 shares of TCS`;
    const EXPECTED =
      'Analyze portfolio for [REDACTED_NAME], PAN: [REDACTED_PAN], DPID: [REDACTED_DEMAT_ACCOUNT] holding 500 shares of TCS';

    it('produces exactly the payload mandated by the PRD', () => {
      expect(MaskingPipeline.maskText(RAW)).toBe(EXPECTED);
    });

    it('leaks no PII entity', () => {
      expectNoPii(MaskingPipeline.maskText(RAW));
    });
  });

  describe('Scenario: Structured portfolio payloads are masked recursively', () => {
    const payload = {
      user: { panNumber: SYNTHETIC.PAN, name: SYNTHETIC.PERSON },
      holdings: [
        {
          symbol: 'TCS',
          quantity: 500,
          demat: { folioNo: SYNTHETIC.FOLIO, dpId: SYNTHETIC.DPID },
        },
      ],
      loans: [{ borrowerName: SYNTHETIC.PERSON_2, principal: 5000000 }],
    };

    it('masks PII at every nesting level', () => {
      expectNoPii(JSON.stringify(MaskingPipeline.maskPayload(payload)));
    });

    it('preserves the JSON structure', () => {
      const masked = MaskingPipeline.maskPayload(payload);
      expect(Object.keys(masked)).toEqual(['user', 'holdings', 'loans']);
      expect(masked.holdings).toHaveLength(1);
    });

    it('preserves all non-PII values', () => {
      const masked = MaskingPipeline.maskPayload(payload);
      expect(masked.holdings[0]?.symbol).toBe('TCS');
      expect(masked.holdings[0]?.quantity).toBe(500);
      expect(masked.loans[0]?.principal).toBe(5000000);
    });
  });
});

describe('US-7.4 fail-closed egress guard (ADR-007)', () => {
  describe('Scenario: Residual PII aborts the AI call', () => {
    it('rejects a payload still containing a PAN', () => {
      const result = PiiVerifier.assertClean(`Analyze for [REDACTED_NAME], PAN: ${SYNTHETIC.PAN}`);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('PII_LEAK');
    });

    it('accepts a fully masked payload', () => {
      expect(PiiVerifier.assertClean('Analyze for [REDACTED_NAME], PAN: [REDACTED_PAN]').ok).toBe(
        true,
      );
    });

    it('reports the entity KIND without echoing the value', () => {
      const result = PiiVerifier.assertClean(`PAN: ${SYNTHETIC.PAN}`);
      if (!result.ok) {
        expect(result.error.message).not.toContain(SYNTHETIC.PAN);
        expectNoPii(result.error.message);
      }
    });

    it('scans for every PII kind', () => {
      const kinds = PiiVerifier.scan(
        `${SYNTHETIC.PAN} ${SYNTHETIC.AADHAAR_PLAIN} ${SYNTHETIC.EMAIL}`,
      );
      expect(kinds).toEqual(expect.arrayContaining(['PAN', 'AADHAAR', 'CONTACT']));
    });

    it('never warns-and-continues — a leak is a hard failure', () => {
      expect(PiiVerifier.assertClean(`PAN: ${SYNTHETIC.PAN}`).ok).toBe(false);
    });
  });
});

describe('US-7.5 deterministic pseudonymisation', () => {
  // Token numbering is per session, so each scenario starts from a clean map.
  beforeEach(() => {
    Pseudonymiser.reset();
  });

  describe('Scenario: The same entity maps to the same token within one session', () => {
    const text = `${SYNTHETIC.PERSON} lent to ${SYNTHETIC.PERSON_2}; ${SYNTHETIC.PERSON} again; ${SYNTHETIC.PERSON} once more`;

    it('assigns one stable token to the repeated person', () => {
      const { masked } = Pseudonymiser.tokenise(text, EntityDetector.detectEntities(text));
      expect(masked.match(/\[REDACTED_NAME_1\]/g)).toHaveLength(3);
    });

    it('assigns a different token to a different person', () => {
      const { masked } = Pseudonymiser.tokenise(text, EntityDetector.detectEntities(text));
      expect(masked).toContain('[REDACTED_NAME_2]');
    });
  });

  describe('Scenario: The reversal map never leaves the device', () => {
    it('is not part of the masked output', () => {
      const text = `Loan to ${SYNTHETIC.PERSON}`;
      const { masked } = Pseudonymiser.tokenise(text, EntityDetector.detectEntities(text));
      expect(masked).not.toContain(SYNTHETIC.PERSON);
    });

    it('rehydrates locally back to the original text', () => {
      const text = `Loan to ${SYNTHETIC.PERSON}`;
      const { masked } = Pseudonymiser.tokenise(text, EntityDetector.detectEntities(text));
      expect(Pseudonymiser.rehydrate(masked)).toBe(text);
    });
  });
});

describe('ADR-007 limits of the fail-closed guard, stated explicitly', () => {
  /**
   * The plan originally claimed the egress guard was the backstop for NER false
   * negatives (risk R5). It is not, and cannot be: a PAN has a shape the guard can
   * recognise, a name does not. These tests pin what the guard genuinely does and
   * does not protect, so nobody re-derives the wrong assurance from a green suite.
   */
  it('catches a structured identifier the pipeline failed to mask', () => {
    expect(PiiVerifier.assertClean(`leaked ${SYNTHETIC.PAN}`).ok).toBe(false);
  });

  it('catches a name the pipeline failed to mask, by re-running detection', () => {
    // Guards against a broken pipeline — not against a detector blind spot.
    expect(PiiVerifier.assertClean(`Analyze for ${SYNTHETIC.PERSON}`).ok).toBe(false);
  });

  it('cannot catch a name the detector never recognises', () => {
    // A single lowercase token is indistinguishable from an ordinary word. The
    // guard passes it, which is precisely why the detector over-masks by default
    // and why structured payloads are masked by field semantics instead.
    expect(PiiVerifier.assertClean('analyze for rajesh').ok).toBe(true);
  });

  it('over-masks an unknown proper noun rather than risk a leak', () => {
    expect(NerMasker.maskPersonNames('Payment to Anantharaman').masked).toContain(
      '[REDACTED_NAME]',
    );
  });

  it('still preserves tickers, so over-masking does not destroy the prompt', () => {
    const { masked } = NerMasker.maskPersonNames('holding TCS and INFY');
    expect(masked).toContain('TCS');
    expect(masked).toContain('INFY');
  });
});
