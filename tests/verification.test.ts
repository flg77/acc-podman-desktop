/**
 * Tests for the verification reader + formatter.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  formatVerification,
  readVerification,
  type VerificationReport,
} from '../src/examples/verification';


function tempRunDir(verification: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'acc-run-'));
  writeFileSync(
    join(dir, '.verification.json'),
    JSON.stringify(verification),
    { encoding: 'utf-8' },
  );
  return dir;
}


function fakeReport(overrides: Partial<VerificationReport> = {}): VerificationReport {
  return {
    citations: [
      { footnote: 1, url: 'https://a.example/x', paywalled: false,
        refetched: true, refetch_count: 1 },
      { footnote: 2, url: 'https://b.example/y', paywalled: true,
        refetched: false, refetch_count: 0 },
    ],
    refetch_urls: ['https://a.example/x'],
    coverage_rate: 0.5,
    threshold: 0.3,
    ok: true,
    ...overrides,
  };
}


describe('readVerification', () => {
  it('reads + parses a valid .verification.json', async () => {
    const dir = tempRunDir(fakeReport());
    const r = await readVerification(dir);
    expect(r).toBeDefined();
    expect(r!.coverage_rate).toBe(0.5);
    expect(r!.citations).toHaveLength(2);
  });

  it('returns undefined when the file is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acc-empty-'));
    expect(await readVerification(dir)).toBeUndefined();
  });

  it('returns undefined on malformed JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acc-bad-'));
    writeFileSync(join(dir, '.verification.json'), '{not json');
    expect(await readVerification(dir)).toBeUndefined();
  });

  it('rejects payloads missing required fields', async () => {
    const dir = tempRunDir({ citations: [], coverage_rate: 0 });
    expect(await readVerification(dir)).toBeUndefined();
  });
});


describe('formatVerification', () => {
  it('produces a PASSED headline when ok=true', () => {
    const f = formatVerification(fakeReport({ ok: true, coverage_rate: 0.5 }));
    expect(f.ok).toBe(true);
    expect(f.headline).toContain('PASSED');
    expect(f.headline).toContain('50.0%');
  });

  it('produces a FAILED headline when ok=false', () => {
    const f = formatVerification(fakeReport({ ok: false, coverage_rate: 0.1 }));
    expect(f.ok).toBe(false);
    expect(f.headline).toContain('FAILED');
  });

  it('reports refetched / total in the details', () => {
    const f = formatVerification(fakeReport());
    expect(f.details.some((d) => d.includes('1/2 citations re-fetched'))).toBe(true);
  });

  it('flags missing citations as a synthesizer failure', () => {
    const f = formatVerification(fakeReport({ citations: [], ok: false }));
    expect(f.details.some((d) => d.includes('No citations parsed'))).toBe(true);
  });
});
