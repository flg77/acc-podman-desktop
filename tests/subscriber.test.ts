/**
 * Subscriber wire-format decode tests.
 *
 * The full NATS connection lifecycle is tested manually against
 * a live broker; here we cover the pure decode path so wire-format
 * drift on the runtime side surfaces as a unit failure rather than
 * a silently-empty dashboard.
 */

import { describe, it, expect } from 'vitest';
import { encode as msgpackEncode } from '@msgpack/msgpack';

import { decodeFrame } from '../src/cluster/subscriber';


describe('decodeFrame', () => {
  it('decodes the canonical msgpack(json bytes) wrapping', () => {
    const inner = JSON.stringify({
      signal_type: 'TASK_PROGRESS',
      cluster_id: 'c-abc',
      agent_id: 'm-1',
    });
    const innerBytes = new TextEncoder().encode(inner);
    const wrapped = msgpackEncode(innerBytes);
    const result = decodeFrame(wrapped);
    expect(result).not.toBeNull();
    expect(result!['signal_type']).toBe('TASK_PROGRESS');
    expect(result!['cluster_id']).toBe('c-abc');
  });

  it('decodes a direct-msgpack-object payload (forward-compat)', () => {
    const direct = msgpackEncode({
      signal_type: 'TASK_COMPLETE',
      cluster_id: 'c-xyz',
      agent_id: 'm-1',
      blocked: false,
    });
    const result = decodeFrame(direct);
    expect(result).not.toBeNull();
    expect(result!['signal_type']).toBe('TASK_COMPLETE');
  });

  it('returns null on malformed msgpack', () => {
    const bogus = new Uint8Array([0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa]);
    expect(decodeFrame(bogus)).toBeNull();
  });

  it('returns null when the inner JSON is invalid', () => {
    const innerBytes = new TextEncoder().encode('not json');
    const wrapped = msgpackEncode(innerBytes);
    expect(decodeFrame(wrapped)).toBeNull();
  });

  it('returns null when the inner JSON parses to a primitive', () => {
    const innerBytes = new TextEncoder().encode('"a string, not an object"');
    const wrapped = msgpackEncode(innerBytes);
    expect(decodeFrame(wrapped)).toBeNull();
  });
});
