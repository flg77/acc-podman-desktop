/**
 * deploy/.env operations + preset listing + profile patching.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyPreset,
  listPresets,
  patchProfileState,
  PROFILE_KEYS,
  readDeployEnv,
  readProfileState,
  writeDeployEnv,
  type ProfileState,
} from '../src/stack/env-file';


function fakeRepo(): string {
  return mkdtempSync(join(tmpdir(), 'acc-stack-'));
}


function plantPreset(repo: string, name: string, body: string): string {
  const dir = join(repo, 'env');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `.env.${name}`);
  writeFileSync(path, body);
  return path;
}


// ---------------------------------------------------------------------------
// Preset listing
// ---------------------------------------------------------------------------


describe('listPresets', () => {
  it('returns [] when env/ does not exist', async () => {
    expect(await listPresets(fakeRepo())).toEqual([]);
  });

  it('skips .env.example + non-preset files', async () => {
    const repo = fakeRepo();
    plantPreset(repo, 'example', '# canonical template\n');
    plantPreset(repo, 'real', '# Preset for real\n');
    writeFileSync(join(repo, 'env', 'README.md'), 'noise');
    const presets = await listPresets(repo);
    expect(presets.map((p) => p.name)).toEqual(['real']);
  });

  it('parses the "Preset for …" comment line as the blurb', async () => {
    const repo = fakeRepo();
    plantPreset(repo, 'llama', `
# env/.env.llama
# =============================================================================
# Preset for RedHatAI/Llama-3.2-1B-Instruct-FP8 on port 8001
# (more comments)
ACC_LLM_BACKEND=openai_compat
`);
    const [p] = await listPresets(repo);
    expect(p?.blurb).toContain('Preset for RedHatAI/Llama-3.2-1B-Instruct-FP8');
  });

  it('returns presets sorted by name', async () => {
    const repo = fakeRepo();
    for (const n of ['zeta', 'alpha', 'mu']) {
      plantPreset(repo, n, '# Preset for x\n');
    }
    const names = (await listPresets(repo)).map((p) => p.name);
    expect(names).toEqual(['alpha', 'mu', 'zeta']);
  });
});


// ---------------------------------------------------------------------------
// deploy/.env read + write + applyPreset
// ---------------------------------------------------------------------------


describe('readDeployEnv', () => {
  it('returns undefined contents when the file does not exist', async () => {
    const env = await readDeployEnv(fakeRepo());
    expect(env.contents).toBeUndefined();
    expect(env.path.endsWith(join('deploy', '.env'))).toBe(true);
  });

  it('reads existing deploy/.env', async () => {
    const repo = fakeRepo();
    mkdirSync(join(repo, 'deploy'), { recursive: true });
    writeFileSync(join(repo, 'deploy', '.env'), 'TUI=true\n');
    const env = await readDeployEnv(repo);
    expect(env.contents).toBe('TUI=true\n');
  });
});


describe('writeDeployEnv', () => {
  it('creates deploy/.env if missing', async () => {
    const repo = fakeRepo();
    const path = await writeDeployEnv(repo, 'TUI=false\n');
    expect(readFileSync(path, 'utf-8')).toBe('TUI=false\n');
  });
});


describe('applyPreset', () => {
  let repo: string;
  beforeEach(() => {
    repo = fakeRepo();
    plantPreset(repo, 'llama', '# Preset for llama\nACC_LLM_BACKEND=openai_compat\n');
  });

  it('copies the preset into deploy/.env when no prior file exists', async () => {
    const result = await applyPreset(repo, 'llama');
    expect(result.ok).toBe(true);
    expect(result.backupPath).toBeUndefined();
    expect(readFileSync(result.path, 'utf-8')).toContain('ACC_LLM_BACKEND=openai_compat');
  });

  it('backs up existing deploy/.env to .bak', async () => {
    mkdirSync(join(repo, 'deploy'), { recursive: true });
    writeFileSync(join(repo, 'deploy', '.env'), 'OLD_CONTENTS=1\n');

    const result = await applyPreset(repo, 'llama');
    expect(result.ok).toBe(true);
    expect(result.backupPath).toBeDefined();
    expect(readFileSync(result.backupPath!, 'utf-8')).toBe('OLD_CONTENTS=1\n');
    expect(readFileSync(result.path, 'utf-8')).toContain('ACC_LLM_BACKEND=openai_compat');
  });

  it('reports failure when the preset does not exist', async () => {
    const result = await applyPreset(repo, 'no-such-preset');
    expect(result.ok).toBe(false);
    expect(result.reason).toBeDefined();
  });
});


// ---------------------------------------------------------------------------
// Profile state read / patch
// ---------------------------------------------------------------------------


describe('readProfileState', () => {
  it('returns defaults when no file present', () => {
    const state = readProfileState(undefined);
    expect(state.TUI).toBe(true);
    expect(state.DETACH).toBe(true);
    expect(state.CODING_SPLIT).toBe(false);
    expect(state.AUTORESEARCHER).toBe(false);
    expect(state.MCP_ECHO).toBe(false);
  });

  it('parses canonical KEY=VALUE lines', () => {
    const state = readProfileState(
      'TUI=false\nCODING_SPLIT=true\nAUTORESEARCHER=true\n',
    );
    expect(state.TUI).toBe(false);
    expect(state.CODING_SPLIT).toBe(true);
    expect(state.AUTORESEARCHER).toBe(true);
  });

  it('ignores commented lines + tolerates quoting', () => {
    const state = readProfileState(`
# TUI=true (commented)
TUI="false"
MCP_ECHO='true'
`);
    expect(state.TUI).toBe(false);
    expect(state.MCP_ECHO).toBe(true);
  });

  it('leaves unrecognised keys at default', () => {
    const state = readProfileState('UNKNOWN_KEY=hello\nTUI=true\n');
    expect(state.TUI).toBe(true);
    expect(state.AUTORESEARCHER).toBe(false);
  });
});


describe('patchProfileState', () => {
  it('updates an existing TUI=true line in place', () => {
    const out = patchProfileState(
      'TUI=true\nOTHER=ignored\n',
      makeState({ TUI: false }),
    );
    expect(out).toContain('TUI=false');
    expect(out).toContain('OTHER=ignored');
  });

  it('appends missing profile keys at the end with a marker comment', () => {
    const out = patchProfileState(
      'OTHER=ignored\n',
      makeState({ AUTORESEARCHER: true }),
    );
    expect(out).toContain('OTHER=ignored');
    expect(out).toContain('AUTORESEARCHER=true');
    expect(out).toContain('# --- profiles toggled by the ACC stack panel ---');
  });

  it('preserves comment lines untouched', () => {
    const input = '# top comment\nTUI=true\n# bottom\n';
    const out = patchProfileState(input, makeState({ TUI: false }));
    expect(out).toContain('# top comment');
    expect(out).toContain('# bottom');
    expect(out).toContain('TUI=false');
  });

  it('handles undefined input by writing every key with the marker', () => {
    const out = patchProfileState(undefined, makeState({}));
    for (const k of PROFILE_KEYS) {
      expect(out).toContain(`${k}=`);
    }
  });
});


function makeState(over: Partial<ProfileState>): ProfileState {
  return {
    TUI: true, CODING_SPLIT: false, AUTORESEARCHER: false,
    MCP_ECHO: false, DETACH: true, ...over,
  };
}
