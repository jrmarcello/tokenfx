import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  parseOnboardingInput,
  resolveCentralUrl,
  mapRedeemResponseToError,
  loadDefaultEmail,
  resolveInputs,
  formatSuccessMessage,
  atomicWriteConfig,
  preflightExistingConfig,
  runOnboarding,
  callRedeem,
  type AtomicWriteDeps,
  type MinimalFetch,
  type OrchestratorDeps,
  type ReporterConfig,
} from './reporter-setup';

// ---- Pure parser (REQ-30) ----

describe('parseOnboardingInput (REQ-30)', () => {
  it('TC-U-14: parses URL with #token= fragment', () => {
    expect(parseOnboardingInput('https://c/onboard#token=ABC')).toEqual({
      token: 'ABC',
      central_url: 'https://c',
    });
  });

  it('TC-U-15: parses legacy URL with ?token= query', () => {
    expect(parseOnboardingInput('https://c/onboard?token=ABC')).toEqual({
      token: 'ABC',
      central_url: 'https://c',
    });
  });

  it('TC-U-16: URL without token returns central_url + token=null (falls through to bare-token prompt)', () => {
    expect(parseOnboardingInput('https://c/onboard')).toEqual({
      token: null,
      central_url: 'https://c',
    });
  });

  it('TC-U-17: bare 64-char hex token returns token + central_url=null', () => {
    const bare = 'a'.repeat(64);
    expect(parseOnboardingInput(bare)).toEqual({
      token: bare,
      central_url: null,
    });
  });

  it('preserves https port + path when extracting central_url', () => {
    expect(
      parseOnboardingInput('https://central.example.com:8443/onboard#token=XYZ'),
    ).toEqual({
      token: 'XYZ',
      central_url: 'https://central.example.com:8443',
    });
  });

  it('returns token=null and central_url=null when input is empty/whitespace', () => {
    expect(parseOnboardingInput('')).toEqual({ token: null, central_url: null });
    expect(parseOnboardingInput('   ')).toEqual({ token: null, central_url: null });
  });
});

// ---- TLS enforcement (REQ-31) ----

describe('resolveCentralUrl (REQ-31)', () => {
  it('TC-U-19: http URL without --allow-http returns error', () => {
    const r = resolveCentralUrl({
      flagUrl: null,
      envUrl: null,
      parsedUrl: 'http://x.com',
      allowHttp: false,
    });
    expect(r).toHaveProperty('error');
    if ('error' in r) {
      expect(r.error).toContain('HTTPS');
      expect(r.error).toContain('--allow-http');
    }
  });

  it('TC-U-20: http URL with --allow-http returns url (proceeds)', () => {
    const r = resolveCentralUrl({
      flagUrl: null,
      envUrl: null,
      parsedUrl: 'http://localhost:3232',
      allowHttp: true,
    });
    expect(r).toEqual({ url: 'http://localhost:3232' });
  });

  it('https URL is always accepted regardless of allowHttp', () => {
    expect(
      resolveCentralUrl({
        flagUrl: 'https://central.example.com',
        envUrl: null,
        parsedUrl: null,
        allowHttp: false,
      }),
    ).toEqual({ url: 'https://central.example.com' });
  });

  it('precedence: flag > env > parsed', () => {
    expect(
      resolveCentralUrl({
        flagUrl: 'https://flag.com',
        envUrl: 'https://env.com',
        parsedUrl: 'https://parsed.com',
        allowHttp: false,
      }),
    ).toEqual({ url: 'https://flag.com' });
    expect(
      resolveCentralUrl({
        flagUrl: null,
        envUrl: 'https://env.com',
        parsedUrl: 'https://parsed.com',
        allowHttp: false,
      }),
    ).toEqual({ url: 'https://env.com' });
    expect(
      resolveCentralUrl({
        flagUrl: null,
        envUrl: null,
        parsedUrl: 'https://parsed.com',
        allowHttp: false,
      }),
    ).toEqual({ url: 'https://parsed.com' });
  });

  it('returns error when no URL source provided', () => {
    const r = resolveCentralUrl({
      flagUrl: null,
      envUrl: null,
      parsedUrl: null,
      allowHttp: false,
    });
    expect(r).toHaveProperty('error');
  });

  it('rejects malformed URL with error', () => {
    const r = resolveCentralUrl({
      flagUrl: 'not-a-url',
      envUrl: null,
      parsedUrl: null,
      allowHttp: false,
    });
    expect(r).toHaveProperty('error');
  });
});

