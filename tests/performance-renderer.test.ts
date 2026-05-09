/**
 * Performance renderer — pure-fn HTML fragment tests.
 *
 * Pin operator-visible bits (selectors + key strings) so a
 * cosmetic refactor doesn't break the panel script.
 */

import { describe, expect, it } from 'vitest';

import { PerformanceAggregator } from '../src/performance/aggregator';
import {
  escapeHtml,
  renderAgentTable,
  renderCapabilityStats,
  renderDriftSparkline,
  renderLatencyHeader,
  renderPlanCosts,
} from '../src/performance/renderer';


function snap(builder: (a: PerformanceAggregator) => void) {
  const agg = new PerformanceAggregator();
  builder(agg);
  return agg.getSnapshot();
}


describe('escapeHtml', () => {
  it('escapes the four canonical chars', () => {
    expect(escapeHtml('<a href="x">&y</a>')).toBe(
      '&lt;a href=&quot;x&quot;&gt;&amp;y&lt;/a&gt;',
    );
  });
});


describe('renderLatencyHeader', () => {
  it('shows em-dash for empty latency', () => {
    const html = renderLatencyHeader(new PerformanceAggregator().getSnapshot());
    expect(html).toContain('p50');
    expect(html).toContain('—');
  });

  it('shows ms suffix for non-zero values', () => {
    const html = renderLatencyHeader(snap((a) => {
      a.ingest(
        { signal_type: 'HEARTBEAT', agent_id: 'a', last_task_latency_ms: 250 },
        1,
      );
    }));
    expect(html).toContain('250 ms');
  });
});


describe('renderAgentTable', () => {
  it('returns the empty placeholder when no heartbeats arrived', () => {
    const html = renderAgentTable(new PerformanceAggregator().getSnapshot());
    expect(html).toContain('No agent heartbeats yet');
  });

  it('renders backpressure pill with the right class', () => {
    const html = renderAgentTable(snap((a) => {
      a.ingest(
        {
          signal_type: 'HEARTBEAT',
          agent_id: 'a',
          backpressure_state: 'CLOSED',
        },
        1,
      );
    }));
    expect(html).toContain('acc-bp--crit');
    expect(html).toContain('CLOSED');
  });

  it('marks high token utilisation as crit', () => {
    const html = renderAgentTable(snap((a) => {
      a.ingest(
        {
          signal_type: 'HEARTBEAT',
          agent_id: 'a',
          token_budget_utilization: 0.95,
        },
        1,
      );
    }));
    expect(html).toContain('acc-token--crit');
    expect(html).toContain('95%');
  });

  it('renders step counts only when total_steps > 0', () => {
    const html = renderAgentTable(snap((a) => {
      a.ingest(
        {
          signal_type: 'TASK_PROGRESS',
          agent_id: 'a',
          current_step: 2,
          total_steps: 5,
          step_label: 'thinking',
        },
        1,
      );
    }));
    expect(html).toContain('2/5');
    expect(html).toContain('thinking');
  });

  it('escapes evil agent ids', () => {
    const html = renderAgentTable(snap((a) => {
      a.ingest(
        { signal_type: 'HEARTBEAT', agent_id: '<script>' },
        1,
      );
    }));
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });
});


describe('renderDriftSparkline', () => {
  it('renders an empty placeholder when no readings', () => {
    expect(renderDriftSparkline([])).toContain('acc-spark--empty');
  });

  it('emits an svg polyline for readings', () => {
    const html = renderDriftSparkline([0.1, 0.2, 0.15, 0.3]);
    expect(html).toContain('<svg');
    expect(html).toContain('<polyline');
    expect(html).toContain('points="');
  });

  it('handles a single reading without div-by-zero', () => {
    const html = renderDriftSparkline([0.5]);
    expect(html).toContain('<polyline');
  });
});


describe('renderCapabilityStats', () => {
  it('returns the empty placeholder when no invocations', () => {
    const html = renderCapabilityStats(new PerformanceAggregator().getSnapshot());
    expect(html).toContain('No skill / MCP invocations yet');
  });

  it('shows the kind pill (skill / mcp)', () => {
    const html = renderCapabilityStats(snap((a) => {
      a.ingest(
        {
          signal_type: 'TASK_COMPLETE',
          agent_id: 'a',
          invocations: [
            { kind: 'skill', target: 'echo', ok: true },
            { kind: 'mcp', target: 'srv.tool', ok: true },
          ],
        },
        1,
      );
    }));
    expect(html).toContain('acc-pill--skill');
    expect(html).toContain('acc-pill--mcp');
  });

  it('classifies ok-rate buckets (ok / warn / crit)', () => {
    const html = renderCapabilityStats(snap((a) => {
      a.ingest(
        {
          signal_type: 'TASK_COMPLETE',
          agent_id: 'a',
          invocations: [
            // good: 2/2 = 100% → ok
            { kind: 'skill', target: 'good', ok: true },
            { kind: 'skill', target: 'good', ok: true },
            // mid: 4/5 = 80% → warn
            { kind: 'skill', target: 'mid', ok: true },
            { kind: 'skill', target: 'mid', ok: true },
            { kind: 'skill', target: 'mid', ok: true },
            { kind: 'skill', target: 'mid', ok: true },
            { kind: 'skill', target: 'mid', ok: false, error: 'oops' },
            // bad: 1/2 = 50% → crit
            { kind: 'skill', target: 'bad', ok: true },
            { kind: 'skill', target: 'bad', ok: false, error: 'kaboom' },
          ],
        },
        1,
      );
    }));
    expect(html).toContain('acc-okrate--ok');
    expect(html).toContain('acc-okrate--warn');
    expect(html).toContain('acc-okrate--crit');
    expect(html).toContain('oops');
    expect(html).toContain('kaboom');
  });
});


describe('renderPlanCosts', () => {
  it('returns the empty placeholder when no plan totals', () => {
    const html = renderPlanCosts(new PerformanceAggregator().getSnapshot());
    expect(html).toContain('No plan-level token totals yet');
  });

  it('renders an unknown bar when there is no cap', () => {
    const html = renderPlanCosts(snap((a) => {
      a.ingest(
        {
          signal_type: 'TASK_COMPLETE',
          agent_id: 'a',
          plan_id: 'p1',
          tokens_used: 500,
        },
        1,
      );
    }));
    expect(html).toContain('p1');
    expect(html).toContain('∅ (no cap)');
    expect(html).toContain('acc-cost-fill--unknown');
  });

  it('marks > 90% usage as crit', () => {
    const html = renderPlanCosts(snap((a) => {
      a.ingest(
        { signal_type: 'PLAN', plan_id: 'p1', max_run_tokens: 100 },
        1,
      );
      a.ingest(
        {
          signal_type: 'TASK_COMPLETE',
          agent_id: 'a',
          plan_id: 'p1',
          tokens_used: 95,
        },
        2,
      );
    }));
    expect(html).toContain('acc-cost-fill--crit');
  });

  it('caps the bar at 100% on overrun', () => {
    const html = renderPlanCosts(snap((a) => {
      a.ingest(
        { signal_type: 'PLAN', plan_id: 'p1', max_run_tokens: 100 },
        1,
      );
      a.ingest(
        {
          signal_type: 'TASK_COMPLETE',
          agent_id: 'a',
          plan_id: 'p1',
          tokens_used: 150,
        },
        2,
      );
    }));
    expect(html).toContain('width:100%');
  });
});
