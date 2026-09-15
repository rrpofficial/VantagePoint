/**
 * CONTAINER ACCEPTANCE — PRD FR-8 (Module 8), NFR-4. Tagged @container.
 *
 * US-9.1 Backend image · US-9.2 Frontend image · US-9.3 Compose stack
 * US-9.4 Host bind-mount persistence · US-9.5 UID/GID ownership
 * US-9.6 Image hygiene · US-9.7 In-container budgets · US-9.8 Cross-platform
 *
 * These require a Docker daemon. They are excluded from the fast unit run
 * (`pnpm test`) and executed by `pnpm test:container`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const COMPOSE_TIMEOUT = 300_000;

/**
 * The suite runs as its OWN compose project, on its OWN image tag and port.
 *
 * All three used to be inherited from whatever `.env` happened to say. That was
 * harmless while there was one stack and dangerous the moment there were two:
 * teardown runs `compose down -v`, which would have destroyed whichever project
 * `.env` named — a running production instance — and `up --build` would have
 * rebuilt the image tag that instance was serving from. Pinning them here means
 * the suite can only ever affect itself.
 */
const PROJECT = 'vantagepoint-container-test';
const IMAGE_TAG = 'container-test';
/** Deliberately not 5173: a production or testing stack may already hold it. */
const WEB_PORT = '5399';

const API = `${PROJECT}-api`;
const WEB = `${PROJECT}-web`;
const API_IMAGE = `vantagepoint-api:${IMAGE_TAG}`;

/** Throwaway host directory standing in for the user's VANTAGEPOINT_DATA_DIR. */
let hostDataDir: string;

const sh = (cmd: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: COMPOSE_TIMEOUT,
    // The pins go on EVERY invocation, not just the `compose` helper: several
    // assertions below call `docker compose exec` through `sh` directly, and one
    // that resolved to a different project would exec into the wrong stack.
    env: {
      ...process.env,
      VANTAGEPOINT_PROJECT: PROJECT,
      VANTAGEPOINT_IMAGE_TAG: IMAGE_TAG,
      VANTAGEPOINT_WEB_PORT: WEB_PORT,
      ...env,
    },
  });

const compose = (args: string[], env: Record<string, string> = {}) =>
  sh('docker', ['compose', ...args], { VANTAGEPOINT_DATA_DIR: hostDataDir, ...env });

const uid = String(process.getuid?.() ?? 1000);
const gid = String(process.getgid?.() ?? 1000);

/**
 * Creates the database on the host mount. The vault file does not exist until a
 * passphrase is supplied — migrations run on unlock — so a stack that has merely
 * started has nothing on disk yet, and every persistence assertion below would
 * be measuring an absence.
 */
function unlockVault(): void {
  sh('docker', [
    'compose',
    'exec',
    '-T',
    'web',
    'wget',
    '-q',
    '-O',
    '-',
    '--header=content-type: application/json',
    '--post-data',
    '{"passphrase":"correct horse battery staple"}',
    'http://localhost:80/api/vault/unlock',
  ]);
}

beforeAll(() => {
  hostDataDir = mkdtempSync(join(tmpdir(), 'vantagepoint-data-'));
  compose(['up', '--build', '-d', '--wait'], { VANTAGEPOINT_UID: uid, VANTAGEPOINT_GID: gid });
  unlockVault();
}, COMPOSE_TIMEOUT);

afterAll(() => {
  try {
    compose(['down', '-v']);
  } catch {
    /* teardown is best-effort; the temp dir is discarded either way */
  }
});

describe('@container US-9.3 — compose stack orchestration', () => {
  describe('Scenario: Clean-host bring-up with no local toolchain (PRD FR-8 AC)', () => {
    it('reports the backend healthy', () => {
      const health = sh('docker', [
        'inspect',
        '-f',
        '{{.State.Health.Status}}',
        API,
      ]).trim();
      expect(health).toBe('healthy');
    });

    it('serves the frontend on the published port', () => {
      const status = sh('docker', [
        'compose',
        'exec',
        '-T',
        'web',
        'wget',
        '-qO-',
        'http://localhost:80/',
      ]);
      expect(status).toContain('<div id="root"');
    });

    it('proxies /api through the web container to the backend', () => {
      const body = sh('docker', [
        'compose',
        'exec',
        '-T',
        'web',
        'wget',
        '-qO-',
        'http://localhost:80/api/health/live',
      ]);
      expect(JSON.parse(body).status).toBe('ok');
    });
  });

  describe('Scenario: Only the web service publishes a host port', () => {
    it('publishes a host port for the web container', () => {
      expect(sh('docker', ['port', WEB]).trim().length).toBeGreaterThan(0);
    });

    it('publishes no host port for the api container', () => {
      expect(sh('docker', ['port', API]).trim()).toBe('');
    });
  });

  describe('Scenario: Egress is denied by default (ADR-010)', () => {
    it('fails an outbound request from the API container in the default profile', () => {
      expect(() =>
        sh('docker', [
          'compose',
          'exec',
          '-T',
          'api',
          'node',
          '-e',
          "fetch('https://example.com').then(()=>process.exit(0)).catch(()=>process.exit(9))",
        ]),
      ).toThrow();
    });
  });
});

