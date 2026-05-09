/**
 * Prompt channel — wire-format builder + correlator for ad-hoc
 * dispatch.  Mirrors the shape of `acc/channels/tui.py:80-165` so
 * the panel is bus-compatible with the runtime TUI's screen 7.
 *
 * The pure-fn parts (build / correlate) are unit-tested without a
 * live NATS broker.  The live `PromptChannel` is a thin wrapper
 * around `@msgpack/msgpack` + `nats` that the panel uses
 * end-to-end.
 *
 * Wire shapes (audited against runtime `main`):
 *
 *   TASK_ASSIGN:
 *     subject = `acc.{collective_id}.task`
 *     payload = {
 *       signal_type:      "TASK_ASSIGN",
 *       task_id:          uuid,
 *       plan_id:          "ad-hoc",
 *       step_id:          "ad-hoc-1",
 *       collective_id:    cid,
 *       from_agent:       "pd-extension",
 *       target_role:      <selected>,
 *       target_agent_id?: <selected, optional>,
 *       task_type:        "ADHOC" or operator-supplied,
 *       task_description: <prompt>,
 *       priority:         "NORMAL",
 *       iteration_n:      0,
 *       max_iterations:   1,
 *       ts:               unix-seconds,
 *     }
 *
 *   TASK_COMPLETE (subscribed on the same subject; filter by
 *   signal_type + task_id):
 *     payload = { signal_type:"TASK_COMPLETE", task_id, agent_id,
 *                 blocked, block_reason, latency_ms, output, ... }
 *
 *   TASK_PROGRESS (optional; subject `acc.{cid}.task.progress`,
 *   correlate by task_id):
 *     payload = { signal_type:"TASK_PROGRESS", task_id, agent_id,
 *                 progress: { step_label, current_step, ... } }
 */

import { connect, type NatsConnection, type Subscription } from 'nats';
import { encode as msgpackEncode } from '@msgpack/msgpack';
import { randomUUID } from 'node:crypto';

import { decodeFrame } from '../cluster/subscriber';


export interface BuildAssignOptions {
  collectiveId: string;
  taskDescription: string;
  targetRole: string;
  targetAgentId?: string;
  taskType?: string;
  /** Defaults to `randomUUID()` if not supplied — set explicitly in tests for determinism. */
  taskId?: string;
  /** Defaults to `Date.now() / 1000`. */
  ts?: number;
  /** Defaults to "pd-extension" — surfaces as the from_agent on telemetry. */
  fromAgent?: string;
}


export interface AssignBuilt {
  subject: string;
  /** Decoded payload — handy for tests. */
  payload: Record<string, unknown>;
  /** msgpack(<utf-8 JSON bytes>) — the literal bus frame. */
  frame: Uint8Array;
  /** Echoed for caller convenience. */
  taskId: string;
}


export function buildTaskAssign(opts: BuildAssignOptions): AssignBuilt {
  const taskId = opts.taskId ?? randomUUID();
  const ts = opts.ts ?? Date.now() / 1000;
  const payload: Record<string, unknown> = {
    signal_type: 'TASK_ASSIGN',
    task_id: taskId,
    plan_id: 'ad-hoc',
    step_id: 'ad-hoc-1',
    collective_id: opts.collectiveId,
    from_agent: opts.fromAgent ?? 'pd-extension',
    target_role: opts.targetRole,
    task_type: opts.taskType?.trim() || 'ADHOC',
    task_description: opts.taskDescription,
    priority: 'NORMAL',
    iteration_n: 0,
    max_iterations: 1,
    ts,
  };
  if (opts.targetAgentId && opts.targetAgentId.trim().length > 0) {
    payload['target_agent_id'] = opts.targetAgentId.trim();
  }
  const innerJson = JSON.stringify(payload);
  const innerBytes = new TextEncoder().encode(innerJson);
  const frame = msgpackEncode(innerBytes);
  return {
    subject: `acc.${opts.collectiveId}.task`,
    payload,
    frame,
    taskId,
  };
}


export interface CompletionPayload {
  agent_id: string;
  task_id: string;
  blocked: boolean;
  block_reason: string;
  latency_ms: number;
  output: string;
  cluster_id?: string;
  /** Echoed full payload for the panel to display extras. */
  raw: Record<string, unknown>;
}


/**
 * Match a decoded frame against the awaited task_id and return a
 * normalized completion payload.  Returns null when the frame is
 * not a TASK_COMPLETE for that task.
 */
export function correlateTaskComplete(
  decoded: Record<string, unknown> | null,
  taskId: string,
): CompletionPayload | null {
  if (decoded === null || typeof decoded !== 'object') {
    return null;
  }
  if (String(decoded['signal_type'] ?? '') !== 'TASK_COMPLETE') {
    return null;
  }
  if (String(decoded['task_id'] ?? '') !== taskId) {
    return null;
  }
  return {
    agent_id: String(decoded['agent_id'] ?? ''),
    task_id: taskId,
    blocked: Boolean(decoded['blocked']),
    block_reason: String(decoded['block_reason'] ?? ''),
    latency_ms: typeof decoded['latency_ms'] === 'number'
      ? (decoded['latency_ms'] as number)
      : 0,
    output: String(decoded['output'] ?? ''),
    cluster_id: typeof decoded['cluster_id'] === 'string'
      ? (decoded['cluster_id'] as string)
      : undefined,
    raw: decoded,
  };
}


export interface ProgressPayload {
  agent_id: string;
  task_id: string;
  step_label: string;
  current_step: number;
  total_steps: number;
}


