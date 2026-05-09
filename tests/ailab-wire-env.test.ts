/**
 * Tests for the conservative env patcher that wires an AI Lab base
 * URL into deploy/.env.  The live `wireBaseUrl` (which does the
 * read+write) is exercised through the pure `patchAccLlmKeys`.
 */

import { describe, expect, it } from 'vitest';

import { patchAccLlmKeys } from '../src/ailab/wire-env';


describe('patchAccLlmKeys', () => {
  it('appends a new section when keys are absent', () => {
    const out = patchAccLlmKeys('TUI=true\n', {
      baseUrl: 'http://localhost:8501/v1',
      modelName: 'qwen3-1.7b',
    });
    expect(out).toContain('TUI=true');
    expect(out).toContain('# --- wired from AI Lab by the ACC extension ---');
    expect(out).toContain('ACC_LLM_BACKEND=openai_compat');
    expect(out).toContain('ACC_OPENAI_BASE_URL=http://localhost:8501/v1');
    expect(out).toContain('ACC_OPENAI_MODEL=qwen3-1.7b');
  });

  it('updates an existing assignment in place', () => {
    const env = [
      '# leading comment',
      'TUI=true',
      'ACC_LLM_BACKEND=ollama',
      'ACC_OPENAI_BASE_URL=http://old/v1',
      '',
    ].join('\n');
    const out = patchAccLlmKeys(env, {
      baseUrl: 'http://localhost:8000/v1',
    });
    expect(out).toContain('# leading comment');
    expect(out).toContain('TUI=true');
    expect(out).toContain('ACC_LLM_BACKEND=openai_compat');
    expect(out).toContain('ACC_OPENAI_BASE_URL=http://localhost:8000/v1');
    expect(out).not.toContain('ACC_LLM_BACKEND=ollama');
    expect(out).not.toContain('http://old/v1');
    // Update-in-place should NOT add a wired-from-AI-Lab footer.
    expect(out).not.toContain('# --- wired from AI Lab by the ACC extension ---');
  });

  it('omits ACC_OPENAI_MODEL when modelName is empty / missing', () => {
    const out = patchAccLlmKeys(undefined, {
      baseUrl: 'http://localhost:8000/v1',
    });
    expect(out).toContain('ACC_OPENAI_BASE_URL=http://localhost:8000/v1');
    expect(out).not.toContain('ACC_OPENAI_MODEL=');
  });

  it('preserves comments and unrelated keys', () => {
    const env = [
      '# preset for some-model',
      '# do not touch',
      '',
      'CUSTOM_VAR=hello',
      'ACC_OLLAMA_URL=http://x',
      '',
    ].join('\n');
    const out = patchAccLlmKeys(env, {
      baseUrl: 'http://localhost:8501/v1',
    });
    expect(out).toContain('# preset for some-model');
    expect(out).toContain('# do not touch');
    expect(out).toContain('CUSTOM_VAR=hello');
    expect(out).toContain('ACC_OLLAMA_URL=http://x');
  });

  it('handles undefined env contents (no file yet)', () => {
    const out = patchAccLlmKeys(undefined, {
      baseUrl: 'http://localhost:8000/v1',
      modelName: 'm',
    });
    const lines = out.split('\n').filter((l) => l.length > 0);
    expect(lines).toContain('ACC_LLM_BACKEND=openai_compat');
    expect(lines).toContain('ACC_OPENAI_BASE_URL=http://localhost:8000/v1');
    expect(lines).toContain('ACC_OPENAI_MODEL=m');
  });

  it('does not edit commented-out assignments', () => {
    const env = [
      '# ACC_LLM_BACKEND=ollama',
      'TUI=true',
    ].join('\n');
    const out = patchAccLlmKeys(env, {
      baseUrl: 'http://localhost:8000/v1',
    });
    expect(out).toContain('# ACC_LLM_BACKEND=ollama');
    // missing key, so footer + new line appended
    expect(out).toContain('ACC_LLM_BACKEND=openai_compat');
  });
});
