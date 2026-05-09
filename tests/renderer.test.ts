/**
 * Renderer tests — pure-function HTML output.
 *
 * The webview ships sanitised content via `escapeHtml`; the
 * renderer must never inject untrusted strings into the markup
 * unescaped.
 */

import { describe, it, expect } from 'vitest';

import { escapeHtml, renderSnapshot } from '../src/cluster/renderer';
import type { TopologySnapshot } from '../src/cluster/aggregator';


function fakeSnapshot(): TopologySnapshot {
  return {
    'c-abc12345': {
      cluster_id: 'c-abc12345-DEADBEEFCAFEBABEDEADBEEFCAFEBABE',
      target_role: 'coding_agent',
      subagent_count: 2,
      members: {
        'coding-aaa': {
          task_id: 't-aaa',
          step_label: 'Calling skill:code_review',
          current_step: 2,
          total_steps: 4,
          status: 'running',
          skill_in_use: 'code_review',
          last_seen: 1000,
        },
        'coding-bbb': {
          task_id: 't-bbb',
          step_label: '',
          current_step: 4,
          total_steps: 4,
          status: 'complete',
          skill_in_use: 'echo',
          last_seen: 1000,
        },
      },
      created_at: 1000,
      finished_at: null,
      reason: 'fixed strategy, count=2',
    },
  };
}


// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------


describe('escapeHtml', () => {
  it.each([
    ['<script>', '&lt;script&gt;'],
    ['a & b', 'a &amp; b'],
    ['"hi"', '&quot;hi&quot;'],
    ["it's", 'it&#39;s'],
  ])('escapes %s → %s', (input, expected) => {
    expect(escapeHtml(input)).toBe(expected);
  });
});


// ---------------------------------------------------------------------------
// renderSnapshot — empty + populated
// ---------------------------------------------------------------------------


describe('renderSnapshot', () => {
  it('renders the empty placeholder when snapshot is empty', () => {
    const html = renderSnapshot({});
    expect(html).toContain('No active clusters');
  });

  it('renders header counts + total members', () => {
    const html = renderSnapshot(fakeSnapshot());
    expect(html).toContain('<strong>Clusters: 1</strong>');
    expect(html).toContain('Σ 2 agents');
  });

  it('includes truncated cluster_id (10 chars)', () => {
    const html = renderSnapshot(fakeSnapshot());
    expect(html).toContain('c-abc12345');
    // Long suffix MUST be excluded from rendered output.
    expect(html).not.toContain('DEADBEEFCAFE');
  });

  it('renders both members with skill + status', () => {
    const html = renderSnapshot(fakeSnapshot());
    expect(html).toContain('coding-aaa');
    expect(html).toContain('skill:code_review');
    expect(html).toContain('step 2/4');
    expect(html).toContain('coding-bbb');
    expect(html).toContain('skill:echo');
    expect(html).toContain('complete');
  });

  it('attaches the finished modifier when finished_at is set', () => {
    const snap = fakeSnapshot();
    snap['c-abc12345']!.finished_at = 1000;
    const html = renderSnapshot(snap);
    expect(html).toContain('acc-cluster--finished');
  });

  it('escapes operator-supplied strings to prevent HTML injection', () => {
    const snap: TopologySnapshot = {
      'c-evil': {
        cluster_id: 'c-evil',
        target_role: '<img src=x onerror=alert(1)>',
        subagent_count: 1,
        members: {
          'a-1': {
            task_id: 't-1',
            step_label: '',
            current_step: 1,
            total_steps: 1,
            status: 'running',
            skill_in_use: '<script>',
            last_seen: 1,
          },
        },
        created_at: 1, finished_at: null, reason: 'evil & friends',
      },
    };
    const html = renderSnapshot(snap);
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('evil &amp; friends');
  });

  it('renders iteration badge when iteration_n > 0', () => {
    const snap = fakeSnapshot();
    snap['c-abc12345']!.members['coding-aaa']!.iteration_n = 2;
    const html = renderSnapshot(snap);
    expect(html).toContain('iter 2');
  });

  it('omits iteration badge when iteration_n is 0 or missing', () => {
    const snap = fakeSnapshot();
    const html = renderSnapshot(snap);
    expect(html).not.toContain('iter ');
  });
});
