import { serve } from '@hono/node-server';

import { jwksKit } from './jwks.js';
import { defaultScenarioStore } from './scenario.js';
import { createApp } from './server.js';

// Production boot guard (security review L6): idp-stub is a dev/test fixture
// that issues unverified OIDC tokens. Refuse to boot under NODE_ENV=production
// to prevent accidental deployment into a real environment.
export const checkBootEnv = (
  env: NodeJS.ProcessEnv,
): { allow: true } | { allow: false; reason: string } => {
  if (env.NODE_ENV === 'production') {
    return {
      allow: false,
      reason:
        'idp-stub: refusing to boot under NODE_ENV=production (dev/test only)',
    };
  }
  return { allow: true };
};

const main = (): void => {
  const decision = checkBootEnv(process.env);
  if (!decision.allow) {
    process.stderr.write(decision.reason + '\n');
    process.exit(2);
  }

  const port = Number(process.env.IDP_STUB_PORT ?? 3001);
  const baseUrl =
    process.env.IDP_STUB_BASE_URL ?? `http://localhost:${port}`;

  const app = createApp({ baseUrl, jwks: jwksKit, scenario: defaultScenarioStore });

  // Loopback-bind defense (security review MEDIUM-1): even though localhost is
  // the intended deployment, we explicitly pin to 127.0.0.1 so the listener
  // cannot be reached from a colocated LAN attacker on the same host.
  //
  // Container override (cross-stack smoke): when running inside a container
  // (docker-compose smoke profile), the listener must bind to 0.0.0.0 so the
  // container DNS name is reachable from sibling services on the docker
  // network. The override is opt-in via `IDP_STUB_HOSTNAME=0.0.0.0` env —
  // default remains 127.0.0.1 for any non-container invocation.
  const hostname = process.env.IDP_STUB_HOSTNAME ?? '127.0.0.1';
  serve({ fetch: app.fetch, port, hostname }, (info) => {
    process.stdout.write(
      `[idp-stub] listening on http://${hostname}:${info.port} (baseUrl=${baseUrl})\n`,
    );
  });

  const shutdown = (signal: string): void => {
    process.stdout.write(`[idp-stub] received ${signal}, shutting down\n`);
    process.exit(0);
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
};

// Only auto-boot when executed as the entry script — avoids starting an HTTP
// listener and registering signal handlers when this module is imported (e.g.
// from `index.test.ts`). `import.meta.main` is the standard Node ≥20.11
// idiom for "is this the main module"; cast because TS lib definitions don't
// expose it yet (lib.es2020.full.d.ts is behind Node runtime).
if ((import.meta as ImportMeta & { main?: boolean }).main === true) {
  main();
}
