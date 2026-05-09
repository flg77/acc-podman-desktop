/**
 * Kaiden import — pure-fn manifest builder + on-disk write tests.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import type { KaidenEntry } from '../src/kaiden/discovery';
import {
  buildMcpYaml,
  importEntry,
  RISK_LEVELS,
  slugify,
} from '../src/kaiden/import';


function fakeRepo(): string {
  return mkdtempSync(join(tmpdir(), 'acc-kaiden-imp-'));
}


function stdioEntry(): KaidenEntry {
  return {
    name: 'github',
    transport: 'stdio',
    command: ['npx', '-y', '@modelcontextprotocol/server-github'],
    url: '',
    env_var_names: ['GITHUB_TOKEN'],
    header_names: [],
  };
}


function sseEntry(): KaidenEntry {
  return {
    name: 'team',
    transport: 'sse',
    command: [],
    url: 'https://mcp.example.com/sse',
    env_var_names: [],
    header_names: ['Authorization', 'X-Tenant'],
  };
}


describe('slugify', () => {
  it('lowercases + replaces non-alnum with underscores', () => {
    expect(slugify('Foo Bar / Baz!')).toBe('foo_bar_baz');
  });
  it('strips leading + trailing underscores', () => {
    expect(slugify('  Foo  ')).toBe('foo');
  });
});


describe('buildMcpYaml', () => {
  it('produces parseable YAML for a stdio entry', () => {
    const yaml = buildMcpYaml(stdioEntry(), {
      riskLevel: 'MEDIUM',
      allowedTools: ['create_issue', 'get_issue'],
    });
    const parsed = parseYaml(yaml);
    expect(parsed.transport).toBe('stdio');
    expect(parsed.command).toEqual(['npx', '-y', '@modelcontextprotocol/server-github']);
    expect(parsed.allowed_tools).toEqual(['create_issue', 'get_issue']);
    expect(parsed.risk_level).toBe('MEDIUM');
    expect(parsed.tags).toContain('kaiden-import');
    // Secret comment surfaces but the value DOES NOT.
    expect(yaml).toContain('env: GITHUB_TOKEN');
    expect(yaml).not.toContain('ghp_');
  });

  it('produces parseable YAML for an SSE entry', () => {
    const yaml = buildMcpYaml(sseEntry(), {
      riskLevel: 'HIGH',
      allowedTools: ['search'],
    });
    const parsed = parseYaml(yaml);
    expect(parsed.transport).toBe('sse');
    expect(parsed.url).toBe('https://mcp.example.com/sse');
    expect(parsed.risk_level).toBe('HIGH');
    expect(yaml).toContain('header: Authorization');
    expect(yaml).toContain('header: X-Tenant');
  });

  it('emits an empty allow-list with a guidance comment', () => {
    const yaml = buildMcpYaml(stdioEntry(), {
      riskLevel: 'LOW',
      allowedTools: [],
    });
    expect(yaml).toContain('empty allow-list = no tool calls permitted');
    const parsed = parseYaml(yaml);
    expect(parsed.allowed_tools).toEqual([]);
  });

  it('all four risk levels round-trip through parseable YAML', () => {
    for (const r of RISK_LEVELS) {
      const yaml = buildMcpYaml(stdioEntry(), {
        riskLevel: r,
        allowedTools: ['x'],
      });
      const parsed = parseYaml(yaml);
      expect(parsed.risk_level).toBe(r);
    }
  });

  it('honours the manifestName override', () => {
    const yaml = buildMcpYaml(stdioEntry(), {
      riskLevel: 'LOW',
      allowedTools: [],
      manifestName: 'gh_imported',
    });
    expect(yaml).toContain('mcps/gh_imported/mcp.yaml');
  });

  it('escapes embedded quotes safely', () => {
    const e = { ...stdioEntry(), name: 'has"quote' };
    const yaml = buildMcpYaml(e, { riskLevel: 'LOW', allowedTools: [] });
    expect(() => parseYaml(yaml)).not.toThrow();
  });

  it('drops empty allowed-tools entries', () => {
    const yaml = buildMcpYaml(stdioEntry(), {
      riskLevel: 'LOW',
      allowedTools: ['  ', 'real_tool', ''],
    });
    const parsed = parseYaml(yaml);
    expect(parsed.allowed_tools).toEqual(['real_tool']);
  });
});


describe('importEntry', () => {
  it('writes mcps/<name>/mcp.yaml under the repo root', async () => {
    const repo = fakeRepo();
    const result = await importEntry(repo, stdioEntry(), {
      riskLevel: 'MEDIUM',
      allowedTools: ['create_issue'],
    });
    expect(result.ok).toBe(true);
    expect(result.path).toBe(join(repo, 'mcps', 'github', 'mcp.yaml'));
    const written = readFileSync(result.path, 'utf-8');
    expect(written).toContain('imported from Kaiden');
  });

  it('rejects an invalid risk_level', async () => {
    const repo = fakeRepo();
    const result = await importEntry(repo, stdioEntry(), {
      riskLevel: 'NUCLEAR' as never,
      allowedTools: [],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('risk_level');
  });

  it('honours manifestName override', async () => {
    const repo = fakeRepo();
    const result = await importEntry(repo, stdioEntry(), {
      riskLevel: 'LOW',
      allowedTools: [],
      manifestName: 'gh_renamed',
    });
    expect(result.ok).toBe(true);
    expect(result.path).toBe(join(repo, 'mcps', 'gh_renamed', 'mcp.yaml'));
  });

  it('rejects an empty manifest name', async () => {
    const repo = fakeRepo();
    const result = await importEntry(
      repo,
      { ...stdioEntry(), name: '   ' },
      { riskLevel: 'LOW', allowedTools: [], manifestName: '   ' },
    );
    expect(result.ok).toBe(false);
  });
});
