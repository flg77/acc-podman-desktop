/**
 * Read + format the autoresearcher run's `.verification.json`.
 *
 * `verify.sh` writes this file at
 * `runs/<topic-slug>-<date>/.verification.json` containing the
 * citation_verifier output (coverage_rate, threshold, ok flag,
 * per-citation refetched booleans).
 *
 * Used by the examples panel to display the post-run summary.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';


export interface VerificationCitation {
  footnote: number;
  url: string;
  paywalled: boolean;
  refetched: boolean;
  refetch_count: number;
}


export interface VerificationReport {
  citations: VerificationCitation[];
  refetch_urls: string[];
  coverage_rate: number;
  threshold: number;
  ok: boolean;
}


export interface FormattedVerification {
  ok: boolean;
  /** Human-readable headline rendered in the panel header. */
  headline: string;
  /** Bullet-list rendered under the headline. */
  details: string[];
}


/**
 * Read + parse the verification JSON if present.
 * Returns ``undefined`` when the file doesn't exist (a normal
 * state until verify.sh has actually run) or parses as anything
 * other than the canonical shape.
 */
export async function readVerification(
  runDir: string,
): Promise<VerificationReport | undefined> {
  try {
    const raw = await readFile(
      join(runDir, '.verification.json'),
      { encoding: 'utf-8' },
    );
    const parsed = JSON.parse(raw);
    if (!isVerificationReport(parsed)) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}


export function formatVerification(
  report: VerificationReport,
): FormattedVerification {
  const refetchedCount = report.citations.filter((c) => c.refetched).length;
  const total = report.citations.length;
  const pct = (report.coverage_rate * 100).toFixed(1);
  const thresholdPct = (report.threshold * 100).toFixed(1);

  return {
    ok: report.ok,
    headline: report.ok
      ? `Verification PASSED — ${pct}% coverage (≥ ${thresholdPct}% required)`
      : `Verification FAILED — ${pct}% coverage (< ${thresholdPct}% required)`,
    details: [
      `${refetchedCount}/${total} citations re-fetched by the critic`,
      `${report.refetch_urls.length} unique URLs touched via web_fetch`,
      report.citations.length === 0
        ? 'No citations parsed from the report — the synthesizer produced no Citations section.'
        : `${report.citations.filter((c) => c.paywalled).length} paywalled citations marked.`,
    ],
  };
}


function isVerificationReport(x: unknown): x is VerificationReport {
  if (typeof x !== 'object' || x === null) {
    return false;
  }
  const r = x as Record<string, unknown>;
  return (
    Array.isArray(r['citations']) &&
    Array.isArray(r['refetch_urls']) &&
    typeof r['coverage_rate'] === 'number' &&
    typeof r['threshold'] === 'number' &&
    typeof r['ok'] === 'boolean'
  );
}
