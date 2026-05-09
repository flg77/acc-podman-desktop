/**
 * Performance aggregator — pure-fn fold tests.
 *
 * Mirrors the runtime parser shapes documented in
 * `acc/tui/client.py` and `acc/tui/models.py`.  Wire-format drift
 * on the runtime side surfaces here.
 */

import { describe, expect, it } from 'vitest';

import {
  DRIFT_HISTORY_CAPACITY,
  PerformanceAggregator,
  STALENESS_S,
} from '../src/performance/aggregator';


describe('PerformanceAggregator — HEARTBEAT', () => {
  it('records per-agent queue + backpressure + token + drift', () => {
    const agg = new PerformanceAggregator();
    const changed = agg.ingest(
      {
        signal_type: 'HEARTBEAT',
        agent_id: 'a',
        role_id: 'coding_agent',
        queue_depth: 5,
        backpressure_state: 'THROTTLE',
        last_task_latency_ms: 250,
        token_budget_utilization: 0.42,
        drift_score: 0.13,
        domain_drift_score: 0.07,
      },
      1000,
    );
    expect(changed).toBe(true);
    const a = agg.getSnapshot().agents['a']!;
    expect(a.role_id).toBe('coding_agent');
    expect(a.queue_depth).toBe(5);
    expect(a.backpressure_state).toBe('THROTTLE');
    expect(a.last_task_latency_ms).toBe(250);
    expect(a.token_budget_utilization).toBeCloseTo(0.42);
    expect(a.drift_score).toBeCloseTo(0.13);
    expect(a.domain_drift_score).toBeCloseTo(0.07);
    expect(a.drift_history).toEqual([0.13]);
  });

  it('coerces unknown backpressure values to UNKNOWN', () => {
    const agg = new PerformanceAggregator();
    agg.ingest(
      {
        signal_type: 'HEARTBEAT',
        agent_id: 'a',
        backpressure_state: 'WTF',
      },
      1,
    );
    expect(agg.getSnapshot().agents['a']?.backpressure_state).toBe('UNKNOWN');
  });

  it('appends drift readings to a capped ring buffer', () => {
    const agg = new PerformanceAggregator();
    for (let i = 0; i < DRIFT_HISTORY_CAPACITY + 5; i++) {
      agg.ingest(
        { signal_type: 'HEARTBEAT', agent_id: 'a', drift_score: i / 100 },
        1 + i,
      );
    }
    const a = agg.getSnapshot().agents['a']!;
    expect(a.drift_history).toHaveLength(DRIFT_HISTORY_CAPACITY);
    // Oldest dropped, newest at the end.
    expect(a.drift_history[a.drift_history.length - 1]).toBeCloseTo(
      (DRIFT_HISTORY_CAPACITY + 4) / 100,
    );
  });

  it('returns false on heartbeats with no agent_id', () => {
    const agg = new PerformanceAggregator();
    expect(agg.ingest({ signal_type: 'HEARTBEAT' }, 1)).toBe(false);
  });

  it('computes latency percentiles across non-stale agents', () => {
    const agg = new PerformanceAggregator();
    agg.ingest(
      { signal_type: 'HEARTBEAT', agent_id: 'a', last_task_latency_ms: 100 },
      1000,
    );
    agg.ingest(
      { signal_type: 'HEARTBEAT', agent_id: 'b', last_task_latency_ms: 200 },
      1000,
    );
    agg.ingest(
      { signal_type: 'HEARTBEAT', agent_id: 'c', last_task_latency_ms: 300 },
      1000,
    );
    const lat = agg.getSnapshot().latency;
    expect(lat.p50).toBeGreaterThan(0);
    expect(lat.p99).toBeGreaterThanOrEqual(lat.p50);
  });

  it('drops stale agents from latency percentiles', () => {
    const agg = new PerformanceAggregator();
    agg.ingest(
      { signal_type: 'HEARTBEAT', agent_id: 'old', last_task_latency_ms: 9999 },
      1,
    );
    agg.ingest(
      { signal_type: 'HEARTBEAT', agent_id: 'new', last_task_latency_ms: 100 },
      1 + STALENESS_S + 60,
    );
    const lat = agg.getSnapshot().latency;
    expect(lat.p50).toBe(100);
    expect(lat.p99).toBe(100);
  });
});


describe('PerformanceAggregator — TASK_PROGRESS', () => {
  it('updates current/total step + label', () => {
    const agg = new PerformanceAggregator();
    agg.ingest(
      {
        signal_type: 'TASK_PROGRESS',
        agent_id: 'a',
        current_step: 2,
        total_steps: 5,
        step_label: 'Calling skill:code_review',
      },
      1,
    );
    const a = agg.getSnapshot().agents['a']!;
    expect(a.current_task_step).toBe(2);
    expect(a.total_task_steps).toBe(5);
    expect(a.task_progress_label).toBe('Calling skill:code_review');
  });

  it('preserves prior heartbeat state', () => {
    const agg = new PerformanceAggregator();
    agg.ingest(
      { signal_type: 'HEARTBEAT', agent_id: 'a', queue_depth: 3 },
      1,
    );
    agg.ingest(
      {
        signal_type: 'TASK_PROGRESS',
        agent_id: 'a',
        current_step: 1,
        total_steps: 4,
        step_label: 'thinking',
      },
      2,
    );
    const a = agg.getSnapshot().agents['a']!;
    expect(a.queue_depth).toBe(3);
    expect(a.current_task_step).toBe(1);
  });
});


