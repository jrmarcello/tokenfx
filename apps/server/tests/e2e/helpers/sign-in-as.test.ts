import { describe, it, expect, vi } from 'vitest';
import { signInAs, type AddCookiesFn } from './sign-in-as';

const noopAddCookies: AddCookiesFn = async () => {};

const csrfResponse = (token: string): Response =>
  new Response(JSON.stringify({ csrfToken: token }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'set-cookie': 'authjs.csrf-token=stub-csrf; Path=/; HttpOnly',
    },
  });

const credentialsResponse = (sessionCookie: string | null): Response =>
  new Response(JSON.stringify({ url: 'http://localhost:3232/' }), {
    status: 200,
    headers: sessionCookie
      ? {
          'content-type': 'application/json',
          'set-cookie': `authjs.session-token=${sessionCookie}; Path=/; HttpOnly`,
        }
      : { 'content-type': 'application/json' },
  });

describe('signInAs', () => {
  describe('localhost guard', () => {
    it.each([
      ['https://prod.example', 'https://prod.example'],
      ['http://example.com', 'http://example.com'],
      ['https://localhost:3232', 'https://localhost:3232'],
      ['http://127.0.0.1:3232 (loopback IP — not literal "localhost")', 'http://127.0.0.1:3232'],
    ])('throws for non-http-localhost baseUrl %s', async (_label, baseUrl) => {
      const fetchSpy = vi.fn();
      await expect(
        signInAs({ addCookies: noopAddCookies }, {
          email: 'alice@alpha.test',
          baseUrl,
          fetch: fetchSpy,
        }),
      ).rejects.toThrow(/localhost-only/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('csrf failure modes', () => {
    it('throws when /api/auth/csrf returns non-200', async () => {
      const fetchStub = vi.fn(async () =>
        new Response('Internal Server Error', { status: 500 }),
      );
      await expect(
        signInAs({ addCookies: noopAddCookies }, {
          email: 'alice@alpha.test',
          fetch: fetchStub,
        }),
      ).rejects.toThrow(/csrf endpoint returned status 500/);
    });

    it('proceeds when /csrf returns csrfToken but no Set-Cookie (server omits cookie)', async () => {
      // Defensive: if the server returns csrfToken in body but no cookie,
      // helper still POSTs (NextAuth would then fail csrf validation
      // server-side and the POST returns no session-cookie → helper throws
      // with the "credentials callback returned no session cookie" message).
      // This documents the layered failure-mode chain.
      let call = 0;
      const fetchStub = vi.fn(async () => {
        call += 1;
        if (call === 1) {
          return new Response(JSON.stringify({ csrfToken: 'stub-csrf' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
            // No set-cookie header.
          });
        }
        return credentialsResponse(null); // POST: no session cookie set
      });
      await expect(
        signInAs({ addCookies: noopAddCookies }, {
          email: 'alice@alpha.test',
          fetch: fetchStub,
        }),
      ).rejects.toThrow(/credentials callback returned no session cookie/);
    });

    it('throws when /api/auth/csrf body is missing csrfToken', async () => {
      const fetchStub = vi.fn(async () =>
        new Response(JSON.stringify({ wrongField: 'oops' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      await expect(
        signInAs({ addCookies: noopAddCookies }, {
          email: 'alice@alpha.test',
          fetch: fetchStub,
        }),
      ).rejects.toThrow(/csrf body missing csrfToken/);
    });
  });

  describe('credentials POST failure modes', () => {
    it('throws when POST returns no session cookie', async () => {
      let call = 0;
      const fetchStub = vi.fn(async () => {
        call += 1;
        return call === 1 ? csrfResponse('stub-csrf') : credentialsResponse(null);
      });
      await expect(
        signInAs({ addCookies: noopAddCookies }, {
          email: 'alice@alpha.test',
          fetch: fetchStub,
        }),
      ).rejects.toThrow(/credentials callback returned no session cookie/);
    });
  });

  describe('network errors', () => {
    it('wraps any thrown fetch error with descriptive prefix', async () => {
      const fetchStub = vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      });
      await expect(
        signInAs({ addCookies: noopAddCookies }, {
          email: 'alice@alpha.test',
          fetch: fetchStub,
        }),
      ).rejects.toThrow(/network error: .*ECONNREFUSED/);
    });
  });

  describe('happy path', () => {
    it('on success, calls context.addCookies with the session-token', async () => {
      let call = 0;
      const fetchStub = vi.fn(async () => {
        call += 1;
        return call === 1
          ? csrfResponse('stub-csrf')
          : credentialsResponse('stub-session');
      });
      const addCookies = vi.fn<AddCookiesFn>(async () => {});
      await signInAs({ addCookies }, {
        email: 'alice@alpha.test',
        fetch: fetchStub,
      });
      expect(addCookies).toHaveBeenCalledOnce();
      const cookies = addCookies.mock.calls[0][0];
      expect(cookies).toHaveLength(1);
      expect(cookies[0]).toMatchObject({
        name: 'authjs.session-token',
        value: 'stub-session',
        url: 'http://localhost:3232',
      });
    });

    it('on success, forwards csrf cookie to credentials POST', async () => {
      let call = 0;
      let postRequest: Request | null = null;
      const fetchStub = vi.fn(async (req: RequestInfo | URL, init?: RequestInit) => {
        call += 1;
        if (call === 1) return csrfResponse('stub-csrf');
        const r = new Request(req as RequestInfo, init);
        postRequest = r;
        return credentialsResponse('stub-session');
      });
      await signInAs({ addCookies: noopAddCookies }, {
        email: 'alice@alpha.test',
        fetch: fetchStub,
      });
      expect(postRequest).not.toBeNull();
      const cookieHeader = postRequest!.headers.get('cookie') ?? '';
      expect(cookieHeader).toMatch(/authjs\.csrf-token=stub-csrf/);
    });
  });
});
