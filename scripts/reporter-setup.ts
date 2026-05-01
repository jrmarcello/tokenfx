/**
 * Reporter setup CLI — onboarding flow for the central server.
 *
 * Layered into:
 *  - **Pure helpers** (TASK-11a): parsing, URL resolution, error mapping,
 *    input precedence. No I/O, fully unit-testable.
 *  - **Integration helpers** (TASK-11b): preflight HTTP probe, atomic
 *    config write, redeem call, orchestration. I/O is injected as params
 *    so tests can substitute hand-written stubs.
 *  - **`main()`**: thin wrapper that wires `process.argv`/`process.env`
 *    to the orchestrator.
 *
 * REQs covered: REQ-30..REQ-36 (onboarding CLI surface).
 */

import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

// ---------------------------------------------------------------------------
// REQ-30 — input parsing
// ---------------------------------------------------------------------------

const HEX_64 = /^[0-9a-f]{64}$/;

export type OnboardingInputParse = {
  token: string | null;
  central_url: string | null;
};

/**
 * Parse the user-supplied onboarding input.
 *
 * Accepts:
 *  - URL with `#token=XXX` fragment    -> returns { token, central_url }
 *  - URL with `?token=XXX` legacy query -> returns { token, central_url }
 *  - URL without a token               -> returns { token: null, central_url }
 *  - Bare 64-char hex token            -> returns { token, central_url: null }
 *  - Anything else                     -> returns { token: null, central_url: null }
 *
 * NOTE: this function is non-throwing (Result-shaped via { token, central_url }
 * - both nullable). Callers decide what to prompt for next.
 */
export const parseOnboardingInput = (raw: string): OnboardingInputParse => {
  const trimmed = raw.trim();
  if (trimmed === '') return { token: null, central_url: null };

  // Bare 64-char hex token (no scheme, no slash).
  if (HEX_64.test(trimmed)) {
    return { token: trimmed, central_url: null };
  }

  // Try parsing as URL.
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { token: null, central_url: null };
  }

  // Reject non-http(s) schemes — file://, javascript:, etc.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { token: null, central_url: null };
  }

  // Origin = scheme + host + port (no path / query / fragment).
  const central_url = parsed.origin;

  // 1) Try fragment: #token=XXX
  const fragment = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash;
  const fragmentParams = new URLSearchParams(fragment);
  const fragToken = fragmentParams.get('token');
  if (fragToken !== null && fragToken !== '') {
    return { token: fragToken, central_url };
  }

  // 2) Try legacy query: ?token=XXX
  const queryToken = parsed.searchParams.get('token');
  if (queryToken !== null && queryToken !== '') {
    return { token: queryToken, central_url };
  }

  // 3) URL without a token — fall through to bare-token prompt.
  return { token: null, central_url };
};

// ---------------------------------------------------------------------------
// REQ-31 — TLS enforcement / URL precedence
// ---------------------------------------------------------------------------

export type ResolveCentralUrlInput = {
  flagUrl: string | null;
  envUrl: string | null;
  parsedUrl: string | null;
  allowHttp: boolean;
};

export type ResolveCentralUrlResult = { url: string } | { error: string };

/**
 * Resolve the central URL with precedence: flag > env > parsed (URL captured
 * via fragment/query). TLS enforcement: refuses non-https unless allowHttp
 * is true (dev-only).
 */
