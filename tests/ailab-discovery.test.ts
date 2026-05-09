/**
 * Pure-fn parser tests for AI Lab discovery.
 *
 * `discoverModelServices()` (the live wrapper that does HTTP +
 * podman ps) is not exercised here — both parser surfaces are.
 */

import { describe, expect, it } from 'vitest';

import {
  parseAiLabPs,
  parsePodmanPsForAiLab,
} from '../src/ailab/discovery';


describe('parseAiLabPs', () => {
  it('returns [] on malformed JSON', () => {
    expect(parseAiLabPs('{ not valid')).toEqual([]);
  });

  it('returns [] when the payload is not an array or {servers: [...]}', () => {
    expect(parseAiLabPs('"hello"')).toEqual([]);
    expect(parseAiLabPs('{"foo":"bar"}')).toEqual([]);
  });

  it('reads canonical `[{port, modelName, ...}]` shape', () => {
    const json = JSON.stringify([
      {
        serverId: 'svc-1',
        port: 8501,
        modelName: 'qwen3-1.7b',
        status: 'running',
        containerId: 'abc123',
      },
    ]);
    const result = parseAiLabPs(json);
    expect(result).toEqual([
      {
        id: 'svc-1',
        label: 'qwen3-1.7b',
        baseUrl: 'http://localhost:8501/v1',
        port: 8501,
        source: 'ai-lab-api',
        modelName: 'qwen3-1.7b',
      },
    ]);
  });

  it('accepts the {servers: [...]} wrapper shape', () => {
    const json = JSON.stringify({
      servers: [
        { port: 8000, modelName: 'llama-3.2-1b' },
      ],
    });
    const result = parseAiLabPs(json);
    expect(result).toHaveLength(1);
    expect(result[0]?.baseUrl).toBe('http://localhost:8000/v1');
  });

  it('filters out non-running services', () => {
    const json = JSON.stringify([
      { port: 8000, modelName: 'a', status: 'running' },
      { port: 8001, modelName: 'b', status: 'stopped' },
      { port: 8002, modelName: 'c' /* missing status — included */ },
    ]);
    const result = parseAiLabPs(json);
    expect(result.map((s) => s.label)).toEqual(['a', 'c']);
  });

  it('drops entries without a valid port', () => {
    const json = JSON.stringify([
      { port: 0, modelName: 'a' },
      { port: 'not-a-port', modelName: 'b' },
      { modelName: 'c' /* no port */ },
      { port: 9999, modelName: 'd' },
    ]);
    const result = parseAiLabPs(json);
    expect(result.map((s) => s.label)).toEqual(['d']);
  });

  it('falls back label → id when modelName is missing', () => {
    const json = JSON.stringify([
      { serverId: 'svc-x', port: 8000 },
    ]);
    const result = parseAiLabPs(json);
    expect(result[0]?.label).toBe('svc-x');
    expect(result[0]?.modelName).toBeUndefined();
  });

  it('sorts by label', () => {
    const json = JSON.stringify([
      { port: 8001, modelName: 'zeta' },
      { port: 8002, modelName: 'alpha' },
      { port: 8003, modelName: 'mu' },
    ]);
    const result = parseAiLabPs(json);
    expect(result.map((s) => s.label)).toEqual(['alpha', 'mu', 'zeta']);
  });
});


describe('parsePodmanPsForAiLab', () => {
  it('returns [] on malformed JSON', () => {
    expect(parsePodmanPsForAiLab('not json')).toEqual([]);
  });

  it('returns [] when payload is not an array', () => {
    expect(parsePodmanPsForAiLab('{"foo":"bar"}')).toEqual([]);
  });

  it('filters to containers labelled ai-lab.model-id', () => {
    const json = JSON.stringify([
      {
        Names: ['ai-lab-qwen3'],
        Labels: { 'ai-lab.model-id': 'qwen3-1.7b' },
        State: 'running',
        Ports: [{ container_port: 8000, host_port: 8501 }],
      },
      {
        Names: ['some-other-container'],
        Labels: {},
        State: 'running',
        Ports: [{ container_port: 8000, host_port: 8000 }],
      },
    ]);
    const result = parsePodmanPsForAiLab(json);
    expect(result).toHaveLength(1);
    expect(result[0]?.label).toBe('qwen3-1.7b');
    expect(result[0]?.baseUrl).toBe('http://localhost:8501/v1');
    expect(result[0]?.source).toBe('podman-ps');
  });

  it('accepts the legacy ai-studio.model-id label', () => {
    const json = JSON.stringify([
      {
        Names: ['legacy'],
        Labels: { 'ai-studio.model-id': 'old-model' },
        State: 'running',
        Ports: [{ container_port: 8000, host_port: 8888 }],
      },
    ]);
    const result = parsePodmanPsForAiLab(json);
    expect(result[0]?.label).toBe('old-model');
  });

  it('drops containers in non-running state', () => {
    const json = JSON.stringify([
      {
        Names: ['stopped'],
        Labels: { 'ai-lab.model-id': 'x' },
        State: 'exited',
        Ports: [{ container_port: 8000, host_port: 8000 }],
      },
    ]);
    expect(parsePodmanPsForAiLab(json)).toEqual([]);
  });

  it('drops containers without a usable host port', () => {
    const json = JSON.stringify([
      {
        Names: ['no-port'],
        Labels: { 'ai-lab.model-id': 'x' },
        State: 'running',
        Ports: [],
      },
    ]);
    expect(parsePodmanPsForAiLab(json)).toEqual([]);
  });

  it('prefers the host port mapped to container_port=8000', () => {
    const json = JSON.stringify([
      {
        Names: ['multi'],
        Labels: { 'ai-lab.model-id': 'x' },
        State: 'running',
        Ports: [
          { container_port: 9000, host_port: 9999 },
          { container_port: 8000, host_port: 8501 },
        ],
      },
    ]);
    const result = parsePodmanPsForAiLab(json);
    expect(result[0]?.port).toBe(8501);
  });
});
