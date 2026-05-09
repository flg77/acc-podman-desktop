/**
 * Compliance aggregator — pure TS port of the parts of
 * `acc/tui/client.py` that feed the TUI Compliance screen.
 *
 * Folds three signal types into a single snapshot the panel
 * renders:
 *
 *   * `HEARTBEAT` (subject `acc.{cid}.heartbeat`) — per-agent
 *     compliance_health_score, owasp_violation_count,
 *     oversight_pending_count, cat_a_trigger_count,
 *     cat_b_trigger_count.  Arbiter heartbeats also carry
 *     `oversight_pending_items: OversightItem[]` for the queue.
 *
 *   * `EVAL_OUTCOME` (subject `acc.{cid}.eval.{task_id}`) —
 *     `owasp_violations: [{code, risk_level, pattern}]` are folded
 *     into the rolling violation log (keeps the last 50 entries —
 *     parity with `screens/compliance.py`).
 *
 *   * `ALERT_ESCALATE` (subject `acc.{cid}.alert`) — increments the
 *     per-agent Cat-A or Cat-B trigger count depending on whether
 *     `reason` contains `cat_a` / `cat-a` (substring match — parity
 *     with `client.py:549`).
 *
 * Pure-fn: no NATS dependency, no clock dependency for ingest
 * (callers pass `now` for timestamp folds).  Trivially unit-testable.
 */


export const SIG_HEARTBEAT = 'HEARTBEAT' as const;
export const SIG_EVAL_OUTCOME = 'EVAL_OUTCOME' as const;
export const SIG_ALERT_ESCALATE = 'ALERT_ESCALATE' as const;


/** OWASP-LLM top-ten codes — fixed order so the renderer table is stable. */
export const OWASP_CODES: readonly string[] = [
  'LLM01', 'LLM02', 'LLM03', 'LLM04', 'LLM05',
  'LLM06', 'LLM07', 'LLM08', 'LLM09', 'LLM10',
];


export interface AgentCompliance {
  agent_id: string;
  role_id: string;
  compliance_health_score: number;
  owasp_violation_count: number;
  oversight_pending_count: number;
  cat_a_trigger_count: number;
  cat_b_trigger_count: number;
  /** Wall-clock seconds of the last heartbeat. */
  last_seen: number;
}


export interface ViolationLogEntry {
  ts: number;
  code: string;
  agent_id: string;
  risk_level: string;
  pattern: string;
}


/** Mirrors the runtime's `OversightItem` (subset the panel needs). */
export interface OversightItem {
  oversight_id: string;
  task_id: string;
  risk_level: string;
  summary: string;
  role_id: string;
  agent_id: string;
  submitted_at_ms: number;
  timeout_ms: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
}


export interface ComplianceSnapshot {
  /** Per-agent rollup keyed by agent_id. */
  agents: Record<string, AgentCompliance>;
  /** Pending oversight items (sourced from arbiter HEARTBEAT). */
  oversightPending: OversightItem[];
  /** Last 50 OWASP violation entries — newest last. */
  violationLog: ViolationLogEntry[];
  /** Cumulative count per OWASP code. */
  owaspCounts: Record<string, number>;
  /** Collective health = min over non-stale agents (or 1.0 when empty). */
  collectiveHealth: number;
}


export const VIOLATION_LOG_CAPACITY = 50;
/** An agent counts as "stale" beyond this — excluded from collective min. */
export const STALENESS_S = 30.0;


export class ComplianceAggregator {
  private snapshot: ComplianceSnapshot = emptySnapshot();

  getSnapshot(): ComplianceSnapshot {
    return this.snapshot;
  }

  /**
   * Fold a single decoded message into the snapshot.  Returns true
   * when the snapshot changed in any observable way.
   */
  ingest(payload: Record<string, unknown>, now: number = Date.now() / 1000): boolean {
    const sig = String(payload['signal_type'] ?? '');
    if (sig === SIG_HEARTBEAT) {
      return this.foldHeartbeat(payload, now);
    }
    if (sig === SIG_EVAL_OUTCOME) {
      return this.foldEvalOutcome(payload, now);
    }
    if (sig === SIG_ALERT_ESCALATE) {
      return this.foldAlertEscalate(payload, now);
    }
    return false;
  }

  // -------------------------------------------------------------------------

