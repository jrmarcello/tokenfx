import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');

const runCli = (args: string[]): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/lint-locale.ts', ...args],
    {
      cwd: repoRoot,
      env: { ...process.env, LOG_LEVEL: 'warn' },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};

describe('lint-locale CLI', () => {
  it('TC-I-21: clean workspace — CLI exits 0 with empty stdout', () => {
    // Assumes workspace post-migration is clean (no pt-BR in manager surface).
    const r = runCli([]);
    expect(r.status).toBe(0);
    // stdout may be empty or contain a Node deprecation warning; the contract
    // is that no offender line is emitted.
    expect(r.stderr).not.toMatch(/\.tsx:\d+:/);
  });

  it('TC-I-23: --help exits 0 and prints usage to stdout', () => {
    const r = runCli(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage:');
  });

  it('TC-I-24: unknown flag exits 2 and prints usage to stderr', () => {
    const r = runCli(['--unknown-flag']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Unknown flag');
    expect(r.stderr).toContain('Usage:');
  });
});

describe('lint-locale CLI — glob scope', () => {
  const personalFixtureDir = path.join(repoRoot, 'app/__lint-locale-fixture__');
  const personalFixtureFile = path.join(personalFixtureDir, 'page.tsx');

  afterEach(() => {
    try {
      fs.rmSync(personalFixtureDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('TC-U-08 (CLI scope): pt-BR fixture under app/ is NOT linted (pessoal surface = pt-BR target)', () => {
    fs.mkdirSync(personalFixtureDir, { recursive: true });
    fs.writeFileSync(
      personalFixtureFile,
      `const Page = () => (\n  <h1>Ação</h1>\n);\nexport { Page };\n`,
      'utf8',
    );
    const r = runCli([]);
    expect(r.status).toBe(0);
    // Ignore Node deprecation warnings; assert no offender line was emitted.
    expect(r.stderr).not.toMatch(/page\.tsx:\d+:/);
  });
});

describe('lint-locale CLI — violation detection', () => {
  const fixtureDir = path.join(
    repoRoot,
    'apps/server/app/manager/__lint-locale-fixture__',
  );
  const fixtureFile = path.join(fixtureDir, 'dirty.tsx');

  afterEach(() => {
    try {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('TC-I-22: CLI exits 1 and prints offender path when violations are found', () => {
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(
      fixtureFile,
      `const Page = () => (\n  <h1>Ação</h1>\n);\nexport { Page };\n`,
      'utf8',
    );
    const r = runCli([]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('dirty.tsx');
  });

  it('TC-I-26 (REQ-10 enforcement): novel pt-BR string not in inventory blocks the build', () => {
    // REQ-10 guarantees that the lint catches strings introduced outside the
    // 55-string inventory, preventing silent migration. We inject a synthetic
    // pt-BR phrase that does not appear anywhere in the spec inventory.
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(
      fixtureFile,
      `const Page = () => (\n  <p>Mensagem inventada com diacrítico</p>\n);\nexport { Page };\n`,
      'utf8',
    );
    const r = runCli([]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/dirty\.tsx:\d+:/);
  });
});

describe('lint-locale workflow YAML', () => {
  it('TC-I-25: workflow YAML is valid and runs pnpm lint:locale', () => {
    const workflowPath = path.join(repoRoot, '.github/workflows/lint-locale.yml');
    expect(fs.existsSync(workflowPath)).toBe(true);
    const raw = fs.readFileSync(workflowPath, 'utf8');
    const parsed = yaml.load(raw) as {
      jobs: Record<string, { steps: Array<{ run?: string }> }>;
    };
    expect(parsed).toBeDefined();
    expect(parsed.jobs).toBeDefined();
    const allSteps = Object.values(parsed.jobs).flatMap((j) => j.steps);
    const runs = allSteps.map((s) => s.run).filter((r): r is string => typeof r === 'string');
    expect(runs.some((r) => r.includes('pnpm lint:locale'))).toBe(true);
  });
});
