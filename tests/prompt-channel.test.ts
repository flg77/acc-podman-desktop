/**
 * Prompt channel — wire-format builder + correlator tests.
 *
 * The live `PromptChannel` (which opens a NATS connection) is not
 * exercised here; both pure-fn parts cover the wire surface.
 */

import { describe, expect, it } from 'vitest';
import { decode as msgpackDecode } from '@msgpack/msgpack';

import {
  buildTaskAssign,
  correlateTaskComplete,
  correlateTaskProgress,
} from '../src/prompt/channel';


describe('buildTaskAssign', () => {
  it('uses subject `acc.{cid}.task`', () => {
    const built = buildTaskAssign({
      collectiveId: 'sol-01',
      taskDescription: 'hi',
      targetRole: 'coding_agent',
      taskId: 't-1',
      ts: 1234,
    });
    expect(built.subject).toBe('acc.sol-01.task');
  });

  it('emits the canonical TASK_ASSIGN envelope', () => {
    const built = buildTaskAssign({
      collectiveId: 'sol-01',
      taskDescription: 'Generate FizzBuzz tests',
      targetRole: 'coding_agent',
      taskId: 't-abc',
      ts: 1700000000,
    });
    expect(built.payload).toMatchObject({
      signal_type: 'TASK_ASSIGN',
      task_id: 't-abc',
      plan_id: 'ad-hoc',
      step_id: 'ad-hoc-1',
      collective_id: 'sol-01',
      from_agent: 'pd-extension',
      target_role: 'coding_agent',
      task_type: 'ADHOC',
      task_description: 'Generate FizzBuzz tests',
      priority: 'NORMAL',
      iteration_n: 0,
      max_iterations: 1,
      ts: 1700000000,
    });
    expect(built.payload).not.toHaveProperty('target_agent_id');
    expect(built.taskId).toBe('t-abc');
  });

  it('attaches target_agent_id when supplied', () => {
    const built = buildTaskAssign({
      collectiveId: 'sol-01',
      taskDescription: 'x',
      targetRole: 'coding_agent',
      targetAgentId: 'acc-agent-coding-1',
      taskId: 't-1',
    });
    expect(built.payload['target_agent_id']).toBe('acc-agent-coding-1');
  });

  it('omits target_agent_id when blank / whitespace', () => {
    const built = buildTaskAssign({
      collectiveId: 'sol-01',
      taskDescription: 'x',
      targetRole: 'r',
      targetAgentId: '   ',
      taskId: 't-1',
    });
    expect(built.payload).not.toHaveProperty('target_agent_id');
  });

  it('honours operator-supplied taskType', () => {
    const built = buildTaskAssign({
      collectiveId: 'c',
      taskDescription: 'x',
      targetRole: 'r',
      taskType: 'CODE_REVIEW',
      taskId: 't-1',
    });
    expect(built.payload['task_type']).toBe('CODE_REVIEW');
  });

  it('falls back ADHOC for empty task_type', () => {
    const built = buildTaskAssign({
      collectiveId: 'c',
      taskDescription: 'x',
      targetRole: 'r',
      taskType: '   ',
      taskId: 't-1',
    });
    expect(built.payload['task_type']).toBe('ADHOC');
  });

  it('frame is msgpack-of-utf-8-JSON-bytes (decodable round-trip)', () => {
    const built = buildTaskAssign({
      collectiveId: 'sol-01',
      taskDescription: 'hello',
      targetRole: 'coding_agent',
      taskId: 't-x',
      ts: 100,
    });
    const outer = msgpackDecode(built.frame);
    expect(outer).toBeInstanceOf(Uint8Array);
    const text = new TextDecoder('utf-8').decode(outer as Uint8Array);
    const parsed = JSON.parse(text);
    expect(parsed.task_id).toBe('t-x');
    expect(parsed.signal_type).toBe('TASK_ASSIGN');
  });

  it('generates a uuid when taskId not supplied', () => {
    const built = buildTaskAssign({
      collectiveId: 'c',
      taskDescription: 'x',
      targetRole: 'r',
    });
    expect(built.taskId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(built.payload['task_id']).toBe(built.taskId);
  });
});


describe('correlateTaskComplete', () => {
  it('returns null on null / wrong signal / wrong task_id', () => {
    expect(correlateTaskComplete(null, 't-1')).toBeNull();
    expect(
      correlateTaskComplete({ signal_type: 'TASK_PROGRESS', task_id: 't-1' }, 't-1'),
    ).toBeNull();
    expect(
      correlateTaskComplete({ signal_type: 'TASK_COMPLETE', task_id: 't-other' }, 't-1'),
    ).toBeNull();
  });

  it('extracts the canonical fields', () => {
    const c = correlateTaskComplete(
      {
        signal_type: 'TASK_COMPLETE',
        task_id: 't-1',
        agent_id: 'acc-agent-coding-1',
        blocked: false,
        block_reason: '',
        latency_ms: 250,
        output: 'def fizzbuzz(n):',
        cluster_id: 'cl-1',
      },
      't-1',
    );
    expect(c).not.toBeNull();
    expect(c!.agent_id).toBe('acc-agent-coding-1');
    expect(c!.output).toBe('def fizzbuzz(n):');
    expect(c!.latency_ms).toBe(250);
    expect(c!.cluster_id).toBe('cl-1');
    expect(c!.blocked).toBe(false);
  });

  it('coerces a blocked TASK_COMPLETE', () => {
    const c = correlateTaskComplete(
      {
        signal_type: 'TASK_COMPLETE',
        task_id: 't-1',
        agent_id: 'a',
        blocked: true,
        block_reason: 'cat_a:A-017',
      },
      't-1',
    );
    expect(c!.blocked).toBe(true);
    expect(c!.block_reason).toBe('cat_a:A-017');
  });

  it('defaults missing optional fields to safe zeros / empties', () => {
    const c = correlateTaskComplete(
      {
        signal_type: 'TASK_COMPLETE',
        task_id: 't-1',
        agent_id: 'a',
      },
      't-1',
    );
    expect(c!.output).toBe('');
    expect(c!.latency_ms).toBe(0);
    expect(c!.cluster_id).toBeUndefined();
  });
});


describe('correlateTaskProgress', () => {
  it('returns null on wrong signal / wrong task_id', () => {
    expect(correlateTaskProgress(null, 't-1')).toBeNull();
    expect(
      correlateTaskProgress({ signal_type: 'TASK_COMPLETE', task_id: 't-1' }, 't-1'),
    ).toBeNull();
    expect(
      correlateTaskProgress({ signal_type: 'TASK_PROGRESS', task_id: 'other' }, 't-1'),
    ).toBeNull();
  });

  it('extracts step counters from the nested progress object', () => {
    const p = correlateTaskProgress(
      {
        signal_type: 'TASK_PROGRESS',
        task_id: 't-1',
        agent_id: 'a',
        progress: {
          step_label: 'thinking',
          current_step: 2,
          total_steps: 5,
        },
      },
      't-1',
    );
    expect(p!.step_label).toBe('thinking');
    expect(p!.current_step).toBe(2);
    expect(p!.total_steps).toBe(5);
  });

  it('falls back to flat-shape payloads', () => {
    const p = correlateTaskProgress(
      {
        signal_type: 'TASK_PROGRESS',
        task_id: 't-1',
        agent_id: 'a',
        step_label: 'flat',
        current_step: 3,
        total_steps: 4,
      },
      't-1',
    );
    expect(p!.step_label).toBe('flat');
    expect(p!.current_step).toBe(3);
  });
});
