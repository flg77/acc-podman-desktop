/**
 * Cluster topology aggregator — pure-function tests.
 *
 * Mirrors the runtime's `tests/test_cluster_panel.py` so the
 * extension and the TUI agree on the snapshot shape after each
 * wire event.
 */

import { describe, it, expect } from 'vitest';

import {
  TopologyAggregator,
  FINISHED_GRACE_S,
  extractSkillInUse,
  SIG_TASK_PROGRESS,
  SIG_TASK_COMPLETE,
} from '../src/cluster/aggregator';


/** Test-time clock with a settable `now`. */
class Clock {
  current = 1_000;
  now = () => this.current;
  advance(deltaSeconds: number) {
    this.current += deltaSeconds;
  }
}


function progressEvent(opts: {
  cluster_id: string;
  agent_id: string;
  task_id?: string;
  current_step?: number;
  total_steps_estimated?: number;
  step_label?: string;
  iteration_n?: number;
}): Record<string, unknown> {
  return {
    signal_type: SIG_TASK_PROGRESS,
    cluster_id: opts.cluster_id,
    agent_id: opts.agent_id,
    task_id: opts.task_id ?? `t-${opts.agent_id}`,
    iteration_n: opts.iteration_n ?? 0,
    progress: {
      current_step: opts.current_step ?? 1,
      total_steps_estimated: opts.total_steps_estimated ?? 6,
      step_label: opts.step_label ?? '',
    },
  };
}


function completeEvent(opts: {
  cluster_id: string;
  agent_id: string;
  blocked?: boolean;
}): Record<string, unknown> {
  return {
    signal_type: SIG_TASK_COMPLETE,
    cluster_id: opts.cluster_id,
    agent_id: opts.agent_id,
    task_id: `t-${opts.agent_id}`,
    blocked: opts.blocked ?? false,
  };
}


// ---------------------------------------------------------------------------
// extractSkillInUse
// ---------------------------------------------------------------------------


describe('extractSkillInUse', () => {
  it('parses skill: prefix', () => {
    expect(extractSkillInUse('Calling skill:code_review')).toBe('code_review');
  });

  it('parses mcp: prefix with server.tool', () => {
    expect(extractSkillInUse('Calling mcp:fs.read')).toBe('mcp:fs.read');
  });

  it('returns "" for unrelated step labels', () => {
    expect(extractSkillInUse('Pre-reasoning gate (Cat-B)')).toBe('');
    expect(extractSkillInUse('')).toBe('');
  });

  it('is case-insensitive on the prefix', () => {
    expect(extractSkillInUse('Calling SKILL:code_review')).toBe('code_review');
  });
});


// ---------------------------------------------------------------------------
// ingest — basic shape
// ---------------------------------------------------------------------------


describe('TopologyAggregator.ingest', () => {
  it('creates a cluster row + member on first PROGRESS', () => {
    const clock = new Clock();
    const a = new TopologyAggregator(clock.now);

    const changed = a.ingest(progressEvent({
      cluster_id: 'c-abc',
      agent_id: 'coding-1',
      step_label: 'Calling skill:echo',
      current_step: 2,
      total_steps_estimated: 6,
    }));
    expect(changed).toBe(true);

    const snap = a.get();
    expect(Object.keys(snap)).toEqual(['c-abc']);
    const row = snap['c-abc']!;
    expect(row.subagent_count).toBe(1);
    const member = row.members['coding-1']!;
    expect(member.skill_in_use).toBe('echo');
    expect(member.current_step).toBe(2);
    expect(member.total_steps).toBe(6);
    expect(member.status).toBe('running');
  });

  it('ignores payloads without cluster_id (legacy single-agent)', () => {
    const a = new TopologyAggregator();
    const changed = a.ingest({
      signal_type: SIG_TASK_PROGRESS,
      agent_id: 'coding-1',
      task_id: 't-1',
      progress: { current_step: 1 },
    });
    expect(changed).toBe(false);
    expect(a.get()).toEqual({});
  });

  it('ignores payloads with unknown signal types', () => {
    const a = new TopologyAggregator();
    const changed = a.ingest({
      signal_type: 'HEARTBEAT',
      cluster_id: 'c-abc',
      agent_id: 'coding-1',
    });
    expect(changed).toBe(false);
  });

  it('grows subagent_count as new members appear', () => {
    const a = new TopologyAggregator();
    for (const aid of ['m-1', 'm-2', 'm-3']) {
      a.ingest(progressEvent({ cluster_id: 'c-grow', agent_id: aid }));
    }
    expect(a.get()['c-grow']!.subagent_count).toBe(3);
  });
});


