/**
 * Compliance aggregator — pure-fn fold tests.
 *
 * Mirrors the runtime parser shapes documented in
 * `acc/tui/client.py` (HEARTBEAT, EVAL_OUTCOME, ALERT_ESCALATE).
 * Wire-format drift on the runtime side surfaces here.
 */

import { describe, expect, it } from 'vitest';

import {
  ComplianceAggregator,
  OWASP_CODES,
  STALENESS_S,
  VIOLATION_LOG_CAPACITY,
} from '../src/compliance/aggregator';


describe('ComplianceAggregator — HEARTBEAT', () => {
  it('records a per-agent rollup', () => {
    const agg = new ComplianceAggregator();
    const changed = agg.ingest(
      {
        signal_type: 'HEARTBEAT',
        agent_id: 'a-1',
        role_id: 'coding_agent',
        compliance_health_score: 0.92,
        owasp_violation_count: 3,
        oversight_pending_count: 1,
        cat_a_trigger_count: 0,
        cat_b_trigger_count: 2,
      },
      1000,
    );
    expect(changed).toBe(true);
    const snap = agg.getSnapshot();
    expect(snap.agents['a-1']).toBeDefined();
    expect(snap.agents['a-1']?.role_id).toBe('coding_agent');
    expect(snap.agents['a-1']?.compliance_health_score).toBeCloseTo(0.92);
    expect(snap.agents['a-1']?.cat_b_trigger_count).toBe(2);
    expect(snap.agents['a-1']?.last_seen).toBe(1000);
  });

  it('updates collective health to min of non-stale agents', () => {
    const agg = new ComplianceAggregator();
    agg.ingest(
      { signal_type: 'HEARTBEAT', agent_id: 'a', compliance_health_score: 0.95 },
      1000,
    );
    agg.ingest(
      { signal_type: 'HEARTBEAT', agent_id: 'b', compliance_health_score: 0.71 },
      1000,
    );
    expect(agg.getSnapshot().collectiveHealth).toBeCloseTo(0.71);
  });

  it('excludes stale agents from collective health', () => {
    const agg = new ComplianceAggregator();
    agg.ingest(
      { signal_type: 'HEARTBEAT', agent_id: 'old', compliance_health_score: 0.4 },
      1000,
    );
    // Refresh another agent far in the future — old one is now stale.
    const t = 1000 + STALENESS_S + 60;
    agg.ingest(
      { signal_type: 'HEARTBEAT', agent_id: 'new', compliance_health_score: 0.9 },
      t,
    );
    expect(agg.getSnapshot().collectiveHealth).toBeCloseTo(0.9);
  });

  it('captures arbiter oversight queue from heartbeat', () => {
    const agg = new ComplianceAggregator();
    agg.ingest(
      {
        signal_type: 'HEARTBEAT',
        agent_id: 'arbiter-1',
        role_id: 'arbiter',
        oversight_pending_items: [
          {
            oversight_id: 'os-1',
            task_id: 't-1',
            risk_level: 'HIGH',
            summary: 'Approve risky shell call',
            role_id: 'coding_agent',
            agent_id: 'c-1',
            submitted_at_ms: 12345,
            timeout_ms: 60000,
            status: 'PENDING',
          },
          {
            oversight_id: 'os-2',
            status: 'APPROVED', // already resolved — filtered out
          },
        ],
      },
      1000,
    );
    const pending = agg.getSnapshot().oversightPending;
    expect(pending).toHaveLength(1);
    expect(pending[0]?.oversight_id).toBe('os-1');
    expect(pending[0]?.risk_level).toBe('HIGH');
  });

  it('ignores oversight queue from non-arbiter heartbeats', () => {
    const agg = new ComplianceAggregator();
    agg.ingest(
      {
        signal_type: 'HEARTBEAT',
        agent_id: 'c-1',
        role_id: 'coding_agent',
        oversight_pending_items: [
          { oversight_id: 'os-x', status: 'PENDING' },
        ],
      },
      1000,
    );
    expect(agg.getSnapshot().oversightPending).toHaveLength(0);
  });

  it('returns false on heartbeats with no agent_id', () => {
    const agg = new ComplianceAggregator();
    const changed = agg.ingest({ signal_type: 'HEARTBEAT' }, 1000);
    expect(changed).toBe(false);
  });
});


