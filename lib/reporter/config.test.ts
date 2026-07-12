import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { centralUrlSchema, readConfig, type ReporterConfig } from './config';

/**
 * A fully-valid config used as the base for the readConfig wiring test.
 * Individual error-path cases build their own (intentionally broken) objects.
 */
const VALID_CONFIG: ReporterConfig = {
  key_id: 'key-1',
  secret: 'machine-secret',
  machine_id: '11111111-1111-4111-8111-111111111111',
  user_email: 'dev@example.com',
  central_url: 'https://central.corp',
  project_secret: 'project-secret',
};

describe('centralUrlSchema (shared central_url validator)', () => {
  // TC-U-04
  it.each([
    'https://central.corp',
    'https://localhost:3232',
    'http://localhost:3232',
    'http://127.0.0.1:3232',
    'http://[::1]:3232',
  ])('TC-U-04: accepts %s (https anywhere, or http to a loopback host)', (url) => {
    expect(centralUrlSchema.safeParse(url).success).toBe(true);
  });

  // TC-U-05
  it.each(['http://central.corp', 'http://192.168.1.10:3232'])(
    'TC-U-05: rejects http to non-loopback host %s with the https message',
    (url) => {
      const result = centralUrlSchema.safeParse(url);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe(
          'central_url must use https unless the host is loopback',
        );
      }
    },
  );

  // TC-U-06
  it.each([
    'http://localhost.evil.com',
    'http://127.0.0.1.evil.com',
    'http://[::1].evil.com',
  ])(
    'TC-U-06: rejects deceptive loopback-suffix host %s (exact match, not substring)',
    (url) => {
      expect(centralUrlSchema.safeParse(url).success).toBe(false);
    },
  );
});

describe('readConfig', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  const writeRaw = (contents: string): string => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reporter-config-'));
    const file = path.join(tmpDir, 'reporter-config.json');
    fs.writeFileSync(file, contents);
    return file;
  };

  // TC-U-09: readConfig error paths — first coverage of config.ts.
  it('TC-U-09: returns null when the config file does not exist', () => {
    const missing = path.join(
      os.tmpdir(),
      `reporter-config-missing-${Date.now()}.json`,
    );
    expect(readConfig(missing)).toBeNull();
  });

  it('TC-U-09: throws a descriptive error on malformed JSON', () => {
    const file = writeRaw('{ not valid json ');
    expect(() => readConfig(file)).toThrow(/invalid JSON/);
  });

  it('TC-U-09: throws a schema-mismatch error when a required field is missing', () => {
    const incomplete = {
      key_id: 'key-1',
      secret: 'machine-secret',
      machine_id: '11111111-1111-4111-8111-111111111111',
      user_email: 'dev@example.com',
      central_url: 'https://central.corp',
      // project_secret intentionally omitted → schema mismatch
    };
    const file = writeRaw(JSON.stringify(incomplete));
    expect(() => readConfig(file)).toThrow(/schema mismatch/);
  });

  it('TC-U-09: rejects a config whose central_url is http to a non-loopback host (centralUrlSchema is wired into ReporterConfigSchema)', () => {
    const file = writeRaw(
      JSON.stringify({ ...VALID_CONFIG, central_url: 'http://central.corp' }),
    );
    expect(() => readConfig(file)).toThrow(/central_url must use https/);
  });
});