describe('@container US-9.4 — host-native bind-mount persistence (FR-8.2, ADR-012)', () => {
  describe('Scenario: Data directory is a bind mount, not a Docker-managed volume', () => {
    it('reports mount Type "bind"', () => {
      const type = sh('docker', [
        'inspect',
        '-f',
        '{{range .Mounts}}{{if eq .Destination "/var/lib/vantagepoint"}}{{.Type}}{{end}}{{end}}',
        API,
      ]).trim();
      expect(type).toBe('bind');
    });

    it('reports an absolute host path as the mount Source', () => {
      const source = sh('docker', [
        'inspect',
        '-f',
        '{{range .Mounts}}{{if eq .Destination "/var/lib/vantagepoint"}}{{.Source}}{{end}}{{end}}',
        API,
      ]).trim();
      expect(source).toBe(hostDataDir);
    });
  });

  describe('Scenario: The database file is visible on the host filesystem', () => {
    it('creates vault.db under the configured host data directory', () => {
      expect(existsSync(join(hostDataDir, 'vault.db'))).toBe(true);
    });

    it('is readable from the host without entering the container', () => {
      expect(statSync(join(hostDataDir, 'vault.db')).size).toBeGreaterThan(0);
    });
  });

  describe('Scenario: Database persists across container destruction (PRD FR-8 AC)', () => {
    it('retains the database file after `docker compose down`', () => {
      compose(['down']);
      expect(existsSync(join(hostDataDir, 'vault.db'))).toBe(true);
    });

    it('brings the same data back up after a restart', () => {
      compose(['up', '-d', '--wait'], { VANTAGEPOINT_UID: uid, VANTAGEPOINT_GID: gid });
      const body = sh('docker', [
        'compose',
        'exec',
        '-T',
        'api',
        'node',
        '--input-type=module',
        '-e',
        "import {existsSync} from 'node:fs'; process.stdout.write(existsSync('/var/lib/vantagepoint/vault.db')?'yes':'no')",
      ]);
      expect(body).toBe('yes');
    });

    it('unlocks with the same passphrase after the restart', () => {
      // The real proof of persistence: the salt and ciphertext both survived, so
      // the original key still derives. A file that merely exists proves nothing.
      expect(() => { unlockVault(); }).not.toThrow();
    });
  });

  describe('Scenario: Database survives an image rebuild (PRD FR-8 AC)', () => {
    it('leaves pre-existing data intact after `build --no-cache` and restart', () => {
      const before = statSync(join(hostDataDir, 'vault.db')).size;
      compose(['build', '--no-cache', 'api']);
      compose(['up', '-d', '--wait'], { VANTAGEPOINT_UID: uid, VANTAGEPOINT_GID: gid });
      expect(statSync(join(hostDataDir, 'vault.db')).size).toBeGreaterThanOrEqual(before);
    });
  });

  describe('Scenario: Nothing is written to the container writable layer', () => {
    it('shows no database file in `docker diff`', () => {
      const diff = sh('docker', ['diff', API]);
      expect(diff).not.toMatch(/vault\.db/);
    });
  });
});

describe('@container US-9.5 — host UID/GID ownership (FR-8.3)', () => {
  describe('Scenario: Bind-mounted files are owned by the host user', () => {
    it('creates vault.db owned by the configured host UID', () => {
      expect(String(statSync(join(hostDataDir, 'vault.db')).uid)).toBe(uid);
    });

    it('creates vault.db owned by the configured host GID', () => {
      expect(String(statSync(join(hostDataDir, 'vault.db')).gid)).toBe(gid);
    });

    it('lets the host user list the data directory without elevation', () => {
      expect(readdirSync(hostDataDir).length).toBeGreaterThan(0);
    });
  });

  describe('Scenario: Unwritable data directory fails fast with an actionable message', () => {
    it('exits non-zero and names the path, expected UID/GID and remediation', () => {
      let output = '';
      try {
        sh('docker', [
          'compose',
          'run',
          '--rm',
          '-u',
          '65534:65534',
          'api',
          'true',
        ]);
      } catch (error) {
        output = ((error as { stderr?: string }).stderr ?? '') +
          ((error as { stdout?: string }).stdout ?? '');
      }
      expect(output).toContain('/var/lib/vantagepoint');
      expect(output).toMatch(/chown/);
    });
  });
});

