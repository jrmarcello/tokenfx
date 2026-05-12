import { describe, it, expect } from 'vitest';
import {
  getRequestContext,
  runInRequestContext,
  type RequestContext,
} from './request-context';

describe('request-context', () => {
  it('returns the stored context inside runInRequestContext', () => {
    const ctx: RequestContext = { ip: '1.2.3.4', userAgent: 'Mozilla' };
    const result = runInRequestContext(ctx, () => getRequestContext());
    expect(result).toEqual(ctx);
  });

  it('returns empty defaults when called outside any scope', () => {
    const result = getRequestContext();
    expect(result).toEqual({ ip: '', userAgent: '' });
  });

  it('inner scope overrides outer scope', () => {
    const outer: RequestContext = { ip: '1.1.1.1', userAgent: 'OuterUA' };
    const inner: RequestContext = { ip: '2.2.2.2', userAgent: 'InnerUA' };

    const result = runInRequestContext(outer, () => {
      const innerResult = runInRequestContext(inner, () => getRequestContext());
      const outerAfter = getRequestContext();
      return { innerResult, outerAfter };
    });

    expect(result.innerResult).toEqual(inner);
    expect(result.outerAfter).toEqual(outer);
  });

  it('supports async functions inside runInRequestContext', async () => {
    const ctx: RequestContext = { ip: '10.0.0.1', userAgent: 'AsyncUA' };
    const result = await runInRequestContext(ctx, async () => {
      await Promise.resolve();
      return getRequestContext();
    });
    expect(result).toEqual(ctx);
  });
});
