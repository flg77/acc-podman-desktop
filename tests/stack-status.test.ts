/**
 * Tests for the podman-ps JSON parser.
 *
 * The live `listAccContainers` is not exercised here (would require
 * a running podman daemon); the parser captures every interesting
 * decision the live wrapper makes.
 */

import { describe, it, expect } from 'vitest';

import { parsePodmanPs } from '../src/stack/status';


describe('parsePodmanPs', () => {
  it('returns [] on malformed JSON', () => {
    expect(parsePodmanPs('{ not valid')).toEqual([]);
  });

  it('returns [] when the payload is not an array', () => {
    expect(parsePodmanPs('{"foo":"bar"}')).toEqual([]);
  });

  it('filters to acc-* containers only', () => {
    const json = JSON.stringify([
      {
        Names: ['acc-redis'],
        Image: 'docker.io/redis:7',
        State: 'running',
        Status: 'Up 5 minutes',
      },
      {
        Names: ['some-other-container'],
        Image: 'foo',
        State: 'running',
      },
      {
        Names: ['acc-agent-arbiter'],
        Image: 'localhost/acc-agent-core:0.2.0',
        State: 'running',
        Status: 'Up 2 minutes',
      },
    ]);
    const result = parsePodmanPs(json);
    expect(result.map((c) => c.name)).toEqual(['acc-agent-arbiter', 'acc-redis']);
  });

  it('tolerates missing optional fields', () => {
    const json = JSON.stringify([
      { Names: ['acc-redis'] },
    ]);
    const [c] = parsePodmanPs(json);
    expect(c?.name).toBe('acc-redis');
    expect(c?.image).toBe('');
    expect(c?.state).toBe('unknown');
    expect(c?.status).toBe('');
    expect(c?.startedAt).toBe(0);
  });

  it('passes through StartedAt as a number', () => {
    const json = JSON.stringify([
      {
        Names: ['acc-nats'],
        State: 'running',
        StartedAt: 1_700_000_000,
      },
    ]);
    const [c] = parsePodmanPs(json);
    expect(c?.startedAt).toBe(1_700_000_000);
  });

  it('returns containers sorted by name', () => {
    const json = JSON.stringify([
      { Names: ['acc-redis'], State: 'running' },
      { Names: ['acc-agent-arbiter'], State: 'running' },
      { Names: ['acc-nats'], State: 'running' },
    ]);
    const result = parsePodmanPs(json);
    expect(result.map((c) => c.name)).toEqual([
      'acc-agent-arbiter', 'acc-nats', 'acc-redis',
    ]);
  });
});