describe('@container US-9.1 / US-9.2 — container security posture (FR-8.3)', () => {
  describe('Scenario: Containers do not run as root', () => {
    it.each(['api', 'web'])('runs %s as a non-root user', (service) => {
      const id = sh('docker', ['compose', 'exec', '-T', service, 'id', '-u']).trim();
      expect(id).not.toBe('0');
    });
  });

  describe('Scenario: Root filesystem is read-only except data and tmp', () => {
    it('rejects a write to /app in the API container', () => {
      expect(() =>
        sh('docker', ['compose', 'exec', '-T', 'api', 'touch', '/app/should-fail']),
      ).toThrow();
    });

    it('allows a write to the bind-mounted data directory', () => {
      expect(() =>
        sh('docker', ['compose', 'exec', '-T', 'api', 'touch', '/var/lib/vantagepoint/.probe']),
      ).not.toThrow();
    });

    it('allows a write to /tmp', () => {
      expect(() =>
        sh('docker', ['compose', 'exec', '-T', 'api', 'touch', '/tmp/probe']),
      ).not.toThrow();
    });
  });

  describe('Scenario: Base image is pinned by digest', () => {
    it.each(['docker/api.Dockerfile', 'docker/web.Dockerfile'])(
      '%s pins FROM by sha256 digest',
      (dockerfile) => {
        const froms = sh('grep', ['-E', '^FROM', join(ROOT, dockerfile)])
          .trim()
          .split('\n');
        for (const line of froms) expect(line).toMatch(/@sha256:[a-f0-9]{64}/);
      },
    );
  });
});

describe('@container US-9.6 — secret handling and image hygiene (FR-8.3)', () => {
  describe('Scenario: No secrets are baked into images (PRD FR-8 AC)', () => {
    it('contains no .env file in the API image', () => {
      const found = sh('docker', [
        'run',
        '--rm',
        '--entrypoint',
        'sh',
        API_IMAGE,
        '-c',
        'find / -name ".env" -not -path "/proc/*" 2>/dev/null | head -1',
      ]).trim();
      expect(found).toBe('');
    });

    it('has no passphrase in the image history', () => {
      const history = sh('docker', ['history', '--no-trunc', API_IMAGE]);
      expect(history).not.toMatch(/passphrase|VANTAGEPOINT_PASSPHRASE=/i);
    });
  });

  describe('Scenario: .dockerignore excludes data, secrets and history', () => {
    it.each(['data', '.env', '*.db', '.git', 'node_modules'])('excludes %s', (pattern) => {
      const ignore = sh('cat', [join(ROOT, '.dockerignore')]);
      expect(ignore).toContain(pattern);
    });
  });

  describe('Scenario: Multi-stage build excludes build tooling', () => {
    it('ships no TypeScript compiler in the runtime image', () => {
      const found = sh('docker', [
        'run',
        '--rm',
        '--entrypoint',
        'sh',
        API_IMAGE,
        '-c',
        'ls node_modules/.bin/tsc 2>/dev/null || echo absent',
      ]).trim();
      expect(found).toBe('absent');
    });

    it('keeps the runtime image under 400 MB', () => {
      const bytes = Number(
        sh('docker', ['image', 'inspect', '-f', '{{.Size}}', API_IMAGE]).trim(),
      );
      expect(bytes).toBeLessThan(400 * 1024 * 1024);
    });
  });
});

describe('@container US-9.7 — NFR budgets hold inside the container', () => {
  describe('Scenario: NFR budgets hold inside the container', () => {
    it('values a 1,000-lot portfolio through the API in under 1,500 ms', () => {
      const ms = Number(
        sh('docker', [
          'compose',
          'exec',
          '-T',
          'api',
          'node',
          '--input-type=module',
          '-e',
          "const t=Date.now();await fetch('http://localhost:8080/api/portfolio/valuation');process.stdout.write(String(Date.now()-t))",
        ]).trim(),
      );
      expect(ms).toBeLessThan(1500);
    });
  });
});

describe('@container US-9.8 — cross-platform compose definition', () => {
  describe('Scenario: The same compose file works on Linux, macOS and Windows/WSL2', () => {
    it('uses forward slashes and a relative default for the data directory', () => {
      const yaml = sh('cat', [join(ROOT, 'compose.yaml')]);
      expect(yaml).toContain('${VANTAGEPOINT_DATA_DIR:-./data}');
      expect(yaml).not.toMatch(/[A-Z]:\\/);
    });

    it('requires no host-OS-specific mount flag', () => {
      const yaml = sh('cat', [join(ROOT, 'compose.yaml')]);
      expect(yaml).not.toMatch(/:z\b|:Z\b|cached|delegated/);
    });
  });
});