describe('PerformanceAggregator — TASK_COMPLETE', () => {
  it('folds invocations[] into capability_stats', () => {
    const agg = new PerformanceAggregator();
    agg.ingest(
      {
        signal_type: 'TASK_COMPLETE',
        agent_id: 'c-1',
        invocations: [
          { kind: 'skill', target: 'code_review', ok: true, error: '' },
          { kind: 'skill', target: 'code_review', ok: false, error: 'boom' },
          { kind: 'mcp', target: 'echo_server.echo', ok: true, error: '' },
        ],
      },
      100,
    );
    const stats = agg.getSnapshot().capabilityStats;
    expect(stats['skill:code_review']?.total).toBe(2);
    expect(stats['skill:code_review']?.ok).toBe(1);
    expect(stats['skill:code_review']?.fail).toBe(1);
    expect(stats['skill:code_review']?.last_error).toBe('boom');
    expect(stats['mcp:echo_server.echo']?.ok).toBe(1);
  });

  it('accumulates tokens_used per plan_id', () => {
    const agg = new PerformanceAggregator();
    agg.ingest(
      { signal_type: 'TASK_COMPLETE', agent_id: 'a', plan_id: 'p1', tokens_used: 500 },
      1,
    );
    agg.ingest(
      { signal_type: 'TASK_COMPLETE', agent_id: 'a', plan_id: 'p1', tokens_used: 700 },
      2,
    );
    expect(agg.getSnapshot().planCosts['p1']?.tokens_used).toBe(1200);
  });

  it('falls back to cluster_id, then "global", when plan_id is absent', () => {
    const agg = new PerformanceAggregator();
    agg.ingest(
      {
        signal_type: 'TASK_COMPLETE',
        agent_id: 'a',
        cluster_id: 'c1',
        tokens_used: 100,
      },
      1,
    );
    agg.ingest(
      { signal_type: 'TASK_COMPLETE', agent_id: 'a', tokens_used: 200 },
      2,
    );
    expect(agg.getSnapshot().planCosts['c1']?.tokens_used).toBe(100);
    expect(agg.getSnapshot().planCosts['global']?.tokens_used).toBe(200);
  });

  it('updates last_task_latency_ms when latency_ms is present', () => {
    const agg = new PerformanceAggregator();
    agg.ingest(
      {
        signal_type: 'TASK_COMPLETE',
        agent_id: 'a',
        latency_ms: 333,
      },
      1,
    );
    expect(agg.getSnapshot().agents['a']?.last_task_latency_ms).toBe(333);
  });

  it('returns false when nothing actionable arrives', () => {
    const agg = new PerformanceAggregator();
    expect(
      agg.ingest({ signal_type: 'TASK_COMPLETE', agent_id: 'a' }, 1),
    ).toBe(false);
  });
});


describe('PerformanceAggregator — PLAN', () => {
  it('captures max_run_tokens per plan_id', () => {
    const agg = new PerformanceAggregator();
    agg.ingest(
      { signal_type: 'PLAN', plan_id: 'p1', max_run_tokens: 50_000 },
      1,
    );
    expect(agg.getSnapshot().planCosts['p1']?.max_run_tokens).toBe(50_000);
    expect(agg.getSnapshot().planCosts['p1']?.tokens_used).toBe(0);
  });

  it('preserves running tokens_used when PLAN arrives later', () => {
    const agg = new PerformanceAggregator();
    agg.ingest(
      {
        signal_type: 'TASK_COMPLETE',
        agent_id: 'a',
        plan_id: 'p1',
        tokens_used: 1000,
      },
      1,
    );
    agg.ingest(
      { signal_type: 'PLAN', plan_id: 'p1', max_run_tokens: 50_000 },
      2,
    );
    const cost = agg.getSnapshot().planCosts['p1']!;
    expect(cost.tokens_used).toBe(1000);
    expect(cost.max_run_tokens).toBe(50_000);
  });

  it('returns false on PLAN with missing plan_id or zero cap', () => {
    const agg = new PerformanceAggregator();
    expect(agg.ingest({ signal_type: 'PLAN', max_run_tokens: 1 }, 1)).toBe(false);
    expect(agg.ingest({ signal_type: 'PLAN', plan_id: 'x' }, 1)).toBe(false);
  });
});


describe('PerformanceAggregator — misc', () => {
  it('returns false on unknown signal types', () => {
    const agg = new PerformanceAggregator();
    expect(agg.ingest({ signal_type: 'OVERSIGHT_DECISION' }, 1)).toBe(false);
    expect(agg.ingest({}, 1)).toBe(false);
  });

  it('initial snapshot has empty maps + zero latency', () => {
    const snap = new PerformanceAggregator().getSnapshot();
    expect(Object.keys(snap.agents)).toHaveLength(0);
    expect(Object.keys(snap.capabilityStats)).toHaveLength(0);
    expect(Object.keys(snap.planCosts)).toHaveLength(0);
    expect(snap.latency).toEqual({ p50: 0, p90: 0, p95: 0, p99: 0 });
  });
});
