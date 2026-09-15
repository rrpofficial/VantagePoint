/**
 * apps/api — the backend HTTP shell that runs inside the `vantagepoint-api`
 * container (ADR-011).
 *
 * Deliberately thin: it opens the vault, registers routes and gets out of the
 * way. `inject` exposes in-process request handling so functional tests exercise
 * real routing without opening a socket, keeping the suite hermetic.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { Vault } from '@vantagepoint/persistence';
import { registerRoutes } from './routes/index.js';

export interface InjectOptions {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly url: string;
  readonly payload?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface InjectResponse {
  readonly statusCode: number;
  readonly body: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

export interface ApiApp {
  inject(options: InjectOptions): Promise<InjectResponse>;
  listen(options: { port: number; host: string }): Promise<void>;
  close(): Promise<void>;
}

export interface ApiConfig {
  /** In-container path backed by the host bind mount (ADR-012). */
  readonly dataDir: string;
  readonly port?: number;
}

export async function buildApp(config: ApiConfig): Promise<ApiApp> {
  const fastify: FastifyInstance = Fastify({ logger: false });

  /*
   * Last line of defence. A route that throws unexpectedly returned Fastify's
   * default 500 carrying the raw message — one such response read
   * `[DecimalError] Invalid argument: 1,00,000`, which exposes an internal
   * library and a user's amount while telling them nothing they can act on.
   *
   * Only 5xx is masked. The first version of this masked EVERYTHING, and a
   * malformed request then came back as "VantagePoint could not complete that
   * request" — indistinguishable from a server defect. The Lock vault button hit
   * exactly that: the browser posted no body under a JSON content-type, Fastify
   * correctly answered 400, and the screen reported an internal error, which
   * sent the search in entirely the wrong direction. A 4xx is the client's to
   * fix, so it keeps its own code and message.
   */
  /*
   * An empty body under a JSON content-type means "no arguments", not "malformed
   * request". Fastify's default parser rejects it with 400, which is defensible
   * in the abstract and wrong here: `/api/vault/lock` takes no arguments, and a
   * browser that declares JSON on every request could therefore never call it.
   * Parsing this at the edge is better than teaching each caller a rule.
   */
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body: string, done) => {
      if (body.length === 0) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(body));
      } catch (cause) {
        const error = cause as Error & { statusCode?: number };
        error.statusCode = 400;
        done(error, undefined);
      }
    },
  );

  fastify.setErrorHandler(
    (error: { statusCode?: number; code?: string; message?: string }, _request, reply) => {
      const status = error.statusCode ?? 500;
      if (status < 500) {
        void reply.code(status).send({
          error: {
            code: error.code ?? 'BAD_REQUEST',
            message: error.message ?? 'the request could not be read',
          },
        });
        return;
      }
      void reply.code(status).send({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'VantagePoint could not complete that request. Nothing was changed.',
        },
      });
    },
  );

  registerRoutes(fastify);
  await fastify.ready();

  // Opened, not unlocked: the passphrase arrives per session and the process
  // must be able to report itself live while still refusing to serve data.
  await Vault.open({ dataDir: config.dataDir, fileName: 'vault.db' });

  return {
    async inject(options) {
      const response = await fastify.inject({
        method: options.method,
        url: options.url,
        payload: options.payload as never,
        headers: options.headers as never,
      });
      return {
        statusCode: response.statusCode,
        body: response.body,
        headers: response.headers as Readonly<Record<string, string | string[] | undefined>>,
      };
    },
    async listen(options) {
      await fastify.listen(options);
    },
    async close() {
      await fastify.close();
      await Vault.close();
    },
  };
}