// ---------------------------------------------------------------------------
// COMPLETE → status transitions + finished_at
// ---------------------------------------------------------------------------


describe('TopologyAggregator complete transitions', () => {
  it('marks member complete on TASK_COMPLETE blocked=false', () => {
    const a = new TopologyAggregator();
    a.ingest(progressEvent({ cluster_id: 'c-1', agent_id: 'm-1' }));
    a.ingest(completeEvent({ cluster_id: 'c-1', agent_id: 'm-1' }));
    expect(a.get()['c-1']!.members['m-1']!.status).toBe('complete');
  });

  it('marks member blocked on TASK_COMPLETE blocked=true', () => {
    const a = new TopologyAggregator();
    a.ingest(progressEvent({ cluster_id: 'c-b', agent_id: 'm-1' }));
    a.ingest(completeEvent({
      cluster_id: 'c-b', agent_id: 'm-1', blocked: true,
    }));
    expect(a.get()['c-b']!.members['m-1']!.status).toBe('blocked');
  });

  it('stamps finished_at when every observed member has reported', () => {
    const a = new TopologyAggregator();
    for (const aid of ['m-1', 'm-2']) {
      a.ingest(progressEvent({ cluster_id: 'c-fin', agent_id: aid }));
    }
    a.ingest(completeEvent({ cluster_id: 'c-fin', agent_id: 'm-1' }));
    expect(a.get()['c-fin']!.finished_at).toBeNull();
    a.ingest(completeEvent({ cluster_id: 'c-fin', agent_id: 'm-2' }));
    expect(a.get()['c-fin']!.finished_at).not.toBeNull();
  });
});


// ---------------------------------------------------------------------------
// liveClusters — 30 s grace window
// ---------------------------------------------------------------------------


describe('TopologyAggregator.liveClusters', () => {
  it('keeps recently-finished clusters visible inside the grace window', () => {
    const clock = new Clock();
    const a = new TopologyAggregator(clock.now);
    a.ingest(progressEvent({ cluster_id: 'c-recent', agent_id: 'm-1' }));
    a.ingest(completeEvent({ cluster_id: 'c-recent', agent_id: 'm-1' }));
    clock.advance(FINISHED_GRACE_S - 5);
    expect(Object.keys(a.liveClusters())).toEqual(['c-recent']);
  });

  it('drops finished clusters past the grace window', () => {
    const clock = new Clock();
    const a = new TopologyAggregator(clock.now);
    a.ingest(progressEvent({ cluster_id: 'c-old', agent_id: 'm-1' }));
    a.ingest(completeEvent({ cluster_id: 'c-old', agent_id: 'm-1' }));
    clock.advance(FINISHED_GRACE_S + 5);
    expect(Object.keys(a.liveClusters())).toEqual([]);
  });

  it('always shows running clusters regardless of clock', () => {
    const clock = new Clock();
    const a = new TopologyAggregator(clock.now);
    a.ingest(progressEvent({ cluster_id: 'c-run', agent_id: 'm-1' }));
    clock.advance(60_000);
    expect(Object.keys(a.liveClusters())).toEqual(['c-run']);
  });
});


// ---------------------------------------------------------------------------
// PR-E1 iteration_n surface
// ---------------------------------------------------------------------------


describe('TopologyAggregator iteration tagging', () => {
  it('records iteration_n from inbound TASK_PROGRESS payloads', () => {
    const a = new TopologyAggregator();
    a.ingest(progressEvent({
      cluster_id: 'c-iter', agent_id: 'm-1', iteration_n: 2,
    }));
    expect(a.get()['c-iter']!.members['m-1']!.iteration_n).toBe(2);
  });
});


// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------


describe('TopologyAggregator.reset', () => {
  it('drops every cluster + member', () => {
    const a = new TopologyAggregator();
    a.ingest(progressEvent({ cluster_id: 'c-1', agent_id: 'm-1' }));
    a.reset();
    expect(a.get()).toEqual({});
  });
});