// ---- Default email from git (REQ-30) ----

describe('loadDefaultEmail (REQ-30 / TC-U-18)', () => {
  it('TC-U-18: returns null when execSync stub throws (git not available / not in repo)', () => {
    const execStub = (): string => {
      throw new Error('not a git repository');
    };
    expect(loadDefaultEmail(execStub)).toBeNull();
  });

  it('returns trimmed email when git config succeeds', () => {
    const execStub = (): string => '  alice@example.com  \n';
    expect(loadDefaultEmail(execStub)).toBe('alice@example.com');
  });

  it('returns null when git outputs empty string', () => {
    const execStub = (): string => '';
    expect(loadDefaultEmail(execStub)).toBeNull();
  });

  it('returns null when git outputs only whitespace', () => {
    const execStub = (): string => '   \n  ';
    expect(loadDefaultEmail(execStub)).toBeNull();
  });
});

// ---- Error mapping (REQ-36) ----

describe('mapRedeemResponseToError (REQ-36)', () => {
  it('TC-U-25: 401 -> "Token inválido…"', () => {
    const msg = mapRedeemResponseToError(401);
    expect(msg).toContain('Token inválido');
    expect(msg).toContain('manager');
  });

  it('TC-U-26: 429 with Retry-After: 30 -> "Espere 30s…"', () => {
    const msg = mapRedeemResponseToError(429, '30');
    expect(msg).toContain('30s');
    expect(msg.toLowerCase()).toContain('espere');
  });

  it('TC-U-26 variant: 429 without Retry-After -> generic retry message', () => {
    const msg = mapRedeemResponseToError(429);
    expect(msg.toLowerCase()).toContain('tentativa');
  });

  it('TC-U-28: 500 -> "Erro no servidor…"', () => {
    const msg = mapRedeemResponseToError(500);
    expect(msg).toContain('Erro no servidor');
    expect(msg).toContain('manager');
  });

  it('400 -> "Pedido malformado: <message>"', () => {
    const msg = mapRedeemResponseToError(400, undefined, undefined, 'token regex failed');
    expect(msg).toContain('Pedido malformado');
    expect(msg).toContain('token regex failed');
  });

  it('400 without details -> "Pedido malformado:" plus generic suffix', () => {
    const msg = mapRedeemResponseToError(400);
    expect(msg).toContain('Pedido malformado');
  });

  it('unknown status (e.g. 418) -> generic server error', () => {
    const msg = mapRedeemResponseToError(418);
    expect(msg).toContain('Erro');
  });
});

describe('mapRedeemResponseToError network/timeout (REQ-36 / TC-U-27)', () => {
  it('TC-U-27: status=0 (network) maps to "Não foi possível alcançar…" with central_url', () => {
    const msg = mapRedeemResponseToError(0, undefined, 'https://central.example.com');
    expect(msg).toContain('Não foi possível alcançar');
    expect(msg).toContain('https://central.example.com');
  });
});

// ---- Input resolution (REQ-35) ----

