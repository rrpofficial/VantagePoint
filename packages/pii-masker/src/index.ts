/**
 * pii-masker — zero-trust anonymisation. Runs in the BROWSER bundle (ADR-013).
 * The API imports only {@link PiiVerifier}, never {@link MaskingPipeline}.
 */
import type { Result } from '@vantagepoint/shared-kernel';
import { detect, mask } from './regex-rules.js';
import { detectEntities, maskPayload, maskText } from './pipeline.js';
import { maskPersonNames } from './ner.js';
import { sessionPseudonymiser } from './pseudonymiser.js';
import { assertClean, scan } from './verifier.js';

export * from './types.js';
import type { DetectedEntity, MaskResult, PiiKind } from './types.js';

export interface RegexRulesOps {
  mask(text: string): MaskResult;
  detect(text: string): readonly DetectedEntity[];
}

export interface NerMaskerOps {
  /** Local, offline named-entity recognition. Persons masked, organisations preserved. */
  maskPersonNames(text: string): MaskResult;
}

export interface PseudonymiserOps {
  /** Stable within a session: same entity → same numbered token. */
  tokenise(text: string, entities: readonly DetectedEntity[]): MaskResult;
  reversalMap(): ReadonlyMap<string, string>;
  rehydrate(text: string): string;
  reset(): void;
}

export interface MaskingPipelineOps {
  maskText(text: string): string;
  /** Recursively masks every PII-bearing field at every nesting level. */
  maskPayload<T>(payload: T): T;
}

export interface PiiVerifierOps {
  /** Fail-closed (ADR-007): throws PiiLeakError on any residual PII. */
  assertClean(payload: string): Result<void>;
  scan(payload: string): readonly PiiKind[];
}

export const RegexRules: RegexRulesOps = { mask, detect };
export const EntityDetector = { detectEntities };
export const NerMasker: NerMaskerOps = { maskPersonNames };
export const Pseudonymiser: PseudonymiserOps = {
  tokenise: (text, entities) => sessionPseudonymiser.tokenise(text, entities),
  reversalMap: () => sessionPseudonymiser.reversalMap(),
  rehydrate: (text) => sessionPseudonymiser.rehydrate(text),
  reset: () => { sessionPseudonymiser.reset(); },
};
export const MaskingPipeline: MaskingPipelineOps = { maskText, maskPayload };
export const PiiVerifier: PiiVerifierOps = { assertClean, scan };