export const resolveCentralUrl = (
  input: ResolveCentralUrlInput,
): ResolveCentralUrlResult => {
  const candidate = input.flagUrl ?? input.envUrl ?? input.parsedUrl;
  if (candidate === null || candidate === '') {
    return { error: 'Central URL ausente. Forneça via --central-url, TOKENFX_ONBOARD_CENTRAL_URL ou inclua-a na URL de onboarding.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { error: `URL inválida: ${candidate}` };
  }

  if (parsed.protocol === 'https:') {
    return { url: parsed.origin };
  }

  if (parsed.protocol === 'http:') {
    if (input.allowHttp) {
      return { url: parsed.origin };
    }
    return {
      error: 'Onboarding requires HTTPS. Use --allow-http only for localhost development.',
    };
  }

  return { error: `Esquema inválido: ${parsed.protocol} (apenas http/https são suportados).` };
};

// ---------------------------------------------------------------------------
// REQ-36 — error message mapping
// ---------------------------------------------------------------------------

/**
 * Map a redeem-endpoint response status to the canonical Portuguese error
 * string. status=0 indicates a network/timeout failure (no response).
 */
export const mapRedeemResponseToError = (
  status: number,
  retryAfter?: string,
  centralUrl?: string,
  details?: string,
): string => {
  if (status === 0) {
    const url = centralUrl ?? '<central_url>';
    return `Não foi possível alcançar ${url}. Verifique o URL e sua conexão.`;
  }
  if (status === 400) {
    const suffix = details !== undefined && details !== '' ? details : 'campos inválidos';
    return `Pedido malformado: ${suffix}`;
  }
  if (status === 401) {
    return 'Token inválido, expirado, exaurido ou revogado. Peça um novo convite ao seu manager.';
  }
  if (status === 429) {
    if (retryAfter !== undefined && retryAfter !== '') {
      return `Espere ${retryAfter}s e tente de novo.`;
    }
    return 'Muitas tentativas. Aguarde alguns segundos e tente de novo.';
  }
  if (status === 500) {
    return 'Erro no servidor. Contate seu manager.';
  }
  // Unknown status — fall back to generic.
  return `Erro inesperado do servidor (HTTP ${status}). Contate seu manager.`;
};

// ---------------------------------------------------------------------------
// REQ-30 — default email from `git config user.email`
// ---------------------------------------------------------------------------

export type ExecSyncFn = (cmd: string) => string;

/**
 * Read `git config user.email`. Returns null if git exits non-zero (no repo
 * / git not installed) or if the output is empty/whitespace.
 *
 * The execSync is injected as a parameter so tests can stub it without a
 * mocking framework (project convention: hand-written stubs).
 */
export const loadDefaultEmail = (
  exec: ExecSyncFn = (cmd: string) => execSync(cmd, { encoding: 'utf8' }),
): string | null => {
  let raw: string;
  try {
    raw = exec('git config user.email');
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
};

// ---------------------------------------------------------------------------
// REQ-33 — output sanitization
// ---------------------------------------------------------------------------

/**
 * The canonical post-success log line. Contains zero references to the
 * secret or key_id — TC-U-21 asserts byte-absence of either.
 */
export const formatSuccessMessage = (): string =>
  'Reporter configurado. Rode `pnpm reporter:run` para enviar o primeiro batch.';

// ---------------------------------------------------------------------------
// REQ-35 — flag/env/prompt precedence resolver
// ---------------------------------------------------------------------------

export type ResolveInputsArgs = {
  argv: readonly string[];
  env: Record<string, string | undefined>;
};

export type ResolveInputsResult = {
  mode: 'interactive' | 'non-interactive';
  token: string | null;
  email: string | null;
  centralUrl: string | null;
  allowHttp: boolean;
  force: boolean;
  errors: readonly string[];
};

/**
 * Extract the value of a `--flag=value` argument. Returns null if the flag
 * is not present. Boolean flags (no `=`) are NOT handled here.
 */
const extractFlagValue = (argv: readonly string[], flag: string): string | null => {
  const prefix = `${flag}=`;
  for (const arg of argv) {
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return null;
};

const hasFlag = (argv: readonly string[], flag: string): boolean =>
  argv.includes(flag);

/**
 * Resolve token / email / centralUrl from flags + env vars. Precedence:
 * flag > env > prompt (prompt resolution lives in main()).
 *
 * If --token is itself an onboarding URL, parseOnboardingInput is applied
 * and the embedded central_url participates in the central URL precedence.
 */
export const resolveInputs = (args: ResolveInputsArgs): ResolveInputsResult => {
  const { argv, env } = args;
  const nonInteractive = hasFlag(argv, '--non-interactive');
  const allowHttp = hasFlag(argv, '--allow-http');
  const force = hasFlag(argv, '--force');

  const tokenFlag = extractFlagValue(argv, '--token');
  const emailFlag = extractFlagValue(argv, '--email');
  const centralUrlFlag = extractFlagValue(argv, '--central-url');

  // If --token is a URL, parse it for embedded token + central_url.
  let parsedToken: string | null = null;
  let parsedCentralUrl: string | null = null;
  if (tokenFlag !== null) {
    const parsed = parseOnboardingInput(tokenFlag);
    parsedToken = parsed.token;
    parsedCentralUrl = parsed.central_url;
  }

  const tokenEnv = env.TOKENFX_ONBOARD_TOKEN ?? null;
  const emailEnv = env.TOKENFX_ONBOARD_EMAIL ?? null;
  const centralUrlEnv = env.TOKENFX_ONBOARD_CENTRAL_URL ?? null;

  const token = parsedToken ?? tokenFlag ?? tokenEnv ?? null;
  const email = emailFlag ?? emailEnv ?? null;
  const centralUrl = centralUrlFlag ?? centralUrlEnv ?? parsedCentralUrl ?? null;

  const errors: string[] = [];
  if (nonInteractive) {
    if (token === null || token === '') errors.push('--non-interactive: missing token (use --token=<64hex> or TOKENFX_ONBOARD_TOKEN).');
    if (email === null || email === '') errors.push('--non-interactive: missing email (use --email=<addr> or TOKENFX_ONBOARD_EMAIL).');
    if (centralUrl === null || centralUrl === '') errors.push('--non-interactive: missing central-url (use --central-url=<https://…> or TOKENFX_ONBOARD_CENTRAL_URL).');
  }

  // Mode is "non-interactive" when either the flag is set OR all three inputs
  // are already resolved (no prompts would fire — REQ-35 "If all three
  // sources present (flag/env/prompt), no prompts fire").
  const allResolved =
    token !== null && token !== '' &&
    email !== null && email !== '' &&
    centralUrl !== null && centralUrl !== '';
  const mode: 'interactive' | 'non-interactive' =
    nonInteractive || allResolved ? 'non-interactive' : 'interactive';

  return {
    mode,
    token,
    email,
    centralUrl,
    allowHttp,
    force,
    errors,
  };
};

// ===========================================================================
// TASK-11b — Integration helpers (preflight + atomic write + redeem call)
// ===========================================================================

// ---------------------------------------------------------------------------
// REQ-32 — pre-flight check against /api/health
// ---------------------------------------------------------------------------

/**
 * Shape of the persisted reporter-config.json file. Mirrors `reporter-config-init.ts`.
 * `project_secret` is generated at setup time (REQ-34).
 */
export type ReporterConfig = {
  key_id: string;
  secret: string;
  machine_id: string;
  user_email: string;
  central_url: string;
  project_secret: string;
};

export type PreflightOutcome =
  | { kind: 'no-existing-config' }
  | { kind: 'existing-valid' } // /api/health 200 — refuse unless --force
  | { kind: 'existing-invalid' } // /api/health 401 — proceed automatically
  | { kind: 'unreachable'; detail: string }; // network failure — exit 1 unless --force

/**
 * Minimal fetch-shaped surface used for testing. The real implementation is
 * the global `fetch` from Node 22+. Stubs return only the fields we read.
 */
export type MinimalFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ status: number; text: () => Promise<string>; headers: { get: (name: string) => string | null } }>;

export type PreflightDeps = {
  readFile: (p: string) => Promise<string>;
  fileExists: (p: string) => Promise<boolean>;
  fetchFn: MinimalFetch;
};

/**
 * Hit `GET ${central_url}/api/health?key_id=<id>` with a Bearer of the
 * persisted secret. 200 -> existing-valid. 401 -> existing-invalid.
 * Anything else (network error, 5xx, malformed JSON) -> unreachable.
 *
 * Returning a discriminated union keeps the orchestrator simple and lets
 * callers map outcomes to user-facing copy without re-running fetch.
 */
export const preflightExistingConfig = async (
  configPath: string,
  deps: PreflightDeps,
): Promise<PreflightOutcome> => {
  const exists = await deps.fileExists(configPath);
  if (!exists) return { kind: 'no-existing-config' };

  let raw: string;
  try {
    raw = await deps.readFile(configPath);
  } catch (err) {
    return { kind: 'unreachable', detail: `read config failed: ${(err as Error).message}` };
  }

  let parsed: { key_id?: unknown; secret?: unknown; central_url?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Existing file but unparseable — treat as invalid so we overwrite without --force.
    return { kind: 'existing-invalid' };
  }

  const keyId = typeof parsed.key_id === 'string' ? parsed.key_id : null;
  const secret = typeof parsed.secret === 'string' ? parsed.secret : null;
  const centralUrl = typeof parsed.central_url === 'string' ? parsed.central_url : null;

  if (keyId === null || secret === null || centralUrl === null) {
    return { kind: 'existing-invalid' };
  }

  let resp;
  try {
    resp = await deps.fetchFn(`${centralUrl}/api/health?key_id=${encodeURIComponent(keyId)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${secret}` },
    });
  } catch (err) {
    return { kind: 'unreachable', detail: (err as Error).message };
  }

  if (resp.status === 200) return { kind: 'existing-valid' };
  if (resp.status === 401) return { kind: 'existing-invalid' };
  return { kind: 'unreachable', detail: `unexpected status ${resp.status}` };
};

