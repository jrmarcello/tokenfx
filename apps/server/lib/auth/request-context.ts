import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request context propagated via `AsyncLocalStorage` so deep callbacks
 * (e.g. the NextAuth `signIn` callback, which has no access to the
 * incoming `Request`) can still read upstream-populated `ip` / `userAgent`.
 *
 * Populated by the route handler (or middleware) at the request boundary
 * via {@link runInRequestContext}; consumed downstream via {@link getRequestContext}.
 *
 * DO NOT call {@link getRequestContext} from Server Components or
 * `lib/queries/*` — those paths are not guaranteed to run inside an ALS
 * scope, and silent empty defaults would mask the bug.
 */
export type RequestContext = {
  ip: string;
  userAgent: string;
};

export const requestContext = new AsyncLocalStorage<RequestContext>();

const EMPTY_CONTEXT: RequestContext = { ip: '', userAgent: '' };

/**
 * Run `fn` inside an ALS scope where `getRequestContext()` returns `ctx`.
 *
 * Thin wrapper over `AsyncLocalStorage#run`. Overloaded so sync callbacks
 * preserve a non-Promise return type and async callbacks return `Promise<T>`.
 */
export function runInRequestContext<T>(
  ctx: RequestContext,
  fn: () => Promise<T>,
): Promise<T>;
export function runInRequestContext<T>(ctx: RequestContext, fn: () => T): T;
export function runInRequestContext<T>(
  ctx: RequestContext,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return requestContext.run(ctx, fn);
}

/**
 * Read the current request context. Returns `{ ip: '', userAgent: '' }`
 * when called outside any {@link runInRequestContext} scope (no throw).
 *
 * DO NOT call from Server Components or `lib/queries/*`.
 */
export const getRequestContext = (): RequestContext =>
  requestContext.getStore() ?? EMPTY_CONTEXT;
