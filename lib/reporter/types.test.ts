/**
 * Tests for the wire-protocol version constants.
 * Spec: .specs/wire-protocol-versioning.md (REQ-1).
 */
import { describe, it, expect } from 'vitest';
import {
  WIRE_VERSION,
  WIRE_VERSION_MIN,
  WIRE_VERSION_MAX,
} from './types';

describe('wire-protocol version constants', () => {
  it('exposes a coherent version range (MIN <= WIRE_VERSION <= MAX) (TC-U-01)', () => {
    expect(WIRE_VERSION).toBe(1);
    expect(WIRE_VERSION_MIN).toBe(1);
    expect(WIRE_VERSION_MAX).toBe(1);
    expect(WIRE_VERSION_MIN).toBeLessThanOrEqual(WIRE_VERSION);
    expect(WIRE_VERSION).toBeLessThanOrEqual(WIRE_VERSION_MAX);
  });
});