  private foldHeartbeat(p: Record<string, unknown>, now: number): boolean {
    const agentId = String(p['agent_id'] ?? '');
    if (!agentId) {
      return false;
    }
    const roleId = String(p['role_id'] ?? p['role'] ?? '');
    const next: AgentCompliance = {
      agent_id: agentId,
      role_id: roleId,
      compliance_health_score: numField(p, 'compliance_health_score', 1.0),
      owasp_violation_count: intField(p, 'owasp_violation_count'),
      oversight_pending_count: intField(p, 'oversight_pending_count'),
      cat_a_trigger_count: intField(p, 'cat_a_trigger_count'),
      cat_b_trigger_count: intField(p, 'cat_b_trigger_count'),
      last_seen: now,
    };
    this.snapshot.agents = { ...this.snapshot.agents, [agentId]: next };
    // Arbiter heartbeats carry the oversight queue.
    if (roleId === 'arbiter') {
      const items = p['oversight_pending_items'];
      if (Array.isArray(items)) {
        this.snapshot.oversightPending = items
          .filter((x): x is Record<string, unknown> =>
            typeof x === 'object' && x !== null,
          )
          .map(coerceOversightItem)
          .filter((x) => x.status === 'PENDING');
      }
    }
    this.snapshot.collectiveHealth = computeCollectiveHealth(
      this.snapshot.agents,
      now,
    );
    return true;
  }

  private foldEvalOutcome(p: Record<string, unknown>, now: number): boolean {
    const violations = p['owasp_violations'];
    if (!Array.isArray(violations) || violations.length === 0) {
      return false;
    }
    const agentId = String(p['agent_id'] ?? p['producer_id'] ?? '');
    let changed = false;
    for (const raw of violations) {
      if (raw === null || typeof raw !== 'object') {
        continue;
      }
      const v = raw as Record<string, unknown>;
      const code = String(v['code'] ?? '');
      if (!code) {
        continue;
      }
      const entry: ViolationLogEntry = {
        ts: numField(p, 'ts', now),
        code,
        agent_id: agentId,
        risk_level: String(v['risk_level'] ?? ''),
        pattern: String(v['pattern'] ?? ''),
      };
      this.snapshot.violationLog = [
        ...this.snapshot.violationLog.slice(
          Math.max(0, this.snapshot.violationLog.length - VIOLATION_LOG_CAPACITY + 1),
        ),
        entry,
      ];
      this.snapshot.owaspCounts = {
        ...this.snapshot.owaspCounts,
        [code]: (this.snapshot.owaspCounts[code] ?? 0) + 1,
      };
      changed = true;
    }
    return changed;
  }

  private foldAlertEscalate(p: Record<string, unknown>, _now: number): boolean {
    const agentId = String(p['agent_id'] ?? '');
    if (!agentId) {
      return false;
    }
    const reason = String(p['reason'] ?? '').toLowerCase();
    const isCatA = reason.includes('cat_a') || reason.includes('cat-a');
    const cur = this.snapshot.agents[agentId];
    const next: AgentCompliance = {
      agent_id: agentId,
      role_id: cur?.role_id ?? '',
      compliance_health_score: cur?.compliance_health_score ?? 1.0,
      owasp_violation_count: cur?.owasp_violation_count ?? 0,
      oversight_pending_count: cur?.oversight_pending_count ?? 0,
      cat_a_trigger_count: (cur?.cat_a_trigger_count ?? 0) + (isCatA ? 1 : 0),
      cat_b_trigger_count: (cur?.cat_b_trigger_count ?? 0) + (isCatA ? 0 : 1),
      last_seen: cur?.last_seen ?? 0,
    };
    this.snapshot.agents = { ...this.snapshot.agents, [agentId]: next };
    return true;
  }
}


// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------


function emptySnapshot(): ComplianceSnapshot {
  const owaspCounts: Record<string, number> = {};
  for (const c of OWASP_CODES) {
    owaspCounts[c] = 0;
  }
  return {
    agents: {},
    oversightPending: [],
    violationLog: [],
    owaspCounts,
    collectiveHealth: 1.0,
  };
}


function numField(p: Record<string, unknown>, key: string, fallback: number): number {
  const v = p[key];
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v;
  }
  return fallback;
}


function intField(p: Record<string, unknown>, key: string): number {
  const v = p[key];
  if (typeof v === 'number' && Number.isFinite(v)) {
    return Math.trunc(v);
  }
  return 0;
}


function coerceOversightItem(raw: Record<string, unknown>): OversightItem {
  return {
    oversight_id: String(raw['oversight_id'] ?? ''),
    task_id: String(raw['task_id'] ?? ''),
    risk_level: String(raw['risk_level'] ?? ''),
    summary: String(raw['summary'] ?? ''),
    role_id: String(raw['role_id'] ?? ''),
    agent_id: String(raw['agent_id'] ?? ''),
    submitted_at_ms: numField(raw, 'submitted_at_ms', 0),
    timeout_ms: numField(raw, 'timeout_ms', 0),
    status: (String(raw['status'] ?? 'PENDING') as OversightItem['status']),
  };
}


function computeCollectiveHealth(
  agents: Record<string, AgentCompliance>,
  now: number,
): number {
  let min = 1.0;
  let any = false;
  for (const a of Object.values(agents)) {
    if (now - a.last_seen > STALENESS_S) {
      continue;
    }
    any = true;
    if (a.compliance_health_score < min) {
      min = a.compliance_health_score;
    }
  }
  return any ? min : 1.0;
}
