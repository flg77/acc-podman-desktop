/**
 * Cluster topology aggregator — pure TS port of the TUI's
 * `acc/tui/client.py:_update_cluster_topology` logic.
 *
 * Folds cluster-tagged TASK_PROGRESS + TASK_COMPLETE payloads into
 * a per-cluster snapshot the webview renders.  Schema mirrors the
 * runtime's `CollectiveSnapshot.cluster_topology` exactly so the
 * extension carries the same data the TUI does, render-equivalent
 * but in a different front end.
 *
 * Schema reference: `docs/IMPLEMENTATION_subagent_clustering.md` § PR #29.
 */

/** Wire-shape constants matching `acc/signals.py`. */
export const SIG_TASK_PROGRESS = 'TASK_PROGRESS' as const;
export const SIG_TASK_COMPLETE = 'TASK_COMPLETE' as const;

/** A cluster member's per-step state. */
export interface MemberState {
  /** task_id from the inbound TASK_ASSIGN that started this member. */
  task_id: string;
  /** Most recent step_label the member published. */
  step_label: string;
  /** 1-based step index of the most recent TASK_PROGRESS. */
  current_step: number;
  /** Total estimated steps for the member's task. */
  total_steps: number;
  /** running | complete | blocked. */
  status: 'running' | 'complete' | 'blocked';
  /** Skill the member is currently invoking (parsed from step_label). */
  skill_in_use: string;
  /** Wall-clock seconds of the last observation. */
  last_seen: number;
  /** PR-E1 — current iteration number on this task_id (0 = first run). */
  iteration_n?: number;
}

/** Per-cluster row carried in the snapshot. */
export interface ClusterRow {
  cluster_id: string;
  target_role: string;
  /** Running max of witnessed members. */
  subagent_count: number;
  members: Record<string, MemberState>;
  created_at: number;
  /** Stamped when every observed member has reported. */
  finished_at: number | null;
  reason: string;
}

/** Top-level snapshot — keyed by cluster_id. */
export type TopologySnapshot = Record<string, ClusterRow>;

/** 30 s grace window after a cluster finishes — parity with TUI. */
export const FINISHED_GRACE_S = 30.0;


// ---------------------------------------------------------------------------
// Skill / MCP extraction from step_label
// ---------------------------------------------------------------------------


/**
 * Parse the canonical step_label "Calling skill:<name>" /
 * "Calling mcp:<server>.<tool>" emitted by
 * `acc/capability_dispatch.py`.  Returns "" when the label
 * doesn't match either pattern.
 *
 * Examples:
 *   "Calling skill:code_review"        → "code_review"
 *   "Calling mcp:fs.read"              → "mcp:fs.read"
 *   "Pre-reasoning gate (Cat-B)"       → ""
 */
export function extractSkillInUse(stepLabel: string): string {
  const lower = stepLabel.toLowerCase();
  const sIdx = lower.indexOf('skill:');
  if (sIdx >= 0) {
    const tail = stepLabel.slice(sIdx + 'skill:'.length).trim();
    return tail.split(/\s+/)[0] ?? '';
  }
  const mIdx = lower.indexOf('mcp:');
  if (mIdx >= 0) {
    const tail = stepLabel.slice(mIdx + 'mcp:'.length).trim();
    return 'mcp:' + (tail.split(/\s+/)[0] ?? '');
  }
  return '';
}


// ---------------------------------------------------------------------------
// Aggregator
// ---------------------------------------------------------------------------


export class TopologyAggregator {
  private snapshot: TopologySnapshot = {};

  /** Inject a clock for tests. */
  constructor(private readonly nowSec: () => number = () => Date.now() / 1000) {}

  /** Read-only snapshot.  Callers must NOT mutate. */
  get(): TopologySnapshot {
    return this.snapshot;
  }

  /**
   * Fold one signal payload into the snapshot.  Returns true when
   * the snapshot was modified, so callers can skip a redundant
   * webview re-render.
   */
  ingest(payload: Record<string, unknown>): boolean {
    const clusterId = String(payload['cluster_id'] ?? '');
    if (!clusterId) {
      return false;
    }
    const signalType = String(payload['signal_type'] ?? '');
    if (signalType !== SIG_TASK_PROGRESS && signalType !== SIG_TASK_COMPLETE) {
      return false;
    }
    const agentId = String(payload['agent_id'] ?? '');
    if (!agentId) {
      return false;
    }

    const row: ClusterRow = this.snapshot[clusterId] ?? {
      cluster_id: clusterId,
      target_role: '',
      subagent_count: 0,
      members: {},
      created_at: this.nowSec(),
      finished_at: null,
      reason: '',
    };
    this.snapshot[clusterId] = row;

    const member: MemberState = row.members[agentId] ?? {
      task_id: String(payload['task_id'] ?? ''),
      step_label: '',
      current_step: 0,
      total_steps: 0,
      status: 'running',
      skill_in_use: '',
      last_seen: this.nowSec(),
    };
    row.members[agentId] = member;

    if (signalType === SIG_TASK_PROGRESS) {
      const progress = (payload['progress'] as Record<string, unknown>) ?? {};
      const label = String(
        progress['step_label'] ?? payload['step_label'] ?? '',
      );
      member.step_label = label;
      member.current_step = Number(
        progress['current_step'] ?? payload['current_step'] ?? member.current_step,
      ) || 0;
      member.total_steps = Number(
        progress['total_steps_estimated'] ??
          payload['total_steps'] ??
          member.total_steps,
      ) || 0;
      member.last_seen = this.nowSec();
      const extracted = extractSkillInUse(label);
      if (extracted) {
        member.skill_in_use = extracted;
      }
      // PR-E1 — surface iteration_n when the runtime tags it.
      if (payload['iteration_n'] !== undefined) {
        member.iteration_n = Number(payload['iteration_n']) || 0;
      }
    } else {
      // SIG_TASK_COMPLETE
      const blocked = Boolean(payload['blocked']);
      member.status = blocked ? 'blocked' : 'complete';
      member.last_seen = this.nowSec();
      const done = Object.values(row.members).filter(
        (m) => m.status === 'complete' || m.status === 'blocked',
      ).length;
      if (row.subagent_count && done >= row.subagent_count) {
        row.finished_at = this.nowSec();
      }
    }

    // subagent_count: running max of witnessed members.
    row.subagent_count = Math.max(
      row.subagent_count,
      Object.keys(row.members).length,
    );
    return true;
  }

  /**
   * Clusters that have finished and outlived the grace window are
   * dropped from the snapshot the renderer consumes.  Aggregator
   * itself keeps full fidelity until the next ingest replaces them.
   */
  liveClusters(): TopologySnapshot {
    const now = this.nowSec();
    const live: TopologySnapshot = {};
    for (const [cid, row] of Object.entries(this.snapshot)) {
      if (row.finished_at !== null && now - row.finished_at > FINISHED_GRACE_S) {
        continue;
      }
      live[cid] = row;
    }
    return live;
  }

  /** Reset — for tests and "re-subscribe" flows. */
  reset(): void {
    this.snapshot = {};
  }
}