describe('resolveInputs (REQ-35)', () => {
  it('TC-U-23: env vars TOKENFX_ONBOARD_* all set -> mode=non-interactive, no prompts needed', () => {
    const env = {
      TOKENFX_ONBOARD_TOKEN: 'a'.repeat(64),
      TOKENFX_ONBOARD_EMAIL: 'alice@example.com',
      TOKENFX_ONBOARD_CENTRAL_URL: 'https://central.example.com',
    };
    const r = resolveInputs({ argv: [], env });
    expect(r.errors).toEqual([]);
    expect(r.token).toBe('a'.repeat(64));
    expect(r.email).toBe('alice@example.com');
    expect(r.centralUrl).toBe('https://central.example.com');
    expect(r.mode).toBe('non-interactive');
  });

  it('TC-U-24: --non-interactive with missing email -> errors include "missing email"', () => {
    const r = resolveInputs({
      argv: ['--non-interactive', '--token=' + 'b'.repeat(64), '--central-url=https://c.com'],
      env: {},
    });
    expect(r.mode).toBe('non-interactive');
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors.some((e) => e.toLowerCase().includes('missing') && e.toLowerCase().includes('email'))).toBe(true);
  });

  it('flag precedence: flag > env (token)', () => {
    const r = resolveInputs({
      argv: ['--token=' + 'f'.repeat(64)],
      env: { TOKENFX_ONBOARD_TOKEN: 'e'.repeat(64) },
    });
    expect(r.token).toBe('f'.repeat(64));
  });

  it('flag precedence: flag > env (email)', () => {
    const r = resolveInputs({
      argv: ['--email=flag@example.com'],
      env: { TOKENFX_ONBOARD_EMAIL: 'env@example.com' },
    });
    expect(r.email).toBe('flag@example.com');
  });

  it('flag precedence: flag > env (central-url)', () => {
    const r = resolveInputs({
      argv: ['--central-url=https://flag.example.com'],
      env: { TOKENFX_ONBOARD_CENTRAL_URL: 'https://env.example.com' },
    });
    expect(r.centralUrl).toBe('https://flag.example.com');
  });

  it('mode is "interactive" without --non-interactive flag', () => {
    const r = resolveInputs({ argv: [], env: {} });
    expect(r.mode).toBe('interactive');
  });

  it('--non-interactive with missing token -> errors include "missing token"', () => {
    const r = resolveInputs({
      argv: ['--non-interactive', '--email=alice@example.com', '--central-url=https://c.com'],
      env: {},
    });
    expect(r.errors.some((e) => e.toLowerCase().includes('missing') && e.toLowerCase().includes('token'))).toBe(true);
  });

  it('--non-interactive with missing central-url -> errors include "missing central"', () => {
    const r = resolveInputs({
      argv: ['--non-interactive', '--token=' + 'c'.repeat(64), '--email=alice@example.com'],
      env: {},
    });
    expect(r.errors.some((e) => e.toLowerCase().includes('missing') && e.toLowerCase().includes('central'))).toBe(true);
  });

  it('parses --token=URL flag via parseOnboardingInput (URL fragment form)', () => {
    const r = resolveInputs({
      argv: ['--token=https://central.example.com/onboard#token=' + 'd'.repeat(64)],
      env: {},
    });
    expect(r.token).toBe('d'.repeat(64));
    expect(r.centralUrl).toBe('https://central.example.com');
  });

  it('--non-interactive with all 3 inputs present -> no errors', () => {
    const r = resolveInputs({
      argv: [
        '--non-interactive',
        '--token=' + 'a'.repeat(64),
        '--email=alice@example.com',
        '--central-url=https://central.example.com',
      ],
      env: {},
    });
    expect(r.errors).toEqual([]);
  });

  it('detects --allow-http and --force flags', () => {
    const r = resolveInputs({
      argv: ['--allow-http', '--force'],
      env: {},
    });
    expect(r.allowHttp).toBe(true);
    expect(r.force).toBe(true);
  });
});

// ---- Output sanitization (REQ-33 / TC-U-21) ----

describe('formatSuccessMessage (REQ-33 / TC-U-21)', () => {
  it('TC-U-21: success message contains zero bytes of secret/key_id', () => {
    // Simulate a "fake successful redeem response" — the SUCCESS path log line must
    // not contain key_id or secret. We just call the formatter (no inputs) and assert
    // the output is the canonical safe string.
    const fakeResponse = {
      key_id: 'k_aabbccddeeff0011',
      secret: 'deadbeef'.repeat(8),
    };
    const output = formatSuccessMessage();
    expect(output).not.toContain(fakeResponse.key_id);
    expect(output).not.toContain(fakeResponse.secret);
    // Also assert no substring of length >= 8 from secret leaks
    expect(output).not.toContain('deadbeef');
    expect(output).not.toContain('k_');
  });

  it('returns the canonical Portuguese success line', () => {
    const output = formatSuccessMessage();
    expect(output).toContain('Reporter configurado');
    expect(output).toContain('pnpm reporter:run');
    expect(output).toContain('primeiro batch');
  });
});

// ===========================================================================
// TASK-11b — Integration helpers
// ===========================================================================

