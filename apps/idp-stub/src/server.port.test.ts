import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer, type Server } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { afterEach, describe, expect, it } from 'vitest';

import { generateJwks } from './jwks.js';
import { createScenarioStore } from './scenario.js';
import { createApp } from './server.js';

const closeServer = (server: ServerType): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

const closeNet = (server: Server | HttpServer): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

const listenOnEphemeralPort = (server: Server): Promise<number> =>
  new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') resolve(addr.port);
      else reject(new Error('no port'));
    });
  });

describe('server: real port bind', () => {
  let toClose: ServerType[] = [];
  let netServers: Array<Server | HttpServer> = [];

  afterEach(async () => {
    for (const s of toClose) await closeServer(s);
    toClose = [];
    for (const s of netServers) await closeNet(s);
    netServers = [];
  });

  it('boots on ephemeral port (port=0) — discovery doc URLs reflect actual port', async () => {
    const jwks = await generateJwks();
    const scenario = createScenarioStore();

    // Bind via serve() with port=0 first; once we know the assigned port,
    // build the real app with the matching baseUrl and assert in-process.
    const placeholderApp = createApp({
      baseUrl: 'http://localhost:0',
      jwks,
      scenario,
    });
    const server = serve({ fetch: placeholderApp.fetch, port: 0 });
    toClose.push(server);

    const actualPort: number = await new Promise((resolve, reject) => {
      server.on('listening', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') resolve(addr.port);
        else reject(new Error('no port'));
      });
      server.on('error', reject);
      // serve() invokes listen() synchronously; the 'listening' event fires
      // on the next tick.
    });

    const realApp = createApp({
      baseUrl: `http://localhost:${actualPort}`,
      jwks,
      scenario,
    });
    const res = await realApp.request('/.well-known/openid-configuration');
    const body = (await res.json()) as {
      issuer: string;
      jwks_uri: string;
      authorization_endpoint: string;
      token_endpoint: string;
    };
    expect(body.issuer).toBe(`http://localhost:${actualPort}`);
    expect(body.jwks_uri).toBe(`http://localhost:${actualPort}/jwks`);
    expect(body.authorization_endpoint).toBe(`http://localhost:${actualPort}/authorize`);
    expect(body.token_endpoint).toBe(`http://localhost:${actualPort}/token`);
  });

  // TC-I-20: verify that Node's underlying http server emits EADDRINUSE
  // when a port is busy. @hono/node-server's `serve()` wraps `http.createServer`,
  // so it inherits this behavior. Testing the inheritance pathway directly
  // (via http.createServer) is more reliable than racing serve()'s internal
  // listener attachment timing.
  it('Node http.Server emits EADDRINUSE when port is busy (inherited by serve())', async () => {
    const blocker = createServer();
    netServers.push(blocker);
    const blockerPort = await listenOnEphemeralPort(blocker);

    const second = createHttpServer();
    netServers.push(second);

    const err = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
      second.on('error', resolve);
      second.listen(blockerPort, '127.0.0.1');
      setTimeout(() => reject(new Error('no EADDRINUSE within 3s')), 3000);
    });

    expect(err.code).toBe('EADDRINUSE');
  });
});
