/**
 * Performance aggregator — pure TS port of the parts of
 * `acc/tui/client.py` that feed the TUI Performance screen, plus
 * a client-side ring buffer for drift-score sparklines.
 *
 * Folds four signal types:
 *   * `HEARTBEAT`        → per-agent queue + backpressure +
 *                          latency + token_budget_utilization +
 *                          drift_score + domain_drift_score.
 *   * `TASK_PROGRESS`    → per-agent task progress label + step
 *                          counters.
 *   * `TASK_COMPLETE`    → folds `invocations[]` into
 *                          capability_stats keyed by `kind:target`;
 *                          accumulates `tokens_used` per
 *                          `plan_id` (when present, else
 *                          `cluster_id`, else 'global').
 *   * `PLAN`             → captures `max_run_tokens` per plan_id
 *                          for the cost-cap progress bar.
 *
 * Drift history is built client-side because the runtime publishes
 * only point-in-time scalars on HEARTBEAT (no time series wire
 * shape exists today).
 */


export const SIG_HEARTBEAT = 'HEARTBEAT' as const;
export const SIG_TASK_PROGRESS = 'TASK_PROGRESS' as const;
export const SIG_TASK_COMPLETE = 'TASK_COMPLETE' as const;
export const SIG_PLAN = 'PLAN' as const;


export type BackpressureState = 'OPEN' | 'THROTTLE' | 'CLOSED' | 'UNKNOWN';


export interface AgentPerf {
  agent_id: string;
  role_id: string;
  queue_depth: number;
  backpressure_state: BackpressureState;
  last_task_latency_ms: number;
  token_budget_utilization: number;
  drift_score: number;
  domain_drift_score: number;
  current_task_step: number;
  total_task_steps: number;
  task_progress_label: string;
  /** Wall-clock seconds of the last heartbeat. */
  last_seen: number;
  /** Client-side ring buffer of recent drift readings (newest last). */
  drift_history: number[];
}


export interface CapabilityStat {
  /** `skill` | `mcp`. */
  kind: string;
  /** Skill id or `<server>.<tool>` for MCPs. */
  target: string;
  total: number;
  ok: number;
  fail: number;
  last_error: string;
  last_seen: number;
}


export interface PlanCost {
  plan_id: string;
  tokens_used: number;
  max_run_tokens: number;
  /** Last time tokens_used grew. */
  last_seen: number;
}


export interface PerfSnapshot {
  agents: Record<string, AgentPerf>;
  /** Keyed by `kind:target`. */
  capabilityStats: Record<string, CapabilityStat>;
  /** Keyed by plan_id. */
  planCosts: Record<string, PlanCost>;
  /** Latency percentiles across non-stale agents (or 0 when empty). */
  latency: { p50: number; p90: number; p95: number; p99: number };
}


export const DRIFT_HISTORY_CAPACITY = 32;
/** Agents past this age are excluded from latency percentiles. */
export const STALENESS_S = 30.0;


export class PerformanceAggregator {
  private snapshot: PerfSnapshot = emptySnapshot();

  getSnapshot(): PerfSnapshot {
    return this.snapshot;
  }

  /** Fold a decoded payload into the snapshot.  Returns true when state changed. */
  ingest(p: Record<string, unknown>, now: number = Date.now() / 1000): boolean {
    const sig = String(p['signal_type'] ?? '');
    if (sig === SIG_HEARTBEAT) {
      return this.foldHeartbeat(p, now);
    }
    if (sig === SIG_TASK_PROGRESS) {
      return this.foldTaskProgress(p, now);
    }
    if (sig === SIG_TASK_COMPLETE) {
      return this.foldTaskComplete(p, now);
    }
    if (sig === SIG_PLAN) {
      return this.foldPlan(p, now);
    }
    return false;
  }

  // -------------------------------------------------------------------------

  private foldHeartbeat(p: Record<string, unknown>, now: number): boolean {
    const agentId = String(p['agent_id'] ?? '');
    if (!agentId) {
      return false;
    }
    const prior = this.snapshot.agents[agentId];
    const drift = numField(p, 'drift_score', prior?.drift_score ?? 0);
    const driftHistory = appendCapped(
      prior?.drift_history ?? [],
      drift,
      DRIFT_HISTORY_CAPACITY,
    );
    const next: AgentPerf = {
      agent_id: agentId,
      role_id: String(p['role_id'] ?? p['role'] ?? prior?.role_id ?? ''),
      queue_depth: intField(p, 'queue_depth'),
      backpressure_state: coerceBackpressure(p['backpressure_state']),
      last_task_latency_ms: numField(p, 'last_task_latency_ms', 0),
      token_budget_utilization: numField(p, 'token_budget_utilization', 0),
      drift_score: drift,
      domain_drift_score: numField(p, 'domain_drift_score', 0),
      current_task_step: prior?.current_task_step ?? 0,
      total_task_steps: prior?.total_task_steps ?? 0,
      task_progress_label: prior?.task_progress_label ?? '',
      last_seen: now,
      drift_history: driftHistory,
    };
    this.snapshot.agents = { ...this.snapshot.agents, [agentId]: next };
    this.snapshot.latency = computeLatency(this.snapshot.agents, now);
    return true;
  }

  private foldTaskProgress(p: Record<string, unknown>, now: number): boolean {
    const agentId = String(p['agent_id'] ?? '');
    if (!agentId) {
      return false;
    }
    const prior = this.snapshot.agents[agentId] ?? blankAgent(agentId, now);
    const next: AgentPerf = {
      ...prior,
      current_task_step: intField(p, 'current_step', prior.current_task_step),
      total_task_steps: intField(p, 'total_steps', prior.total_task_steps),
      task_progress_label: String(p['step_label'] ?? prior.task_progress_label),
      last_seen: now,
    };
    this.snapshot.agents = { ...this.snapshot.agents, [agentId]: next };
    return true;
  }

