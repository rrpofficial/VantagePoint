/**
 * HTTP routes (US-8.11).
 *
 * Every handler delegates to `app-services` and does nothing else — no
 * calculation, no rule, no interpretation. A functional test asserts that no
 * file in this directory imports a domain package, so the boundary is enforced
 * rather than merely intended.
 *
 * ADR-013: the PII *verifier* may be imported here, the masking pipeline may not.
 * Masking happens in the browser; relaying an unmasked payload is exactly what
 * this layer must be incapable of.
 */
import type { FastifyInstance } from 'fastify';
import {
  AuditUC,
  ChitUC,
  type ChitQuery,
  CompareSnapshotsUC,
  ComputeAdvanceTaxUC,
  EditModeUC,
  GenerateComplianceUC,
  GenerateSnapshotUC,
  ImportStatementUC,
  LedgerUC,
  ListSnapshotsUC,
  LoanUC,
  type LoanQuery,
  ReferenceUC,
  TemplateUC,
  TradeUC,
  ValuePortfolioUC,
  VaultUC,
  enabledInclusionLabels,
  hasIncomeProfile,
  incomeInclusionsOf,
  incomeProfileOf,
  saveIncomeInclusions,
  saveIncomeProfile,
} from '@porttrack/app-services';
import { PiiVerifier } from '@porttrack/pii-masker';
import { DuplicateLoanError, DuplicateTradeError } from '@porttrack/shared-kernel';

interface UnlockBody {
  readonly passphrase?: string;
}

const failure = (code: string, message: string) => ({ error: { code, message } });

/**
 * A refused change gets 403, everything else keeps the route's own status.
 *
 * The distinction is what lets the SPA respond usefully. 422 says "you typed
 * something wrong" and sends the user back to the form; 403 says "the request
 * was fine, the mode is off" and sends them to Settings. Answering 422 for a
 * gated call would have them re-check a field that was never the problem.
 */
const refusal = (
  error: { readonly code: string; readonly message: string },
  fallbackStatus: number,
): { status: number; body: ReturnType<typeof failure> } => ({
  status: error.code === 'EDIT_MODE_REQUIRED' ? 403 : fallbackStatus,
  body: failure(error.code, error.message),
});