// Helper: mint a unique tmp dir per test to avoid cross-test contamination.
const mkTmpDir = async (): Promise<string> => {
  const dir = path.join(os.tmpdir(), `tokenfx-setup-${randomBytes(8).toString('hex')}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
};

// Helper: minimal stub HTTP server. Handler is per-request. Returns
// { url: 'http://127.0.0.1:<port>', close: () => Promise<void> }.
const startStubServer = async (
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> => {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;
  const close = (): Promise<void> =>
    new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  return { url, close };
};

// Helper: a real-fetch-shaped wrapper around node fetch (exists in Node 22+).
const realFetch: MinimalFetch = async (url, init) => {
  const r = await fetch(url, init);
  return {
    status: r.status,
    text: () => r.text(),
    headers: { get: (name) => r.headers.get(name) },
  };
};

// Helper: build deps for runOnboarding with sensible defaults; tests override
// what they care about.
const buildTestDeps = (overrides: Partial<OrchestratorDeps> = {}): {
  deps: OrchestratorDeps;
  stderrLines: string[];
  stdoutLines: string[];
} => {
  const stderrLines: string[] = [];
  const stdoutLines: string[] = [];
  const deps: OrchestratorDeps = {
    readFile: (p) => fs.readFile(p, 'utf-8'),
    fileExists: async (p) => {
      try {
        await fs.access(p);
        return true;
      } catch {
        return false;
      }
    },
    fetchFn: realFetch,
    writeDeps: {
      writeAndSync: async (filePath, data, mode) => {
        const fh = await fs.open(filePath, 'w', mode);
        try {
          await fh.writeFile(data);
          await fh.sync();
        } finally {
          await fh.close();
        }
      },
      rename: (from, to) => fs.rename(from, to),
      unlinkIgnoreMissing: async (p) => {
        try {
          await fs.unlink(p);
        } catch {
          /* ignore */
        }
      },
    },
    randomHex: (bytes) => randomBytes(bytes).toString('hex'),
    hostname: () => 'test-host',
    generateMachineId: () => randomUUID(),
    stderr: (line) => {
      stderrLines.push(line);
    },
    stdout: (line) => {
      stdoutLines.push(line);
    },
    ...overrides,
  };
  return { deps, stderrLines, stdoutLines };
};

// ----- atomicWriteConfig (REQ-34 / TC-U-22) -----

describe('atomicWriteConfig (REQ-34 / TC-U-22)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) {
      const c = cleanups.pop();
      if (c !== undefined) await c().catch(() => undefined);
    }
  });

  const sampleConfig = (): ReporterConfig => ({
    key_id: 'k_aabbccddeeff0011',
    secret: 'deadbeef'.repeat(8),
    machine_id: '00000000-0000-4000-8000-000000000000',
    user_email: 'alice@example.com',
    central_url: 'https://central.example.com',
    project_secret: randomBytes(32).toString('hex'),
  });

  it('writes the config atomically (tmp + rename) with mode 0600', async () => {
    const dir = await mkTmpDir();
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const target = path.join(dir, 'reporter-config.json');

    await atomicWriteConfig(target, sampleConfig());

    const stat = await fs.stat(target);
    // Mode bits: lower 9 bits are perms; 0o600 = owner-rw only.
    expect(stat.mode & 0o777).toBe(0o600);

    const content = JSON.parse(await fs.readFile(target, 'utf-8'));
    expect(content.key_id).toBe('k_aabbccddeeff0011');

    // The tmp file must NOT linger after a successful rename.
    await expect(fs.access(`${target}.tmp`)).rejects.toThrow();
  });

  it('TC-U-22: rename failure leaves original config untouched and removes tmp', async () => {
    const dir = await mkTmpDir();
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const target = path.join(dir, 'reporter-config.json');

    // Pre-existing config — must survive the failed write.
    const existing = '{"key_id":"k_originaaaa000000","note":"untouched"}';
    await fs.writeFile(target, existing, { mode: 0o600 });

    let tmpUnlinked = false;
    const failingDeps: AtomicWriteDeps = {
      writeAndSync: async (p, data, mode) => {
        const fh = await fs.open(p, 'w', mode);
        try {
          await fh.writeFile(data);
          await fh.sync();
        } finally {
          await fh.close();
        }
      },
      rename: async () => {
        throw new Error('simulated rename EIO');
      },
      unlinkIgnoreMissing: async (p) => {
        try {
          await fs.unlink(p);
          tmpUnlinked = true;
        } catch {
          /* ignore */
        }
      },
    };

    await expect(atomicWriteConfig(target, sampleConfig(), failingDeps)).rejects.toThrow(/Falha ao gravar config/);

    // Original config bytes preserved.
    const after = await fs.readFile(target, 'utf-8');
    expect(after).toBe(existing);

    // Tmp was cleaned up.
    expect(tmpUnlinked).toBe(true);
    await expect(fs.access(`${target}.tmp`)).rejects.toThrow();
  });

  it('rename failure error message contains zero bytes of secret/key_id (REQ-33)', async () => {
    const dir = await mkTmpDir();
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const target = path.join(dir, 'reporter-config.json');

    const cfg = sampleConfig();
    const failingDeps: AtomicWriteDeps = {
      writeAndSync: async (p, data, mode) => {
        const fh = await fs.open(p, 'w', mode);
        try {
          await fh.writeFile(data);
          await fh.sync();
        } finally {
          await fh.close();
        }
      },
      rename: async () => {
        throw new Error('simulated rename failure');
      },
      unlinkIgnoreMissing: async () => undefined,
    };

    let caught: Error | null = null;
    try {
      await atomicWriteConfig(target, cfg, failingDeps);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    if (caught !== null) {
      expect(caught.message).not.toContain(cfg.key_id);
      expect(caught.message).not.toContain(cfg.secret);
      expect(caught.message).not.toContain(cfg.project_secret);
    }
  });
});

// ----- preflightExistingConfig (REQ-32) -----

describe('preflightExistingConfig (REQ-32)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) {
      const c = cleanups.pop();
      if (c !== undefined) await c().catch(() => undefined);
    }
  });

  it('returns no-existing-config when file is absent', async () => {
    const dir = await mkTmpDir();
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const target = path.join(dir, 'reporter-config.json');

    const result = await preflightExistingConfig(target, {
      readFile: (p) => fs.readFile(p, 'utf-8'),
      fileExists: async (p) => {
        try {
          await fs.access(p);
          return true;
        } catch {
          return false;
        }
      },
      fetchFn: async () => {
        throw new Error('should not be called');
      },
    });

    expect(result.kind).toBe('no-existing-config');
  });

  it('returns existing-valid when /api/health 200', async () => {
    const dir = await mkTmpDir();
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const target = path.join(dir, 'reporter-config.json');

    const stub = await startStubServer((req, res) => {
      if (req.url?.startsWith('/api/health')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, server_time: new Date().toISOString() }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    cleanups.push(stub.close);

    await fs.writeFile(
      target,
      JSON.stringify({
        key_id: 'k_existing00000001',
        secret: 'existing-secret-bytes',
        central_url: stub.url,
      }),
      { mode: 0o600 },
    );

    const result = await preflightExistingConfig(target, {
      readFile: (p) => fs.readFile(p, 'utf-8'),
      fileExists: async (p) => {
        try {
          await fs.access(p);
          return true;
        } catch {
          return false;
        }
      },
      fetchFn: realFetch,
    });
    expect(result.kind).toBe('existing-valid');
  });

  it('returns existing-invalid when /api/health 401', async () => {
    const dir = await mkTmpDir();
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const target = path.join(dir, 'reporter-config.json');

    const stub = await startStubServer((req, res) => {
      if (req.url?.startsWith('/api/health')) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: { message: 'unauthorized', code: 'unauthorized' } }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    cleanups.push(stub.close);

    await fs.writeFile(
      target,
      JSON.stringify({
        key_id: 'k_stale000000000001',
        secret: 'stale-secret',
        central_url: stub.url,
      }),
      { mode: 0o600 },
    );

    const result = await preflightExistingConfig(target, {
      readFile: (p) => fs.readFile(p, 'utf-8'),
      fileExists: async (p) => {
        try {
          await fs.access(p);
          return true;
        } catch {
          return false;
        }
      },
      fetchFn: realFetch,
    });
    expect(result.kind).toBe('existing-invalid');
  });

  it('returns unreachable when fetch throws', async () => {
    const dir = await mkTmpDir();
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const target = path.join(dir, 'reporter-config.json');

    await fs.writeFile(
      target,
      JSON.stringify({
        key_id: 'k_anything00000001',
        secret: 'anything',
        central_url: 'http://127.0.0.1:1', // unroutable
      }),
      { mode: 0o600 },
    );

    const result = await preflightExistingConfig(target, {
      readFile: (p) => fs.readFile(p, 'utf-8'),
      fileExists: async (p) => {
        try {
          await fs.access(p);
          return true;
        } catch {
          return false;
        }
      },
      fetchFn: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(result.kind).toBe('unreachable');
  });
});

// ----- callRedeem (smoke for HTTP wiring) -----

describe('callRedeem', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) {
      const c = cleanups.pop();
      if (c !== undefined) await c().catch(() => undefined);
    }
  });

  it('returns RedeemSuccess on 200 with valid body', async () => {
    const stub = await startStubServer((req, res) => {
      if (req.url?.startsWith('/api/onboarding/redeem-invite') && req.method === 'POST') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            key_id: 'k_aabbccddeeff0011',
            secret: 'a'.repeat(64),
            central_url: 'http://test',
            user_email: 'alice@example.com',
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    cleanups.push(stub.close);

    const result = await callRedeem(
      {
        centralUrl: stub.url,
        token: 'a'.repeat(64),
        machineId: randomUUID(),
        hostname: 'h',
        claimedEmail: 'alice@example.com',
      },
      realFetch,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.key_id).toBe('k_aabbccddeeff0011');
  });

  it('returns RedeemFailure with status=0 on network error', async () => {
    const result = await callRedeem(
      {
        centralUrl: 'http://127.0.0.1:1',
        token: 'b'.repeat(64),
        machineId: randomUUID(),
        hostname: 'h',
        claimedEmail: 'b@example.com',
      },
      async () => {
        throw new Error('connect ECONNREFUSED');
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(0);
  });

  it('extracts Retry-After on 429', async () => {
    const stub = await startStubServer((req, res) => {
      res.statusCode = 429;
      res.setHeader('Retry-After', '30');
      res.end(JSON.stringify({ error: { message: 'rate limited' } }));
    });
    cleanups.push(stub.close);

    const result = await callRedeem(
      {
        centralUrl: stub.url,
        token: 'c'.repeat(64),
        machineId: randomUUID(),
        hostname: 'h',
        claimedEmail: 'c@example.com',
      },
      realFetch,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(429);
      expect(result.retryAfter).toBe('30');
    }
  });
});

// ----- runOnboarding integration (TC-I-66..68b, TC-I-72, TC-I-73) -----

describe('runOnboarding integration', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) {
      const c = cleanups.pop();
      if (c !== undefined) await c().catch(() => undefined);
    }
  });

  // Stub server that handles BOTH /api/health AND /api/onboarding/redeem-invite.
  // healthMode: 'valid' (200) | 'invalid' (401) | null (no health endpoint).
  // redeemMode: 'success' (200 with body) | 'fail-401' | null (no redeem).
  type StubMode = {
    healthMode: 'valid' | 'invalid' | null;
    redeemMode: 'success' | 'fail-401' | null;
  };
  const startCombinedStub = async (mode: StubMode): Promise<{ url: string; close: () => Promise<void>; redeemHits: number }> => {
    const counter = { redeemHits: 0 };
    const stub = await startStubServer((req, res) => {
      if (req.url?.startsWith('/api/health')) {
        if (mode.healthMode === 'valid') {
          res.statusCode = 200;
          res.end(JSON.stringify({ ok: true, server_time: new Date().toISOString() }));
        } else if (mode.healthMode === 'invalid') {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: { message: 'unauthorized', code: 'unauthorized' } }));
        } else {
          res.statusCode = 404;
          res.end();
        }
        return;
      }
      if (req.url?.startsWith('/api/onboarding/redeem-invite') && req.method === 'POST') {
        counter.redeemHits += 1;
        if (mode.redeemMode === 'success') {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              key_id: 'k_newredeemed00001',
              secret: 'r'.repeat(64),
              central_url: `http://127.0.0.1:${(req.socket.localPort ?? 0)}`,
              user_email: 'alice@example.com',
            }),
          );
        } else {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: { message: 'invalid', code: 'unauthorized' } }));
        }
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    return {
      url: stub.url,
      close: stub.close,
      get redeemHits(): number {
        return counter.redeemHits;
      },
    };
  };

  it('TC-I-66: existing valid config + /api/health 200 → exit 1 with "config válida já existe"', async () => {
    const dir = await mkTmpDir();
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const configPath = path.join(dir, 'reporter-config.json');

    const stub = await startCombinedStub({ healthMode: 'valid', redeemMode: 'success' });
    cleanups.push(stub.close);

    // Pre-existing valid config.
    await fs.writeFile(
      configPath,
      JSON.stringify({
        key_id: 'k_pre000000000001',
        secret: 'pre-secret',
        central_url: stub.url,
      }),
      { mode: 0o600 },
    );

    const { deps, stderrLines } = buildTestDeps();
    const result = await runOnboarding(
      {
        token: 'a'.repeat(64),
        email: 'alice@example.com',
        centralUrl: stub.url,
        force: false,
        configPath,
      },
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.exitCode).toBe(1);
    expect(stderrLines.join('')).toContain('Configuração válida já existe');
    // Redeem MUST NOT have been called.
    expect(stub.redeemHits).toBe(0);
  });

  it('TC-I-67: existing config + /api/health 401 → setup proceeds and overwrites', async () => {
    const dir = await mkTmpDir();
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const configPath = path.join(dir, 'reporter-config.json');

    const stub = await startCombinedStub({ healthMode: 'invalid', redeemMode: 'success' });
    cleanups.push(stub.close);

    await fs.writeFile(
      configPath,
      JSON.stringify({
        key_id: 'k_stale00000000001',
        secret: 'stale',
        central_url: stub.url,
      }),
      { mode: 0o600 },
    );

    const { deps, stderrLines, stdoutLines } = buildTestDeps();
    const result = await runOnboarding(
      {
        token: 'a'.repeat(64),
        email: 'alice@example.com',
        centralUrl: stub.url,
        force: false,
        configPath,
      },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(stderrLines.join('')).toContain('Sobrescrevendo automaticamente');
    expect(stdoutLines.join('')).toContain('Reporter configurado');

    // Config file overwritten with new values.
    const written = JSON.parse(await fs.readFile(configPath, 'utf-8')) as ReporterConfig;
    expect(written.key_id).toBe('k_newredeemed00001');
    expect(stub.redeemHits).toBe(1);
  });

  it('TC-I-68: existing config + --force → setup proceeds even if /api/health 200', async () => {
    const dir = await mkTmpDir();
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const configPath = path.join(dir, 'reporter-config.json');

    const stub = await startCombinedStub({ healthMode: 'valid', redeemMode: 'success' });
    cleanups.push(stub.close);

    await fs.writeFile(
      configPath,
      JSON.stringify({
        key_id: 'k_old0000000000001',
        secret: 'old-secret',
        central_url: stub.url,
      }),
      { mode: 0o600 },
    );

    const { deps } = buildTestDeps();
    const result = await runOnboarding(
      {
        token: 'a'.repeat(64),
        email: 'alice@example.com',
        centralUrl: stub.url,
        force: true,
        configPath,
      },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(stub.redeemHits).toBe(1);
    const written = JSON.parse(await fs.readFile(configPath, 'utf-8')) as ReporterConfig;
    expect(written.key_id).toBe('k_newredeemed00001');
  });

  it('TC-I-68b: existing config + network unreachable → exit 1 with "Não foi possível verificar"', async () => {
    const dir = await mkTmpDir();
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const configPath = path.join(dir, 'reporter-config.json');

    // central_url points at an unroutable port so /api/health fails.
    await fs.writeFile(
      configPath,
      JSON.stringify({
        key_id: 'k_anything00000001',
        secret: 'anything',
        central_url: 'http://127.0.0.1:1',
      }),
      { mode: 0o600 },
    );

    // Custom fetch always throws — simulates network unreachable.
    const fetchFn: MinimalFetch = async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:1');
    };

    const { deps, stderrLines } = buildTestDeps({ fetchFn });
    const result = await runOnboarding(
      {
        token: 'a'.repeat(64),
        email: 'alice@example.com',
        centralUrl: 'http://127.0.0.1:1',
        force: false,
        configPath,
      },
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.exitCode).toBe(1);
    expect(stderrLines.join('')).toContain('Não foi possível verificar');
  });

  it('TC-I-72: after successful redeem, config exists with mode 0600', async () => {
    const dir = await mkTmpDir();
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const configPath = path.join(dir, 'reporter-config.json');

    const stub = await startCombinedStub({ healthMode: null, redeemMode: 'success' });
    cleanups.push(stub.close);

    const { deps } = buildTestDeps();
    const result = await runOnboarding(
      {
        token: 'a'.repeat(64),
        email: 'alice@example.com',
        centralUrl: stub.url,
        force: false,
        configPath,
      },
      deps,
    );

    expect(result.ok).toBe(true);
    const stat = await fs.stat(configPath);
    expect(stat.mode & 0o777).toBe(0o600);

    const written = JSON.parse(await fs.readFile(configPath, 'utf-8')) as ReporterConfig;
    expect(written.key_id).toBe('k_newredeemed00001');
    expect(written.secret).toBe('r'.repeat(64));
    expect(written.user_email).toBe('alice@example.com');
    // project_secret was generated locally — must be 64 hex chars.
    expect(written.project_secret).toMatch(/^[0-9a-f]{64}$/);
    expect(written.machine_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('TC-I-73: data/ not writable → exits non-zero, no leak in any output', async () => {
    const dir = await mkTmpDir();
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined));
    const configPath = path.join(dir, 'reporter-config.json');

    const stub = await startCombinedStub({ healthMode: null, redeemMode: 'success' });
    cleanups.push(stub.close);

    // Make the writeAndSync step fail to simulate "data/ not writable".
    // (Avoiding chmod on the directory because Vitest may run as root in CI.)
    const writeFailure: AtomicWriteDeps = {
      writeAndSync: async () => {
        throw new Error('EACCES: permission denied');
      },
      rename: async () => {
        throw new Error('should not be reached');
      },
      unlinkIgnoreMissing: async () => undefined,
    };

    const { deps, stderrLines, stdoutLines } = buildTestDeps({ writeDeps: writeFailure });
    const result = await runOnboarding(
      {
        token: 'a'.repeat(64),
        email: 'alice@example.com',
        centralUrl: stub.url,
        force: false,
        configPath,
      },
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.exitCode).toBe(1);

    const allOutput = stderrLines.join('') + stdoutLines.join('');
    // The redeem response had key_id='k_newredeemed00001' and secret='r'.repeat(64).
    expect(allOutput).not.toContain('k_newredeemed00001');
    expect(allOutput).not.toContain('r'.repeat(64));
    // It SHOULD contain a clear failure indication.
    expect(allOutput.toLowerCase()).toContain('falha');
  });

  // ---------------------------------------------------------------------
  // TC-F-10: malicious central_url — pre-existing config bytes must NOT
  // leak into stdout/stderr regardless of where the user is sending the
  // redeem request. Attack scenario: a manager hands the dev a poisoned
  // onboarding URL pointing at attacker-controlled HTTPS; the dev's
  // setup CLI MUST NOT echo their existing key_id/secret/project_secret
  // to any output during the redeem flow (those bytes already live in
  // `data/reporter-config.json` and the CLI reads them for the
  // pre-flight check). Defense relies on REQ-33 + REQ-32 boundaries.
  // ---------------------------------------------------------------------
  it('TC-F-10: malicious central_url does not leak stored config bytes to output', async () => {
    const dir = await mkTmpDir();
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined));
    const configPath = path.join(dir, 'reporter-config.json');

    // Pre-existing valid config — these are the secrets that MUST NOT leak.
    const PREEXISTING_KEY = 'k_legitimateprior01';
    const PREEXISTING_SECRET = 'L'.repeat(64);
    const PREEXISTING_PROJECT_SECRET = 'P'.repeat(64);
    const PREEXISTING_MACHINE_ID = '11111111-2222-3333-4444-555555555555';
    await fs.writeFile(
      configPath,
      JSON.stringify({
        key_id: PREEXISTING_KEY,
        secret: PREEXISTING_SECRET,
        project_secret: PREEXISTING_PROJECT_SECRET,
        machine_id: PREEXISTING_MACHINE_ID,
        user_email: 'alice@example.com',
        central_url: 'https://legit.example.com',
      }),
      { mode: 0o600 },
    );

    // The "attacker server" returns 200 to /api/health (so pre-flight
    // looks valid and the user gets a `existing-valid` rejection). This
    // simulates the worst case — a malicious server that successfully
    // impersonates the central. Even then no bytes from the existing
    // config should hit any output the CLI writes. Note: pre-flight
    // requires --force to be absent → exit 1.
    const stub = await startCombinedStub({ healthMode: 'valid', redeemMode: 'success' });
    cleanups.push(stub.close);

    const { deps, stderrLines, stdoutLines } = buildTestDeps();
    const result = await runOnboarding(
      {
        token: 'a'.repeat(64),
        email: 'alice@example.com',
        centralUrl: stub.url, // attacker-controlled URL
        force: false,
        configPath,
      },
      deps,
    );

    expect(result.ok).toBe(false); // pre-flight refuses without --force
    const allOutput = stderrLines.join('') + stdoutLines.join('');
    // Critical assertions: no pre-existing config bytes in any output.
    expect(allOutput).not.toContain(PREEXISTING_KEY);
    expect(allOutput).not.toContain(PREEXISTING_SECRET);
    expect(allOutput).not.toContain(PREEXISTING_PROJECT_SECRET);
    // No `Bearer <secret>` substring either (would show a leaked auth header).
    expect(allOutput.toLowerCase()).not.toContain('bearer ');
  });
});