  private foldTaskComplete(p: Record<string, unknown>, now: number): boolean {
    let changed = false;
    const agentId = String(p['agent_id'] ?? '');

    // (1) capability_stats fold from invocations[].
    const inv = p['invocations'];
    if (Array.isArray(inv)) {
      const next: Record<string, CapabilityStat> = { ...this.snapshot.capabilityStats };
      for (const raw of inv) {
        if (raw === null || typeof raw !== 'object') {
          continue;
        }
        const r = raw as Record<string, unknown>;
        const kind = String(r['kind'] ?? '');
        const target = String(r['target'] ?? '');
        if (!kind || !target) {
          continue;
        }
        const ok = Boolean(r['ok']);
        const error = String(r['error'] ?? '');
        const key = `${kind}:${target}`;
        const cur = next[key];
        next[key] = {
          kind,
          target,
          total: (cur?.total ?? 0) + 1,
          ok: (cur?.ok ?? 0) + (ok ? 1 : 0),
          fail: (cur?.fail ?? 0) + (ok ? 0 : 1),
          last_error: ok ? cur?.last_error ?? '' : error || cur?.last_error || '',
          last_seen: now,
        };
        changed = true;
      }
      this.snapshot.capabilityStats = next;
    }

    // (2) latency observation — TASK_COMPLETE may carry latency_ms.
    if (agentId) {
      const lat = numField(p, 'latency_ms', 0);
      if (lat > 0) {
        const prior = this.snapshot.agents[agentId] ?? blankAgent(agentId, now);
        this.snapshot.agents = {
          ...this.snapshot.agents,
          [agentId]: { ...prior, last_task_latency_ms: lat, last_seen: now },
        };
        this.snapshot.latency = computeLatency(this.snapshot.agents, now);
        changed = true;
      }
    }

    // (3) plan-level cost accumulation.
    const tokens = intField(p, 'tokens_used');
    if (tokens > 0) {
      const planId =
        String(p['plan_id'] ?? '') ||
        String(p['cluster_id'] ?? '') ||
        'global';
      const cur = this.snapshot.planCosts[planId];
      this.snapshot.planCosts = {
        ...this.snapshot.planCosts,
        [planId]: {
          plan_id: planId,
          tokens_used: (cur?.tokens_used ?? 0) + tokens,
          max_run_tokens: cur?.max_run_tokens ?? 0,
          last_seen: now,
        },
      };
      changed = true;
    }

    return changed;
  }

  private foldPlan(p: Record<string, unknown>, now: number): boolean {
    const planId = String(p['plan_id'] ?? '');
    const max = intField(p, 'max_run_tokens');
    if (!planId || max <= 0) {
      return false;
    }
    const cur = this.snapshot.planCosts[planId];
    this.snapshot.planCosts = {
      ...this.snapshot.planCosts,
      [planId]: {
        plan_id: planId,
        tokens_used: cur?.tokens_used ?? 0,
        max_run_tokens: max,
        last_seen: now,
      },
    };
    return true;
  }
}


// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------


function emptySnapshot(): PerfSnapshot {
  return {
    agents: {},
    capabilityStats: {},
    planCosts: {},
    latency: { p50: 0, p90: 0, p95: 0, p99: 0 },
  };
}


function blankAgent(agentId: string, now: number): AgentPerf {
  return {
    agent_id: agentId,
    role_id: '',
    queue_depth: 0,
    backpressure_state: 'UNKNOWN',
    last_task_latency_ms: 0,
    token_budget_utilization: 0,
    drift_score: 0,
    domain_drift_score: 0,
    current_task_step: 0,
    total_task_steps: 0,
    task_progress_label: '',
    last_seen: now,
    drift_history: [],
  };
}


function numField(
  p: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const v = p[key];
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v;
  }
  return fallback;
}


function intField(
  p: Record<string, unknown>,
  key: string,
  fallback = 0,
): number {
  const v = p[key];
  if (typeof v === 'number' && Number.isFinite(v)) {
    return Math.trunc(v);
  }
  return fallback;
}


function coerceBackpressure(v: unknown): BackpressureState {
  const s = String(v ?? '').toUpperCase();
  if (s === 'OPEN' || s === 'THROTTLE' || s === 'CLOSED') {
    return s;
  }
  return 'UNKNOWN';
}


function appendCapped(prior: number[], v: number, cap: number): number[] {
  const next = [...prior, v];
  if (next.length > cap) {
    return next.slice(next.length - cap);
  }
  return next;
}


/**
 * Compute p50/p90/p95/p99 over non-stale agents' last_task_latency_ms.
 * Returns zeros when no agent has reported a latency value yet.
 */
function computeLatency(
  agents: Record<string, AgentPerf>,
  now: number,
): { p50: number; p90: number; p95: number; p99: number } {
  const values: number[] = [];
  for (const a of Object.values(agents)) {
    if (now - a.last_seen > STALENESS_S) {
      continue;
    }
    if (a.last_task_latency_ms > 0) {
      values.push(a.last_task_latency_ms);
    }
  }
  if (values.length === 0) {
    return { p50: 0, p90: 0, p95: 0, p99: 0 };
  }
  values.sort((a, b) => a - b);
  return {
    p50: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
  };
}


function percentile(sorted: number[], q: number): number {
  // Nearest-rank, clamped to the array bounds.  Matches what
  // `acc/tui/models.py:CollectiveSnapshot.latency_percentiles`
  // does for a tiny sample.
  if (sorted.length === 0) {
    return 0;
  }
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(q * sorted.length) - 1),
  );
  return sorted[idx] ?? 0;
}