export function registerRoutes(app: FastifyInstance): void {
  /* ------------------------------------------------------------- health */

  // Liveness answers "is the process up?" and gates container restarts.
  app.get('/api/health/live', () => ({ status: 'ok' }));

  // Readiness answers "can it serve?" — a locked vault is up but not usable,
  // and conflating the two would have the orchestrator restart a healthy process.
  app.get('/api/health/ready', (_request, reply) => {
    if (!VaultUC.isUnlocked()) {
      return reply.code(503).send({ status: 'unavailable', reason: 'VAULT_LOCKED' });
    }
    return reply.send({ status: 'ok' });
  });

  /* -------------------------------------------------------------- vault */

  app.post<{ Body: UnlockBody }>('/api/vault/unlock', async (request, reply) => {
    const passphrase = request.body.passphrase ?? '';
    const result = await VaultUC.unlock(passphrase);
    if (!result.ok) {
      // The passphrase never appears in the response, logged or otherwise.
      return reply.code(401).send(failure(result.error.code, 'unable to unlock vault'));
    }
    return reply.send({ unlocked: true });
  });

  app.post('/api/vault/lock', async (_request, reply) => {
    await VaultUC.lock();
    return reply.send({ unlocked: false });
  });

  /* ---------------------------------------------------------- edit mode */

  app.get('/api/edit-mode', (_request, reply) => reply.send(EditModeUC.state()));

  app.post<{ Body: UnlockBody }>('/api/edit-mode/enable', async (request, reply) => {
    const result = await EditModeUC.enable(request.body.passphrase ?? '');
    // 401, not 403: the passphrase supplied here is the credential, so a wrong
    // one is a failed authentication rather than a refused permission.
    return result.ok
      ? reply.send(result.value)
      : reply.code(401).send(failure(result.error.code, 'unable to enable edit mode'));
  });

  app.post('/api/edit-mode/disable', (_request, reply) => reply.send(EditModeUC.disable()));

  /* ---------------------------------------------------------- portfolio */

  app.get('/api/portfolio/valuation', async (request, reply) => {
    const asOf = (request.query as { asOf?: string }).asOf ?? new Date().toISOString();
    const result = await ValuePortfolioUC.execute(asOf);
    return result.ok
      ? reply.send(result.value)
      : reply.code(409).send(failure(result.error.code, result.error.message));
  });

  /* ------------------------------------------------------------- ledger */

  app.get('/api/ledger/assets', async (_request, reply) => {
    const [assets, liabilities, exits] = await Promise.all([
      LedgerUC.assets(),
      LedgerUC.liabilities(),
      LedgerUC.exits(),
    ]);
    return reply.send({ assets, liabilities, exits });
  });

  app.delete<{ Params: { id: string } }>('/api/ledger/assets/:id', async (request, reply) => {
    const result = await LedgerUC.deleteAsset(request.params.id);
    if (result.ok) return reply.send({ deleted: true });
    const { status, body } = refusal(result.error, 422);
    return reply.code(status).send(body);
  });

  app.delete<{ Params: { id: string } }>('/api/ledger/exits/:id', async (request, reply) => {
    const result = await LedgerUC.deleteExit(request.params.id);
    if (result.ok) return reply.send({ deleted: true });
    const { status, body } = refusal(result.error, 422);
    return reply.code(status).send(body);
  });

  /* --------------------------------------------------------- chit funds */

  app.get('/api/chits', async (request, reply) => {
    const raw = request.query as {
      status?: string;
      org?: string;
      sortBy?: string;
      direction?: string;
      asOf?: string;
    };
    const list = (value: string | undefined) =>
      value === undefined || value.length === 0 ? undefined : value.split(',').filter(Boolean);

    const statuses = list(raw.status) as ChitQuery['statuses'];
    const orgs = list(raw.org);

    const result = await ChitUC.register({
      ...(statuses === undefined ? {} : { statuses }),
      ...(orgs === undefined ? {} : { orgs }),
      ...(raw.sortBy === undefined ? {} : { sortBy: raw.sortBy as ChitQuery['sortBy'] }),
      ...(raw.direction === undefined
        ? {}
        : { direction: raw.direction as ChitQuery['direction'] }),
      ...(raw.asOf === undefined ? {} : { asOf: raw.asOf }),
    });
    return result.ok
      ? reply.send(result.value)
      : reply.code(409).send(failure(result.error.code, result.error.message));
  });

  app.post('/api/chits', async (request, reply) => {
    const body = request.body as {
      org?: string;
      label?: string;
      targetAmount?: { amount?: string; currency?: string };
      startDate?: string;
      endDate?: string;
      // A form posts this as text; typing it `number` would be a claim about
      // the wire that nothing enforces.
      durationMonths?: number | string;
      emiType?: string;
      scheduleLabel?: string;
      comments?: string;
    };

    const result = await ChitUC.open({
      org: body.org ?? '',
      label: body.label ?? '',
      targetAmount: {
        amount: body.targetAmount?.amount ?? '0',
        currency: (body.targetAmount?.currency ?? 'INR') as 'INR',
      },
      startDate: body.startDate ?? '',
      durationMonths: Number(body.durationMonths ?? 0),
      emiType: body.emiType === 'VARYING' ? 'VARYING' : 'CONSTANT',
      ...(body.endDate === undefined ? {} : { endDate: body.endDate }),
      ...(body.scheduleLabel === undefined ? {} : { scheduleLabel: body.scheduleLabel }),
      ...(body.comments === undefined ? {} : { comments: body.comments }),
    });
    return result.ok
      ? reply.code(201).send({ chitId: result.value })
      : reply.code(422).send(failure(result.error.code, result.error.message));
  });

  app.put<{ Params: { id: string } }>('/api/chits/:id', async (request, reply) => {
    const body = request.body as {
      org?: string;
      label?: string;
      targetAmount?: { amount?: string; currency?: string };
      startDate?: string;
      endDate?: string;
      durationMonths?: number | string;
      emiType?: string;
      scheduleLabel?: string | null;
      comments?: string;
    };

    const result = await ChitUC.edit(request.params.id, {
      ...(body.org === undefined ? {} : { org: body.org }),
      ...(body.label === undefined ? {} : { label: body.label }),
      ...(body.targetAmount?.amount === undefined
        ? {}
        : {
            targetAmount: {
              amount: body.targetAmount.amount,
              currency: (body.targetAmount.currency ?? 'INR') as 'INR',
            },
          }),
      ...(body.startDate === undefined ? {} : { startDate: body.startDate }),
      ...(body.endDate === undefined ? {} : { endDate: body.endDate }),
      ...(body.durationMonths === undefined
        ? {}
        : { durationMonths: Number(body.durationMonths) }),
      ...(body.emiType === undefined
        ? {}
        : { emiType: body.emiType === 'VARYING' ? ('VARYING' as const) : ('CONSTANT' as const) }),
      ...(body.scheduleLabel === undefined ? {} : { scheduleLabel: body.scheduleLabel }),
      ...(body.comments === undefined ? {} : { comments: body.comments }),
    });
    if (result.ok) return reply.send({ updated: true });
    const { status, body: failed } = refusal(result.error, 422);
    return reply.code(status).send(failed);
  });

  app.delete<{ Params: { id: string } }>('/api/chits/:id', async (request, reply) => {
    const result = await ChitUC.delete(request.params.id);
    if (result.ok) return reply.send({ deleted: true });
    const { status, body } = refusal(result.error, 422);
    return reply.code(status).send(body);
  });

  app.post<{ Params: { id: string } }>('/api/chits/:id/emis', async (request, reply) => {
    const body = request.body as {
      date?: string;
      amount?: { amount?: string; currency?: string };
      mode?: string;
      paidTo?: string;
      comments?: string;
    };

    const result = await ChitUC.recordEmi({
      chitId: request.params.id,
      date: body.date ?? '',
      amount: {
        amount: body.amount?.amount ?? '0',
        currency: (body.amount?.currency ?? 'INR') as 'INR',
      },
      mode: (body.mode ?? 'OTHER') as Parameters<typeof ChitUC.recordEmi>[0]['mode'],
      paidTo: body.paidTo ?? '',
      ...(body.comments === undefined ? {} : { comments: body.comments }),
    });
    return result.ok
      ? reply.code(201).send({ recorded: true })
      : reply.code(422).send(failure(result.error.code, result.error.message));
  });

  app.post<{ Params: { id: string } }>('/api/chits/:id/status', async (request, reply) => {
    const body = request.body as {
      status?: string;
      date?: string;
      amount?: { amount?: string; currency?: string };
    };

    // Withdrawing carries the date and the amount actually received; going back
    // to active clears both, because a draw recorded in error left no money.
    const result =
      body.status === 'WITHDRAWN'
        ? await ChitUC.withdraw(request.params.id, {
            date: body.date ?? '',
            amount: {
              amount: body.amount?.amount ?? '0',
              currency: (body.amount?.currency ?? 'INR') as 'INR',
            },
          })
        : await ChitUC.setStatus(request.params.id, 'ACTIVE');

    if (result.ok) return reply.send({ updated: true });
    const { status, body: failed } = refusal(result.error, 422);
    return reply.code(status).send(failed);
  });

  app.get('/api/chits/schedules', async (_request, reply) => {
    const result = await ChitUC.schedules();
    return result.ok
      ? reply.send({ schedules: result.value })
      : reply.code(409).send(failure(result.error.code, result.error.message));
  });

  app.post('/api/chits/schedules', async (request, reply) => {
    const body = request.body as {
      label?: string;
      rows?: readonly { month?: number | string; amount?: { amount?: string; currency?: string } }[];
    };

    const result = await ChitUC.saveSchedule({
      label: body.label ?? '',
      rows: (body.rows ?? []).map((row) => ({
        month: Number(row.month ?? 0),
        amount: {
          amount: row.amount?.amount ?? '0',
          currency: (row.amount?.currency ?? 'INR') as 'INR',
        },
      })),
    });
    if (result.ok) return reply.code(201).send({ saved: true });
    const { status, body: failed } = refusal(result.error, 422);
    return reply.code(status).send(failed);
  });

  app.delete<{ Params: { label: string } }>(
    '/api/chits/schedules/:label',
    async (request, reply) => {
      const result = await ChitUC.deleteSchedule(request.params.label);
      if (result.ok) return reply.send({ deleted: true });
      const { status, body } = refusal(result.error, 422);
      return reply.code(status).send(body);
    },
  );

  /*
   * Does the imported history account for what the broker says is held?
   *
   * Its own route rather than a field on the ledger: it answers a question about
   * COMPLETENESS, and folding it into the holdings payload would let a screen
   * render the positions while ignoring the warning that they are short.
   */
  app.get('/api/ledger/reconciliation', async (_request, reply) =>
    reply.send(await LedgerUC.reconciliation()),
  );

  /* ------------------------------------------------------------- trades */

  app.get('/api/trades/classes', async (_request, reply) => {
    const result = await TradeUC.classes();
    return result.ok
      ? reply.send({ classes: result.value })
      : reply.code(409).send(failure(result.error.code, result.error.message));
  });

  app.post('/api/trades', async (request, reply) => {
    const body = request.body as {
      assetClass?: string;
      side?: string;
      tradeDate?: string;
      symbol?: string;
      isin?: string;
      folioRef?: string;
      schemeName?: string;
      quantity?: string;
      pricePerUnit?: { amount?: string; currency?: string };
      fees?: { amount?: string; currency?: string };
      otherCharges?: { amount?: string; currency?: string };
      schemeCategory?: string;
      confirmDuplicate?: boolean;
    };

    const currency = (body.pricePerUnit?.currency ?? 'INR') as 'INR';
    const result = await TradeUC.record({
      assetClass: body.assetClass ?? '',
      side: body.side === 'SELL' ? 'SELL' : 'BUY',
      tradeDate: body.tradeDate ?? '',
      quantity: body.quantity ?? '0',
      pricePerUnit: { amount: body.pricePerUnit?.amount ?? '0', currency },
      ...(body.symbol === undefined ? {} : { symbol: body.symbol }),
      ...(body.isin === undefined ? {} : { isin: body.isin }),
      ...(body.folioRef === undefined ? {} : { folioRef: body.folioRef }),
      ...(body.schemeName === undefined ? {} : { schemeName: body.schemeName }),
      ...(body.fees?.amount === undefined ? {} : { fees: { amount: body.fees.amount, currency } }),
      ...(body.otherCharges?.amount === undefined
        ? {}
        : { otherCharges: { amount: body.otherCharges.amount, currency } }),
      ...(body.schemeCategory === undefined ? {} : { schemeCategory: body.schemeCategory }),
      ...(body.confirmDuplicate === undefined ? {} : { confirmDuplicate: body.confirmDuplicate }),
    });

    if (result.ok) return reply.code(201).send(result.value);

    // 409 for the same reason a duplicate loan is: the payload is well formed,
    // and re-sending it with `confirmDuplicate` succeeds.
    if (result.error instanceof DuplicateTradeError) {
      return reply.code(409).send({
        error: {
          code: result.error.code,
          message: result.error.message,
          duplicates: result.error.identifiers,
        },
      });
    }
    return reply.code(422).send(failure(result.error.code, result.error.message));
  });

  /* -------------------------------------------------------------- loans */

  const loanQuery = (query: unknown): LoanQuery => {
    const raw = query as {
      status?: string;
      borrower?: string;
      sortBy?: string;
      direction?: string;
      asOf?: string;
    };
    // Comma-separated, because several statuses and several borrowers can be
    // selected at once (requirement 4).
    const list = (value: string | undefined) =>
      value === undefined || value.length === 0 ? undefined : value.split(',').filter(Boolean);

    const statuses = list(raw.status) as LoanQuery['statuses'];
    const borrowers = list(raw.borrower);

    return {
      ...(statuses === undefined ? {} : { statuses }),
      ...(borrowers === undefined ? {} : { borrowers }),
      ...(raw.sortBy === undefined ? {} : { sortBy: raw.sortBy as LoanQuery['sortBy'] }),
      ...(raw.direction === undefined
        ? {}
        : { direction: raw.direction as LoanQuery['direction'] }),
      ...(raw.asOf === undefined ? {} : { asOf: raw.asOf }),
    };
  };

  app.get('/api/loans', async (request, reply) => {
    const result = await LoanUC.register(loanQuery(request.query));
    return result.ok
      ? reply.send(result.value)
      : reply.code(409).send(failure(result.error.code, result.error.message));
  });

  app.post('/api/loans', async (request, reply) => {
    const body = request.body as {
      borrowerName?: string;
      principal?: { amount?: string; currency?: string };
      interestRatePct?: string;
      loanDate?: string;
      notes?: string;
      confirmDuplicate?: boolean;
    };

    const result = await LoanUC.record({
      borrowerName: body.borrowerName ?? '',
      principal: {
        amount: body.principal?.amount ?? '0',
        currency: (body.principal?.currency ?? 'INR') as 'INR',
      },
      interestRatePct: body.interestRatePct ?? '0',
      loanDate: body.loanDate ?? '',
      ...(body.notes === undefined ? {} : { notes: body.notes }),
      ...(body.confirmDuplicate === undefined ? {} : { confirmDuplicate: body.confirmDuplicate }),
    });

    if (result.ok) return reply.code(201).send({ loanId: result.value });

    /*
     * 409, not 422. The request is well formed and the server is refusing only
     * until the lender answers a question — re-sending it verbatim with
     * `confirmDuplicate` succeeds. A 422 would tell the client the payload was
     * wrong, which it is not.
     */
    if (result.error instanceof DuplicateLoanError) {
      return reply.code(409).send({
        error: {
          code: result.error.code,
          message: result.error.message,
          duplicates: result.error.loanIds,
        },
      });
    }
    return reply.code(422).send(failure(result.error.code, result.error.message));
  });

  app.put<{ Params: { id: string } }>('/api/loans/:id', async (request, reply) => {
    const body = request.body as {
      borrowerName?: string;
      principalAmount?: string;
      interestRatePct?: string;
      loanDate?: string;
      notes?: string;
      closedDate?: string | null;
      reason?: string;
    };

    const result = await LoanUC.edit(
      request.params.id,
      {
        ...(body.borrowerName === undefined ? {} : { borrowerName: body.borrowerName }),
        ...(body.principalAmount === undefined ? {} : { principalAmount: body.principalAmount }),
        ...(body.interestRatePct === undefined ? {} : { interestRatePct: body.interestRatePct }),
        ...(body.loanDate === undefined ? {} : { loanDate: body.loanDate }),
        ...(body.notes === undefined ? {} : { notes: body.notes }),
        ...(body.closedDate === undefined ? {} : { closedDate: body.closedDate }),
      },
      body.reason === undefined ? {} : { reason: body.reason },
    );

    if (result.ok) return reply.send({ changed: result.value.length, entries: result.value });
    const { status, body: failed } = refusal(result.error, 422);
    return reply.code(status).send(failed);
  });

  app.delete<{ Params: { id: string } }>('/api/loans/:id', async (request, reply) => {
    const reason = (request.body as { reason?: string } | undefined)?.reason;
    const result = await LoanUC.delete(
      request.params.id,
      reason === undefined ? {} : { reason },
    );
    if (result.ok) return reply.send({ deleted: true });
    const { status, body } = refusal(result.error, 422);
    return reply.code(status).send(body);
  });

  app.get<{ Params: { id: string } }>('/api/loans/:id/audit', async (request, reply) => {
    const result = await LoanUC.auditFor(request.params.id);
    return result.ok
      ? reply.send({ entries: result.value })
      : reply.code(409).send(failure(result.error.code, result.error.message));
  });

  const paymentBody = (id: string, body: unknown) => {
    const raw = body as {
      date?: string;
      amount?: { amount?: string; currency?: string };
      mode?: string;
      notes?: string;
    };
    return {
      loanId: id,
      date: raw.date ?? '',
      amount: {
        amount: raw.amount?.amount ?? '0',
        currency: (raw.amount?.currency ?? 'INR') as 'INR',
      },
      mode: (raw.mode ?? 'OTHER') as Parameters<typeof LoanUC.recordInterestPayment>[0]['mode'],
      ...(raw.notes === undefined ? {} : { notes: raw.notes }),
    };
  };

  // Two routes, not one with a `type` flag: an interest payment that reduced
  // the principal would silently write off money owed, and a single endpoint
  // makes that a one-character mistake.
  app.post<{ Params: { id: string } }>(
    '/api/loans/:id/interest-payments',
    async (request, reply) => {
      const result = await LoanUC.recordInterestPayment(
        paymentBody(request.params.id, request.body),
      );
      return result.ok
        ? reply.code(201).send({ recorded: true })
        : reply.code(422).send(failure(result.error.code, result.error.message));
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/loans/:id/principal-repayments',
    async (request, reply) => {
      const result = await LoanUC.recordPrincipalRepayment(
        paymentBody(request.params.id, request.body),
      );
      return result.ok
        ? reply.code(201).send({ recorded: true })
        : reply.code(422).send(failure(result.error.code, result.error.message));
    },
  );

  app.get('/api/loans/export.csv', async (request, reply) => {
    const result = await LoanUC.exportCsv(loanQuery(request.query));
    return result.ok
      ? reply
          .header('content-type', 'text/csv; charset=utf-8')
          .header('content-disposition', 'attachment; filename="hand-loans.csv"')
          .send(result.value)
      : reply.code(409).send(failure(result.error.code, result.error.message));
  });

  app.get('/api/loans/export.pdf', async (request, reply) => {
    const result = await LoanUC.exportPdf(loanQuery(request.query));
    return result.ok
      ? reply
          .header('content-type', 'application/pdf')
          .header('content-disposition', 'attachment; filename="hand-loans.pdf"')
          .send(Buffer.from(result.value))
      : reply.code(409).send(failure(result.error.code, result.error.message));
  });

  /* ---------------------------------------------------------- snapshots */

  app.get('/api/snapshots', async (_request, reply) =>
    reply.send({ snapshots: await ListSnapshotsUC.execute() }),
  );

  app.post('/api/snapshots', async (request, reply) => {
    const asOf = (request.body as { asOf?: string } | undefined)?.asOf;
    const result =
      asOf === undefined
        ? await GenerateSnapshotUC.runScheduler(new Date().toISOString())
        : await GenerateSnapshotUC.custom(asOf);
    return result.ok
      ? reply.code(201).send(result.value)
      : reply.code(409).send(failure(result.error.code, result.error.message));
  });

  app.get<{ Params: { id: string } }>('/api/snapshots/:id/compare', async (request, reply) => {
    const target = (request.query as { target?: string }).target ?? 'live';
    const result =
      target === 'live'
        ? await CompareSnapshotsUC.snapshotToLive(request.params.id, new Date().toISOString())
        : await CompareSnapshotsUC.snapshotToSnapshot(request.params.id, target);
    return result.ok
      ? reply.send(result.value)
      : // 409, not 404: the request was routable and understood, the referenced
        // snapshot simply does not exist. Returning 404 would be ambiguous with
        // an unregistered route, for clients and for our own tests alike.
        reply.code(409).send(failure(result.error.code, result.error.message));
  });

  /* ---------------------------------------------------------- reference */

  // Ungated like the templates: which financial year it is does not depend on
  // anyone's vault, and the UI needs it to render its year pickers before unlock.
  app.get('/api/reference/periods', (_request, reply) => reply.send(ReferenceUC.periods()));

  /* ---------------------------------------------------------- templates */

  // Not gated on the vault: a user needs the blank template BEFORE they have
  // anything to put in it, and these files contain no data of theirs.
  app.get('/api/templates', (_request, reply) =>
    reply.send({ templates: TemplateUC.list() }),
  );

  app.get<{ Params: { name: string } }>('/api/templates/:name', (request, reply) => {
    // Both `Custom_Cash` and `Custom_Cash.csv` resolve: the download link uses
    // the bare name, but a user who types or shares the URL will include the
    // extension they saw on the file.
    const name = request.params.name.replace(/\.csv$/i, '');
    const csv = TemplateUC.generate(name);
    if (csv.length === 0) {
      return reply.code(404).send(failure('UNKNOWN_TEMPLATE', 'no such template'));
    }
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${name}.csv"`)
      .send(csv);
  });

  /* ------------------------------------------------------------ imports */

  app.post('/api/imports', async (request, reply) => {
    const body = request.body as
      | {
          file?: string;
          fileName?: string;
          parser?: string;
          mode?: string;
          password?: string;
          templateName?: string;
        }
      | undefined;

    const result = await ImportStatementUC.execute({
      file: Buffer.from(body?.file ?? '', 'base64'),
      fileName: body?.fileName ?? 'upload',
      parser: (body?.parser ?? 'TEMPLATE') as Parameters<typeof ImportStatementUC.execute>[0]['parser'],
      mode: (body?.mode ?? 'STRICT') as 'STRICT' | 'LENIENT',
      ...(body?.password === undefined ? {} : { password: body.password }),
      ...(body?.templateName === undefined || body.templateName.length === 0
        ? {}
        : { templateName: body.templateName }),
    });
    return result.ok
      ? reply.send(result.value)
      : reply.code(422).send(failure(result.error.code, result.error.message));
  });

  /* ---------------------------------------------------------------- tax */

  app.get('/api/tax/advance', async (request, reply) => {
    const query = request.query as { fy?: string; quarter?: string };
    const result = await ComputeAdvanceTaxUC.execute({
      financialYear: query.fy ?? '2025-26',
      quarter: (query.quarter ?? 'Q1') as 'Q1' | 'Q2' | 'Q3' | 'Q4',
    });
    return result.ok
      ? reply.send(result.value)
      : reply.code(409).send(failure(result.error.code, result.error.message));
  });

  app.get('/api/tax/regimes', async (request, reply) => {
    const fy = (request.query as { fy?: string }).fy ?? '2025-26';
    const result = await ComputeAdvanceTaxUC.compareRegimes(fy);
    return result.ok
      ? reply.send({ ...result.value, hasIncomeProfile: hasIncomeProfile() })
      : reply.code(409).send(failure(result.error.code, result.error.message));
  });

  app.get('/api/tax/income-profile', (_request, reply) =>
    // `present` is reported separately: a nil tax figure computed from a missing
    // Form 16 must not read as a computed answer of zero.
    reply.send({ present: hasIncomeProfile(), profile: incomeProfileOf() ?? null }),
  );

  app.post('/api/tax/income-profile', async (request, reply) => {
    const body = request.body as { profile?: unknown } | undefined;
    if (body?.profile === undefined || body.profile === null) {
      return reply.code(422).send(failure('INVALID_BODY', 'an income profile is required'));
    }
    const saved = await saveIncomeProfile(body.profile as Parameters<typeof saveIncomeProfile>[0]);
    if (saved.ok) return reply.send({ present: true });
    const { status, body: failed } = refusal(saved.error, 409);
    return reply.code(status).send(failed);
  });

  /*
   * Which ledger-derived receipts count as income. Both off by default; see the
   * note in `app-services/income-inclusions.ts` for why the product declines to
   * take that position on the user's behalf.
   */
  app.get('/api/tax/income-inclusions', (_request, reply) =>
    reply.send({
      inclusions: incomeInclusionsOf(),
      // Sent rather than derived in the browser, so the words beside a tax
      // figure and the flags that produced it cannot disagree.
      enabled: enabledInclusionLabels(),
    }),
  );

  app.put('/api/tax/income-inclusions', async (request, reply) => {
    const body = request.body as
      | { handLoanInterest?: unknown; chitFundReturns?: unknown; sellToCoverGains?: unknown }
      | undefined;

    // Absent means false, never "leave as it was": this is a PUT of the whole
    // position, and a partial body that silently kept a flag on would be the one
    // way to enable something without asking for it.
    const saved = await saveIncomeInclusions({
      handLoanInterest: body?.handLoanInterest === true,
      chitFundReturns: body?.chitFundReturns === true,
      sellToCoverGains: body?.sellToCoverGains === true,
    });
    if (saved.ok) {
      return reply.send({
        inclusions: incomeInclusionsOf(),
        enabled: enabledInclusionLabels(),
      });
    }
    const { status, body: failed } = refusal(saved.error, 409);
    return reply.code(status).send(failed);
  });

  /* --------------------------------------------------------- compliance */

  app.get('/api/compliance/schedule-fa', async (request, reply) => {
    const query = request.query as { cy?: string };
    // CALENDAR year — Schedule FA runs 1 Jan to 31 Dec, unlike everything else.
    const calendarYear = Number(query.cy ?? new Date().getUTCFullYear() - 1);
    const [a3, d] = await Promise.all([
      GenerateComplianceUC.scheduleFaA3(calendarYear),
      GenerateComplianceUC.scheduleFaD(calendarYear),
    ]);
    return reply.send({
      calendarYear,
      tableA3: a3.ok ? a3.value : null,
      tableA3Error: a3.ok ? null : { code: a3.error.code, message: a3.error.message },
      tableD: d.ok ? d.value : null,
      tableDError: d.ok ? null : { code: d.error.code, message: d.error.message },
    });
  });

  app.get('/api/compliance/schedule-al', async (request, reply) => {
    const fy = (request.query as { fy?: string }).fy ?? '2025-26';
    const result = await GenerateComplianceUC.scheduleAl(fy);
    return result.ok
      ? reply.send(result.value)
      : reply.code(409).send(failure(result.error.code, result.error.message));
  });

  /* -------------------------------------------------------------- audit */

  app.get('/api/audit/egress', async () => ({ entries: await AuditUC.egressLog() }));

  app.get('/api/audit/log', async () => ({ lines: await AuditUC.applicationLog() }));

  /* ---------------------------------------------------------------- ai */

  app.post('/api/ai/analyze', async (request, reply) => {
    const payload = (request.body as { payload?: string } | undefined)?.payload ?? '';
    // Second, independent gate (ADR-007). The browser masks; this refuses to
    // relay anything that still carries PII, so a bug in the SPA is not enough.
    const clean = PiiVerifier.assertClean(payload);
    if (!clean.ok) {
      return reply.code(422).send(failure(clean.error.code, 'payload still contains PII'));
    }
    return reply.code(501).send(failure('NOT_IMPLEMENTED', 'AI insight is a Phase 2 capability'));
  });
}
