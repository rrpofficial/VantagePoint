/**
 * EgressGateway — the ONLY outbound socket in the process (US-8.10, ADR-010).
 *
 * Default-deny. A request must match the allow-list for its declared purpose, and
 * the whole gateway must be explicitly enabled, before anything leaves the machine.
 * Every dispatch is recorded locally whether it succeeded or was refused, so
 * "what did this app send?" is answerable without trusting the caller.
 *
 * The transport is injected rather than calling `fetch` directly: that keeps this
 * package testable without a network and makes the single choke point enforceable
 * by the static guard test in tests/functional/privacy/.
 */
import {
  EgressDeniedError,
  Err,
  Ok,
  type EgressAuditEntry,
  type EgressRequest,
  type IsoDateTime,
  type Result,
} from '@vantagepoint/shared-kernel';

export interface EgressPolicy {
  /** Master switch. `deny` (the default) refuses everything. */
  readonly mode: 'deny' | 'allow';
  /** Permitted hostnames per purpose. Exact host match; no wildcards. */
  readonly allowList: Readonly<Partial<Record<EgressRequest['purpose'], readonly string[]>>>;
}

export type Transport = (request: EgressRequest) => Promise<string>;

export interface EgressGatewayOptions {
  readonly policy: EgressPolicy;
  readonly transport: Transport;
  readonly now: () => IsoDateTime;
  /** Optional final gate, e.g. the PII verifier for AI payloads (ADR-007). */
  readonly beforeDispatch?: (request: EgressRequest) => Result<void>;
}

export const DENY_ALL: EgressPolicy = { mode: 'deny', allowList: {} };

export interface EgressGatewayInstance {
  dispatch(request: EgressRequest): Promise<Result<string>>;
  auditLog(): readonly EgressAuditEntry[];
}

export function createEgressGateway(options: EgressGatewayOptions): EgressGatewayInstance {
  const audit: EgressAuditEntry[] = [];

  const record = (request: EgressRequest, outcome: string): void => {
    audit.push({
      destination: safeHost(request.url) ?? request.url,
      purpose: `${request.purpose}:${outcome}`,
      timestamp: options.now(),
      payloadBytes: request.body ? Buffer.byteLength(request.body, 'utf8') : 0,
    });
  };

  return {
    async dispatch(request) {
      if (options.policy.mode !== 'allow') {
        record(request, 'DENIED_POLICY');
        return Err(
          new EgressDeniedError('outbound network access is disabled; enable the egress profile'),
        );
      }

      const host = safeHost(request.url);
      if (host === undefined) {
        record(request, 'DENIED_MALFORMED');
        return Err(new EgressDeniedError('destination is not a valid absolute URL'));
      }

      const permitted = options.policy.allowList[request.purpose] ?? [];
      if (!permitted.includes(host)) {
        record(request, 'DENIED_NOT_ALLOWLISTED');
        return Err(
          new EgressDeniedError(`host "${host}" is not allow-listed for purpose ${request.purpose}`),
        );
      }

      // Fail-closed final gate (e.g. residual-PII scan for AI payloads).
      const gate = options.beforeDispatch?.(request);
      if (gate && !gate.ok) {
        record(request, 'DENIED_GUARD');
        return Err(gate.error);
      }

      record(request, 'DISPATCHED');
      return Ok(await options.transport(request));
    },

    auditLog: () => [...audit],
  };
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** Convenience default: a gateway that refuses everything. */
export const EgressGateway = {
  denyAll: (now: () => IsoDateTime): EgressGatewayInstance =>
    createEgressGateway({
      policy: DENY_ALL,
      transport: () => Promise.reject(new Error('no transport configured')),
      now,
    }),
  create: createEgressGateway,
};