// ---------------------------------------------------------------------------
// REQ-34 — atomic config write (tmp + fsync + rename, mode 0600)
// ---------------------------------------------------------------------------

export type AtomicWriteDeps = {
  /** Open + write + fsync + close. Caller controls atomicity at filehandle level. */
  writeAndSync: (filePath: string, data: string, mode: number) => Promise<void>;
  /** rename(2). On failure the existing target file is left untouched. */
  rename: (from: string, to: string) => Promise<void>;
  /** Best-effort cleanup of the tmp file when rename fails. Errors swallowed. */
  unlinkIgnoreMissing: (filePath: string) => Promise<void>;
};

export const defaultAtomicWriteDeps: AtomicWriteDeps = {
  writeAndSync: async (filePath, data, mode) => {
    // Open with create+truncate+exclusive-of-other-writes-to-this-fh, write,
    // fsync, then close. fsync ensures the bytes hit disk before the rename
    // races with a power loss — REQ-34's "no partial write" guarantee.
    const fh = await fs.open(filePath, 'w', mode);
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
  },
  rename: (from, to) => fs.rename(from, to),
  unlinkIgnoreMissing: async (filePath) => {
    try {
      await fs.unlink(filePath);
    } catch {
      // missing tmp is fine — caller doesn't need to know
    }
  },
};