export function correlateTaskProgress(
  decoded: Record<string, unknown> | null,
  taskId: string,
): ProgressPayload | null {
  if (decoded === null || typeof decoded !== 'object') {
    return null;
  }
  if (String(decoded['signal_type'] ?? '') !== 'TASK_PROGRESS') {
    return null;
  }
  if (String(decoded['task_id'] ?? '') !== taskId) {
    return null;
  }
  // The runtime nests step counters inside `progress`, but some
  // builds also flatten them — accept both.
  const progress = decoded['progress'];
  const nested =
    progress !== null && typeof progress === 'object'
      ? (progress as Record<string, unknown>)
      : decoded;
  return {
    agent_id: String(decoded['agent_id'] ?? ''),
    task_id: taskId,
    step_label: String(nested['step_label'] ?? ''),
    current_step: numField(nested, 'current_step'),
    total_steps: numField(nested, 'total_steps'),
  };
}


function numField(p: Record<string, unknown>, key: string): number {
  const v = p[key];
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0;
}


// ---------------------------------------------------------------------------
// Live channel — connects, sends, awaits, drains.
// ---------------------------------------------------------------------------


export interface ChannelOptions {
  natsUrl: string;
  collectiveId: string;
  /** Default per-task timeout when the caller doesn't pass one. */
  defaultTimeoutMs?: number;
}


export class PromptChannel {
  private nc: NatsConnection | undefined;
  private taskSub: Subscription | undefined;
  private progressSub: Subscription | undefined;
  private listeners = new Map<
    string,
    {
      onComplete: (c: CompletionPayload) => void;
      onProgress: (p: ProgressPayload) => void;
      onError: (e: Error) => void;
    }
  >();

  constructor(private readonly opts: ChannelOptions) {}

  async connect(): Promise<void> {
    if (this.nc !== undefined) {
      return;
    }
    this.nc = await connect({ servers: this.opts.natsUrl });
    this.taskSub = this.nc.subscribe(`acc.${this.opts.collectiveId}.task`);
    this.progressSub = this.nc.subscribe(`acc.${this.opts.collectiveId}.task.progress`);
    void this.runTaskLoop();
    void this.runProgressLoop();
  }

  /**
   * Publish a TASK_ASSIGN, return the task_id immediately + a
   * promise that resolves when the matching TASK_COMPLETE arrives
   * (or rejects on timeout).
   */
  async send(
    opts: Omit<BuildAssignOptions, 'collectiveId'> & {
      timeoutMs?: number;
      onProgress?: (p: ProgressPayload) => void;
    },
  ): Promise<{ taskId: string; completion: Promise<CompletionPayload> }> {
    if (this.nc === undefined) {
      throw new Error('PromptChannel.connect() not called');
    }
    const built = buildTaskAssign({
      ...opts,
      collectiveId: this.opts.collectiveId,
    });
    const timeout = opts.timeoutMs ?? this.opts.defaultTimeoutMs ?? 60_000;

    const completion = new Promise<CompletionPayload>((resolve, reject) => {
      const handle = setTimeout(() => {
        this.listeners.delete(built.taskId);
        reject(new Error(`Timed out after ${timeout} ms`));
      }, timeout);
      this.listeners.set(built.taskId, {
        onComplete: (c) => {
          clearTimeout(handle);
          this.listeners.delete(built.taskId);
          resolve(c);
        },
        onProgress: opts.onProgress ?? (() => {}),
        onError: (e) => {
          clearTimeout(handle);
          this.listeners.delete(built.taskId);
          reject(e);
        },
      });
    });

    this.nc.publish(built.subject, built.frame);
    return { taskId: built.taskId, completion };
  }

  async close(): Promise<void> {
    for (const l of this.listeners.values()) {
      try {
        l.onError(new Error('channel closed'));
      } catch {
        // best-effort
      }
    }
    this.listeners.clear();
    if (this.taskSub !== undefined) {
      try {
        this.taskSub.unsubscribe();
      } catch {
        // best-effort
      }
      this.taskSub = undefined;
    }
    if (this.progressSub !== undefined) {
      try {
        this.progressSub.unsubscribe();
      } catch {
        // best-effort
      }
      this.progressSub = undefined;
    }
    if (this.nc !== undefined) {
      try {
        await this.nc.drain();
      } catch {
        // best-effort
      }
      this.nc = undefined;
    }
  }

  private async runTaskLoop(): Promise<void> {
    if (this.taskSub === undefined) {
      return;
    }
    for await (const msg of this.taskSub) {
      const decoded = decodeFrame(msg.data);
      if (decoded === null) {
        continue;
      }
      const taskId = String(decoded['task_id'] ?? '');
      if (!taskId) {
        continue;
      }
      const listener = this.listeners.get(taskId);
      if (listener === undefined) {
        continue;
      }
      const c = correlateTaskComplete(decoded, taskId);
      if (c !== null) {
        try {
          listener.onComplete(c);
        } catch {
          // best-effort
        }
      }
    }
  }

  private async runProgressLoop(): Promise<void> {
    if (this.progressSub === undefined) {
      return;
    }
    for await (const msg of this.progressSub) {
      const decoded = decodeFrame(msg.data);
      if (decoded === null) {
        continue;
      }
      const taskId = String(decoded['task_id'] ?? '');
      const listener = this.listeners.get(taskId);
      if (listener === undefined) {
        continue;
      }
      const p = correlateTaskProgress(decoded, taskId);
      if (p !== null) {
        try {
          listener.onProgress(p);
        } catch {
          // best-effort
        }
      }
    }
  }
}
