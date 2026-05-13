import { serve } from '@hono/node-server';

import { jwksKit } from './jwks.js';
import { defaultScenarioStore } from './scenario.js';
import { createApp } from './server.js';

const port = Number(process.env.IDP_STUB_PORT ?? 3001);
const baseUrl =
  process.env.IDP_STUB_BASE_URL ?? `http://localhost:${port}`;

const app = createApp({ baseUrl, jwks: jwksKit, scenario: defaultScenarioStore });

// Loopback-bind defense (security review MEDIUM-1): even though localhost is
// the intended deployment, we explicitly pin to 127.0.0.1 so the listener
// cannot be reached from a colocated LAN attacker on the same host.
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  process.stdout.write(
    `[idp-stub] listening on http://127.0.0.1:${info.port} (baseUrl=${baseUrl})\n`,
  );
});

const shutdown = (signal: string): void => {
  process.stdout.write(`[idp-stub] received ${signal}, shutting down\n`);
  process.exit(0);
};
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
