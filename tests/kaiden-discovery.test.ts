/**
 * Kaiden discovery — pure-fn parser tests.
 *
 * Live `discoverKaidenWorkspace` (which does fs walking) is not
 * exercised here; the JSON parser is the wire-format surface.
 */

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  discoverKaidenWorkspace,
  parseKaidenWorkspace,
} from '../src/kaiden/discovery';


describe('parseKaidenWorkspace', () => {
  it('returns [] on malformed JSON', () => {
    expect(parseKaidenWorkspace('{ not valid')).toEqual([]);
  });

  it('returns [] when payload is not an object', () => {
    expect(parseKaidenWorkspace('"hello"')).toEqual([]);
  });

  it('returns [] when there is no `mcp` key', () => {
    expect(parseKaidenWorkspace('{"foo":"bar"}')).toEqual([]);
  });

  it('parses a stdio command entry', () => {
    const json = JSON.stringify({
      mcp: {
        commands: [
          {
            name: 'github',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
            env: { GITHUB_TOKEN: 'ghp_xxx' },
          },
        ],
      },
    });
    const result = parseKaidenWorkspace(json);
    expect(result).toHaveLength(1);
    const e = result[0]!;
    expect(e.name).toBe('github');
    expect(e.transport).toBe('stdio');
    expect(e.command).toEqual(['npx', '-y', '@modelcontextprotocol/server-github']);
    expect(e.url).toBe('');
    expect(e.env_var_names).toEqual(['GITHUB_TOKEN']);
    expect(e.header_names).toEqual([]);
  });

  it('parses an SSE server entry', () => {
    const json = JSON.stringify({
      mcp: {
        servers: [
          {
            name: 'team-knowledge',
            url: 'https://mcp.example.com/sse',
            headers: { Authorization: 'Bearer xxx', 'X-Tenant': 'acme' },
          },
        ],
      },
    });
    const result = parseKaidenWorkspace(json);
    expect(result).toHaveLength(1);
    const e = result[0]!;
    expect(e.transport).toBe('sse');
    expect(e.url).toBe('https://mcp.example.com/sse');
    expect(e.command).toEqual([]);
    expect(e.header_names.sort()).toEqual(['Authorization', 'X-Tenant']);
    expect(e.env_var_names).toEqual([]);
  });

  it('handles both arrays + sorts by name', () => {
    const json = JSON.stringify({
      mcp: {
        commands: [{ name: 'zeta-cmd', command: 'x' }],
        servers: [{ name: 'alpha-srv', url: 'http://x' }],
      },
    });
    const names = parseKaidenWorkspace(json).map((e) => e.name);
    expect(names).toEqual(['alpha-srv', 'zeta-cmd']);
  });

  it('strips entries missing name (commands)', () => {
    const json = JSON.stringify({
      mcp: {
        commands: [
          { command: 'no-name' },
          { name: 'good', command: 'x' },
        ],
      },
    });
    const names = parseKaidenWorkspace(json).map((e) => e.name);
    expect(names).toEqual(['good']);
  });

  it('strips servers missing name or url', () => {
    const json = JSON.stringify({
      mcp: {
        servers: [
          { name: 'no-url' },
          { url: 'http://x' },
          { name: 'good', url: 'http://y' },
        ],
      },
    });
    const names = parseKaidenWorkspace(json).map((e) => e.name);
    expect(names).toEqual(['good']);
  });

  it('handles missing optional sub-fields', () => {
    const json = JSON.stringify({
      mcp: { commands: [{ name: 'minimal' }] },
    });
    const e = parseKaidenWorkspace(json)[0]!;
    expect(e.transport).toBe('stdio');
    expect(e.command).toEqual([]);
    expect(e.env_var_names).toEqual([]);
  });
});


describe('discoverKaidenWorkspace', () => {
  function fakeRepo(): string {
    return mkdtempSync(join(tmpdir(), 'acc-kaiden-'));
  }

  it('returns a "no workspace" reason when nothing found', async () => {
    const repo = fakeRepo();
    const result = await discoverKaidenWorkspace({ repoRoot: repo });
    // Note: we cannot guarantee the runner's CWD or HOME is empty —
    // assert only when sourcePath is undefined that a reason is set.
    if (result.sourcePath === undefined) {
      expect(result.reason).toBeDefined();
      expect(result.entries).toEqual([]);
    }
  });

  it('reads `.kaiden/workspace.json` under the supplied repoRoot', async () => {
    const repo = fakeRepo();
    mkdirSync(join(repo, '.kaiden'), { recursive: true });
    writeFileSync(
      join(repo, '.kaiden', 'workspace.json'),
      JSON.stringify({
        mcp: {
          commands: [{ name: 'github', command: 'npx' }],
          servers: [{ name: 'team', url: 'https://x' }],
        },
      }),
    );
    const result = await discoverKaidenWorkspace({ repoRoot: repo });
    expect(result.sourcePath).toBe(join(repo, '.kaiden', 'workspace.json'));
    expect(result.entries.map((e) => e.name)).toEqual(['github', 'team']);
  });

  it('honours an explicit override path', async () => {
    const repo = fakeRepo();
    const path = join(repo, 'other.json');
    writeFileSync(path, JSON.stringify({ mcp: { commands: [{ name: 'x', command: 'y' }] } }));
    const result = await discoverKaidenWorkspace({ override: path });
    expect(result.sourcePath).toBe(path);
    expect(result.entries[0]?.name).toBe('x');
  });
});
