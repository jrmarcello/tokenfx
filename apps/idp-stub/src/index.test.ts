import { describe, expect, it } from 'vitest';

import { checkBootEnv } from './index.js';

describe('checkBootEnv', () => {
  it('refuses to boot under NODE_ENV=production', () => {
    const result = checkBootEnv({ NODE_ENV: 'production' });
    expect(result.allow).toBe(false);
    if (!result.allow) {
      expect(result.reason).toBe(
        'idp-stub: refusing to boot under NODE_ENV=production (dev/test only)',
      );
    }
  });

  it.each([
    ['test', { NODE_ENV: 'test' } as NodeJS.ProcessEnv],
    ['development', { NODE_ENV: 'development' } as NodeJS.ProcessEnv],
    ['undefined', {} as NodeJS.ProcessEnv],
    // Empty-string NODE_ENV is not type-valid (ProcessEnv constrains it) but
    // can occur at runtime if a caller sets `NODE_ENV=` explicitly. Cast via
    // unknown to bypass the type guard and exercise the runtime branch.
    ['empty string', { NODE_ENV: '' } as unknown as NodeJS.ProcessEnv],
  ])('allows boot when NODE_ENV=%s', (_label, env) => {
    const result = checkBootEnv(env);
    expect(result.allow).toBe(true);
  });
});