/**
 * Atomically write the reporter config: write to `<target>.tmp` with mode
 * 0600 + fsync, then rename to `<target>`. On rename failure, the previous
 * `<target>` (if any) is left untouched and the tmp file is removed.
 *
 * Throws on any filesystem error. The error message is sanitized — it
 * contains paths but never the secret/key_id (REQ-33).
 */
export const atomicWriteConfig = async (
  targetPath: string,
  config: ReporterConfig,
  deps: AtomicWriteDeps = defaultAtomicWriteDeps,
): Promise<void> => {
  const tmpPath = `${targetPath}.tmp`;
  const json = JSON.stringify(config, null, 2);

  // Ensure parent dir exists. If not, fail loudly — REQ-34 says "no partial
  // write" and the caller (TC-I-73 stub) treats a non-writable data/ as fatal.
  const parent = path.dirname(targetPath);
  await fs.mkdir(parent, { recursive: true });

  await deps.writeAndSync(tmpPath, json, 0o600);

  try {
    await deps.rename(tmpPath, targetPath);
  } catch (err) {
    // Cleanup the tmp file so it doesn't accumulate; do not swallow the
    // original error — caller decides whether to retry / surface it.
    await deps.unlinkIgnoreMissing(tmpPath);
    throw new Error(`Falha ao gravar config: ${(err as Error).message}`, { cause: err });
  }
};

// ---------------------------------------------------------------------------
// HTTP redeem call
// ---------------------------------------------------------------------------

export type RedeemRequest = {
  centralUrl: string;
  token: string;
  machineId: string;
  hostname: string;
  claimedEmail: string;
};

export type RedeemSuccess = {
  ok: true;
  key_id: string;
  secret: string;
  central_url: string;
  user_email: string;
};

export type RedeemFailure = {
  ok: false;
  /** HTTP status, or 0 on network/timeout failure. */
  status: number;
  retryAfter?: string;
  details?: string;
};

export type RedeemResult = RedeemSuccess | RedeemFailure;

const REDEEM_RESPONSE_SCHEMA_FIELDS = ['key_id', 'secret', 'central_url', 'user_email'] as const;