describe('ComplianceAggregator — EVAL_OUTCOME', () => {
  it('folds OWASP violations into the rolling log + counts', () => {
    const agg = new ComplianceAggregator();
    const changed = agg.ingest(
      {
        signal_type: 'EVAL_OUTCOME',
        agent_id: 'c-1',
        ts: 1234,
        owasp_violations: [
          { code: 'LLM01', risk_level: 'HIGH', pattern: 'prompt injection' },
          { code: 'LLM06', risk_level: 'MEDIUM', pattern: 'PII leak' },
        ],
      },
      1000,
    );
    expect(changed).toBe(true);
    const snap = agg.getSnapshot();
    expect(snap.violationLog).toHaveLength(2);
    expect(snap.violationLog[0]?.code).toBe('LLM01');
    expect(snap.violationLog[0]?.agent_id).toBe('c-1');
    expect(snap.violationLog[0]?.ts).toBe(1234);
    expect(snap.owaspCounts['LLM01']).toBe(1);
    expect(snap.owaspCounts['LLM06']).toBe(1);
    expect(snap.owaspCounts['LLM02']).toBe(0);
  });

  it('returns false on payloads without owasp_violations', () => {
    const agg = new ComplianceAggregator();
    expect(
      agg.ingest({ signal_type: 'EVAL_OUTCOME', agent_id: 'c-1' }, 1000),
    ).toBe(false);
  });

  it('caps the violation log at VIOLATION_LOG_CAPACITY entries', () => {
    const agg = new ComplianceAggregator();
    const violations = Array.from({ length: 60 }, (_, i) => ({
      code: 'LLM01',
      risk_level: 'LOW',
      pattern: `p-${i}`,
    }));
    agg.ingest(
      {
        signal_type: 'EVAL_OUTCOME',
        agent_id: 'c-1',
        ts: 1,
        owasp_violations: violations,
      },
      1000,
    );
    const log = agg.getSnapshot().violationLog;
    expect(log).toHaveLength(VIOLATION_LOG_CAPACITY);
    // Newest at the end.
    expect(log[log.length - 1]?.pattern).toBe('p-59');
  });

  it('falls back ts to now when payload omits it', () => {
    const agg = new ComplianceAggregator();
    agg.ingest(
      {
        signal_type: 'EVAL_OUTCOME',
        agent_id: 'c-1',
        owasp_violations: [{ code: 'LLM03', risk_level: 'LOW', pattern: 'x' }],
      },
      9999,
    );
    expect(agg.getSnapshot().violationLog[0]?.ts).toBe(9999);
  });

  it('ignores violations without a code', () => {
    const agg = new ComplianceAggregator();
    agg.ingest(
      {
        signal_type: 'EVAL_OUTCOME',
        agent_id: 'c-1',
        ts: 1,
        owasp_violations: [{ risk_level: 'LOW' }, { code: 'LLM07' }],
      },
      1000,
    );
    expect(agg.getSnapshot().violationLog).toHaveLength(1);
    expect(agg.getSnapshot().violationLog[0]?.code).toBe('LLM07');
  });
});


describe('ComplianceAggregator — ALERT_ESCALATE', () => {
  it('increments cat_a counter on a cat_a:rule reason', () => {
    const agg = new ComplianceAggregator();
    agg.ingest(
      { signal_type: 'ALERT_ESCALATE', agent_id: 'a', reason: 'cat_a:A-017' },
      1000,
    );
    expect(agg.getSnapshot().agents['a']?.cat_a_trigger_count).toBe(1);
    expect(agg.getSnapshot().agents['a']?.cat_b_trigger_count).toBe(0);
  });

  it('increments cat_b counter on guardrail reasons', () => {
    const agg = new ComplianceAggregator();
    agg.ingest(
      { signal_type: 'ALERT_ESCALATE', agent_id: 'a', reason: 'guardrail:LLM01' },
      1000,
    );
    expect(agg.getSnapshot().agents['a']?.cat_a_trigger_count).toBe(0);
    expect(agg.getSnapshot().agents['a']?.cat_b_trigger_count).toBe(1);
  });

  it('matches `cat-a` (hyphen) as well as `cat_a`', () => {
    const agg = new ComplianceAggregator();
    agg.ingest(
      { signal_type: 'ALERT_ESCALATE', agent_id: 'a', reason: 'cat-a:thing' },
      1000,
    );
    expect(agg.getSnapshot().agents['a']?.cat_a_trigger_count).toBe(1);
  });

  it('preserves prior agent fields when only an alert was seen', () => {
    const agg = new ComplianceAggregator();
    agg.ingest(
      {
        signal_type: 'HEARTBEAT',
        agent_id: 'a',
        role_id: 'coding_agent',
        compliance_health_score: 0.8,
      },
      1000,
    );
    agg.ingest(
      { signal_type: 'ALERT_ESCALATE', agent_id: 'a', reason: 'cat_a:x' },
      1100,
    );
    const a = agg.getSnapshot().agents['a'];
    expect(a?.role_id).toBe('coding_agent');
    expect(a?.compliance_health_score).toBeCloseTo(0.8);
    expect(a?.cat_a_trigger_count).toBe(1);
  });
});


describe('ComplianceAggregator — misc', () => {
  it('initial snapshot has zero counts for all OWASP codes', () => {
    const snap = new ComplianceAggregator().getSnapshot();
    for (const c of OWASP_CODES) {
      expect(snap.owaspCounts[c]).toBe(0);
    }
    expect(snap.collectiveHealth).toBe(1.0);
  });

  it('returns false on unknown signal types', () => {
    const agg = new ComplianceAggregator();
    expect(agg.ingest({ signal_type: 'TASK_PROGRESS' }, 1)).toBe(false);
    expect(agg.ingest({}, 1)).toBe(false);
  });
});