/**
 * POST `${centralUrl}/api/onboarding/redeem-invite` with the redeem body.
 * On 2xx, parse the JSON body and return RedeemSuccess. On non-2xx or
 * network failure, return RedeemFailure with the status (0 = network) and
 * optional Retry-After header.
 *
 * The response body is parsed leniently — we never trust attacker-controlled
 * shape. Only the four expected string fields are extracted.
 */
export const callRedeem = async (
  req: RedeemRequest,
  fetchFn: MinimalFetch,
): Promise<RedeemResult> => {
  let resp;
  try {
    resp = await fetchFn(`${req.centralUrl}/api/onboarding/redeem-invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: req.token,
        machine_id: req.machineId,
        hostname: req.hostname,
        claimed_email: req.claimedEmail,
      }),
    });
  } catch (err) {
    return { ok: false, status: 0, details: (err as Error).message };
  }

  if (resp.status >= 200 && resp.status < 300) {
    const text = await resp.text();
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { ok: false, status: resp.status, details: 'malformed response body' };
    }

    for (const field of REDEEM_RESPONSE_SCHEMA_FIELDS) {
      if (typeof json[field] !== 'string' || (json[field] as string).length === 0) {
        return { ok: false, status: resp.status, details: `missing field ${field}` };
      }
    }

    return {
      ok: true,
      key_id: json.key_id as string,
      secret: json.secret as string,
      central_url: json.central_url as string,
      user_email: json.user_email as string,
    };
  }

  // Non-2xx — try to extract details for 400.
  let details: string | undefined;
  try {
    const text = await resp.text();
    if (text !== '') {
      const parsed = JSON.parse(text) as { error?: { message?: unknown } };
      const msg = parsed.error?.message;
      if (typeof msg === 'string') details = msg;
    }
  } catch {
    // ignore — body might be empty or non-JSON
  }

  const retryAfter = resp.headers.get('Retry-After') ?? undefined;
  return { ok: false, status: resp.status, retryAfter, details };
};

// ---------------------------------------------------------------------------
// Orchestrator (composes preflight + redeem + atomic write)
// ---------------------------------------------------------------------------

export type OrchestratorDeps = {
  readFile: (p: string) => Promise<string>;
  fileExists: (p: string) => Promise<boolean>;
  fetchFn: MinimalFetch;
  writeDeps: AtomicWriteDeps;
  randomHex: (bytes: number) => string;
  /** Hostname for the redeem request (machine identification). */
  hostname: () => string;
  /** UUID v4 for machine_id. */
  generateMachineId: () => string;
  /** Process stderr writer — kept injectable so tests can capture. */
  stderr: (line: string) => void;
  /** Process stdout writer — kept injectable so tests can capture. */
  stdout: (line: string) => void;
};

export type OrchestratorInput = {
  token: string;
  email: string;
  centralUrl: string;
  force: boolean;
  configPath: string;
};

export type OrchestratorResult =
  | { ok: true }
  | { ok: false; exitCode: number };

/**
 * Run the full setup flow given already-resolved inputs. The interactive
 * prompt loop runs BEFORE this function — by the time we get here, token,
 * email, and centralUrl are all known.
 *
 * Returns `{ ok: true }` on success (config written) or `{ ok: false, exitCode }`
 * on any failure. Does not call `process.exit` — main() owns that.
 *
 * Output discipline (REQ-33): we only ever write the canonical success
 * message OR an error message. Neither contains secret/key_id.
 */
export const runOnboarding = async (
  inputArgs: OrchestratorInput,
  deps: OrchestratorDeps,
): Promise<OrchestratorResult> => {
  // 0) Loud warning when --allow-http is in effect (REQ-31 defense-in-depth).
  // The user opted in to plaintext; surface that loudly so a CI accidentally
  // configured with --allow-http leaves an audit signal in the run logs.
  if (inputArgs.centralUrl.startsWith('http://')) {
    deps.stderr(
      'WARNING: --allow-http enabled — onboarding over plaintext HTTP. ' +
        'Use only for localhost development; never in production.\n',
    );
  }

  // 1) Pre-flight (REQ-32).
  const preflight = await preflightExistingConfig(inputArgs.configPath, {
    readFile: deps.readFile,
    fileExists: deps.fileExists,
    fetchFn: deps.fetchFn,
  });

  if (preflight.kind === 'existing-valid' && !inputArgs.force) {
    deps.stderr(
      'Configuração válida já existe para este reporter. Use `--force` para sobrescrever (rotação de credenciais).\n',
    );
    return { ok: false, exitCode: 1 };
  }

  if (preflight.kind === 'existing-invalid') {
    // 401 from /api/health — proceed automatically per REQ-32.
    deps.stderr('Configuração existente inválida. Sobrescrevendo automaticamente.\n');
  }

  if (preflight.kind === 'unreachable' && !inputArgs.force) {
    deps.stderr(
      'Não foi possível verificar configuração existente. Use `--force` se tem certeza.\n',
    );
    return { ok: false, exitCode: 1 };
  }

  // 2) Redeem (REQ-26..28 + REQ-36 mapping).
  const machineId = deps.generateMachineId();
  const redeem = await callRedeem(
    {
      centralUrl: inputArgs.centralUrl,
      token: inputArgs.token,
      machineId,
      hostname: deps.hostname(),
      claimedEmail: inputArgs.email,
    },
    deps.fetchFn,
  );

  if (!redeem.ok) {
    const msg = mapRedeemResponseToError(redeem.status, redeem.retryAfter, inputArgs.centralUrl, redeem.details);
    deps.stderr(`${msg}\n`);
    return { ok: false, exitCode: 1 };
  }

  // 3) Atomic config write (REQ-34).
  const projectSecret = deps.randomHex(32);
  const config: ReporterConfig = {
    key_id: redeem.key_id,
    secret: redeem.secret,
    machine_id: machineId,
    user_email: redeem.user_email,
    central_url: redeem.central_url,
    project_secret: projectSecret,
  };

  try {
    await atomicWriteConfig(inputArgs.configPath, config, deps.writeDeps);
  } catch (err) {
    // REQ-33: never surface secret/key_id in error output. The error
    // message contains only filesystem paths + cause.
    deps.stderr(`Falha ao gravar config: ${(err as Error).message}\n`);
    return { ok: false, exitCode: 1 };
  }

  // 4) Success log (REQ-33 — canonical, no leak).
  deps.stdout(`${formatSuccessMessage()}\n`);
  return { ok: true };
};

// ---------------------------------------------------------------------------
// Interactive prompt loop (REQ-30)
// ---------------------------------------------------------------------------

export type PromptDeps = {
  /** Returns trimmed line; null on EOF. */
  ask: (question: string) => Promise<string>;
  loadDefaultEmail: () => string | null;
};

export type PromptResolved = {
  token: string;
  email: string;
  centralUrl: string;
};

export type PromptError = { error: string };

/**
 * Drive the 2-3 prompt sequence (REQ-30). Caller passes already-resolved
 * inputs (from flags/env); we only prompt for what is missing.
 */
export const runPromptLoop = async (
  partial: { token: string | null; email: string | null; centralUrl: string | null; allowHttp: boolean },
  deps: PromptDeps,
): Promise<PromptResolved | PromptError> => {
  let token = partial.token;
  let centralUrl = partial.centralUrl;
  let email = partial.email;

  if (token === null || token === '' || centralUrl === null || centralUrl === '') {
    const raw = await deps.ask('Onboarding URL or token: ');
    const parsed = parseOnboardingInput(raw);
    if (token === null || token === '') token = parsed.token;
    if (centralUrl === null || centralUrl === '') centralUrl = parsed.central_url;

    // If still no central_url AND token is bare hex, prompt separately.
    if ((centralUrl === null || centralUrl === '') && token !== null && HEX_64.test(token)) {
      const url = await deps.ask('Central server URL (https://…): ');
      centralUrl = url.trim() === '' ? null : url.trim();
    }
  }

  if (email === null || email === '') {
    const fallback = deps.loadDefaultEmail() ?? '';
    const display = fallback === '' ? '' : ` [${fallback}]`;
    const raw = await deps.ask(`Your work email${display}: `);
    const trimmed = raw.trim();
    email = trimmed === '' ? fallback : trimmed;
  }

  if (token === null || token === '') return { error: 'Token ausente.' };
  if (email === null || email === '') return { error: 'Email ausente.' };
  if (centralUrl === null || centralUrl === '') {
    return { error: 'Central URL ausente.' };
  }

  // Apply TLS check to the prompted URL too.
  const urlResult = resolveCentralUrl({
    flagUrl: null,
    envUrl: null,
    parsedUrl: centralUrl,
    allowHttp: partial.allowHttp,
  });
  if ('error' in urlResult) return { error: urlResult.error };

  return { token, email, centralUrl: urlResult.url };
};

// ---------------------------------------------------------------------------
// CLI entry — wires process.argv/env to the orchestrator
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), 'data/reporter-config.json');

/**
 * Real-world default deps. Tests construct their own.
 */
const buildDefaultDeps = (): OrchestratorDeps => ({
  readFile: (p) => fs.readFile(p, 'utf-8'),
  fileExists: async (p) => {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  },
  fetchFn: async (url, init) => {
    const r = await fetch(url, init);
    return {
      status: r.status,
      text: () => r.text(),
      headers: { get: (name) => r.headers.get(name) },
    };
  },
  writeDeps: defaultAtomicWriteDeps,
  randomHex: (bytes) => randomBytes(bytes).toString('hex'),
  hostname: () => {
    // Lazy require to avoid pulling node:os into the test stubs.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('node:os') as typeof import('node:os');
    return os.hostname();
  },
  generateMachineId: () => {
    // crypto.randomUUID is available in Node 14.17+; stable.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const c = require('node:crypto') as typeof import('node:crypto');
    return c.randomUUID();
  },
  stderr: (s) => process.stderr.write(s),
  stdout: (s) => process.stdout.write(s),
});

/**
 * Entry point. Resolves inputs (flags/env), runs the prompt loop if needed,
 * and delegates to runOnboarding(). Errors map to exit codes, never throws.
 */
export const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  const env = process.env;

  const resolved = resolveInputs({ argv, env });

  if (resolved.errors.length > 0) {
    for (const err of resolved.errors) {
      process.stderr.write(`${err}\n`);
    }
    process.exit(1);
    return;
  }

  // Resolve the central URL from flag/env early so the TLS check fires
  // before we touch the network.
  if (resolved.centralUrl !== null && resolved.centralUrl !== '') {
    const urlResult = resolveCentralUrl({
      flagUrl: null,
      envUrl: null,
      parsedUrl: resolved.centralUrl,
      allowHttp: resolved.allowHttp,
    });
    if ('error' in urlResult) {
      process.stderr.write(`${urlResult.error}\n`);
      process.exit(1);
      return;
    }
  }

  let token = resolved.token;
  let email = resolved.email;
  let centralUrl = resolved.centralUrl;

  // Interactive prompts (REQ-30) — only when mode is 'interactive'.
  if (resolved.mode === 'interactive') {
    const rl = readline.createInterface({ input, output });
    try {
      const promptResult = await runPromptLoop(
        { token, email, centralUrl, allowHttp: resolved.allowHttp },
        {
          ask: (q) => rl.question(q),
          loadDefaultEmail: () => loadDefaultEmail(),
        },
      );
      if ('error' in promptResult) {
        process.stderr.write(`${promptResult.error}\n`);
        process.exit(1);
        return;
      }
      token = promptResult.token;
      email = promptResult.email;
      centralUrl = promptResult.centralUrl;
    } finally {
      rl.close();
    }
  }

  if (token === null || email === null || centralUrl === null) {
    process.stderr.write('Inputs incompletos após resolução.\n');
    process.exit(1);
    return;
  }

  const result = await runOnboarding(
    {
      token,
      email,
      centralUrl,
      force: resolved.force,
      configPath: DEFAULT_CONFIG_PATH,
    },
    buildDefaultDeps(),
  );

  if (!result.ok) {
    process.exit(result.exitCode);
    return;
  }
  process.exit(0);
};

// Run main() only when executed via tsx (not when imported by tests).
const isDirectRun = (() => {
  if (typeof process === 'undefined') return false;
  const entry = process.argv[1];
  if (entry === undefined) return false;
  // Works for both tsx (resolves to .ts) and compiled Node runs (.js).
  return entry.endsWith('reporter-setup.ts') || entry.endsWith('reporter-setup.js');
})();

if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`reporter:setup falhou: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
