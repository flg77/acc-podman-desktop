/**
 * Compliance renderer — pure-fn HTML fragment tests.
 *
 * Pin the operator-visible bits (ids, classes, key strings) so a
 * cosmetic refactor doesn't accidentally break the panel script's
 * selectors (e.g. `data-decision`, `data-oid`).
 */

import { describe, expect, it } from 'vitest';

import { ComplianceAggregator } from '../src/compliance/aggregator';
import {
  escapeHtml,
  renderAgentTriggers,
  renderHealth,
  renderOversightQueue,
  renderOwaspTable,
  renderViolationLog,
} from '../src/compliance/renderer';


function snap(builder: (a: ComplianceAggregator) => void) {
  const agg = new ComplianceAggregator();
  builder(agg);
  return agg.getSnapshot();
}


describe('escapeHtml', () => {
  it('escapes the four canonical chars', () => {
    expect(escapeHtml('<a href="x">&y</a>')).toBe(
      '&lt;a href=&quot;x&quot;&gt;&amp;y&lt;/a&gt;',
    );
  });
  it('coerces null / undefined to empty string', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});


describe('renderHealth', () => {
  it('classifies 95% as good (green)', () => {
    const html = renderHealth(snap((a) => {
      a.ingest(
        { signal_type: 'HEARTBEAT', agent_id: 'x', compliance_health_score: 0.95 },
        1000,
      );
    }));
    expect(html).toContain('acc-health--good');
    expect(html).toContain('95%');
  });
  it('classifies 60% as bad', () => {
    const html = renderHealth(snap((a) => {
      a.ingest(
        { signal_type: 'HEARTBEAT', agent_id: 'x', compliance_health_score: 0.6 },
        1000,
      );
    }));
    expect(html).toContain('acc-health--bad');
  });
  it('renders 100% when no agents are known', () => {
    const html = renderHealth(new ComplianceAggregator().getSnapshot());
    expect(html).toContain('100%');
    expect(html).toContain('acc-health--good');
  });
});


describe('renderOwaspTable', () => {
  it('always renders all 10 LLM codes', () => {
    const html = renderOwaspTable(new ComplianceAggregator().getSnapshot());
    for (let i = 1; i <= 10; i++) {
      expect(html).toContain(`LLM${String(i).padStart(2, '0')}`);
    }
  });

  it('marks zero-count rows with the zero class', () => {
    const html = renderOwaspTable(new ComplianceAggregator().getSnapshot());
    expect(html).toContain('acc-owasp-row--zero');
  });

  it('marks observed rows with the nonzero class', () => {
    const html = renderOwaspTable(snap((a) => {
      a.ingest(
        {
          signal_type: 'EVAL_OUTCOME',
          agent_id: 'x',
          ts: 1,
          owasp_violations: [{ code: 'LLM01', risk_level: 'HIGH', pattern: 'p' }],
        },
        1,
      );
    }));
    expect(html).toContain('acc-owasp-row--nonzero');
  });
});


describe('renderAgentTriggers', () => {
  it('returns the empty placeholder when no heartbeats arrived', () => {
    const html = renderAgentTriggers(new ComplianceAggregator().getSnapshot());
    expect(html).toContain('No agent heartbeats yet');
  });

  it('lists agents sorted by total trigger count desc', () => {
    const html = renderAgentTriggers(snap((a) => {
      a.ingest(
        {
          signal_type: 'HEARTBEAT',
          agent_id: 'low',
          cat_a_trigger_count: 0,
          cat_b_trigger_count: 1,
        },
        1,
      );
      a.ingest(
        {
          signal_type: 'HEARTBEAT',
          agent_id: 'high',
          cat_a_trigger_count: 4,
          cat_b_trigger_count: 0,
        },
        1,
      );
    }));
    const lowIdx = html.indexOf('low');
    const highIdx = html.indexOf('high');
    expect(highIdx).toBeGreaterThan(0);
    expect(highIdx).toBeLessThan(lowIdx);
  });

  it('escapes agent_id as code', () => {
    const html = renderAgentTriggers(snap((a) => {
      a.ingest(
        {
          signal_type: 'HEARTBEAT',
          agent_id: '<script>',
          role_id: 'evil',
        },
        1,
      );
    }));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});


describe('renderOversightQueue', () => {
  it('returns the empty placeholder when nothing pending', () => {
    const html = renderOversightQueue(new ComplianceAggregator().getSnapshot());
    expect(html).toContain('No pending oversight items');
  });

  it('emits Approve / Reject buttons with data-decision + data-oid', () => {
    const html = renderOversightQueue(snap((a) => {
      a.ingest(
        {
          signal_type: 'HEARTBEAT',
          agent_id: 'arb',
          role_id: 'arbiter',
          oversight_pending_items: [
            {
              oversight_id: 'os-deadbeef',
              risk_level: 'HIGH',
              role_id: 'coding_agent',
              agent_id: 'c-1',
              summary: 'risky thing',
              status: 'PENDING',
            },
          ],
        },
        1,
      );
    }));
    expect(html).toContain('data-decision="approve"');
    expect(html).toContain('data-decision="reject"');
    expect(html).toContain('data-oid="os-deadbeef"');
    expect(html).toContain('data-reject-reason="os-deadbeef"');
    expect(html).toContain('acc-pill--HIGH');
    expect(html).toContain('risky thing');
  });
});


describe('renderViolationLog', () => {
  it('returns the empty placeholder when log is empty', () => {
    const html = renderViolationLog(new ComplianceAggregator().getSnapshot());
    expect(html).toContain('No OWASP violations recorded yet');
  });

  it('renders newest-first', () => {
    const html = renderViolationLog(snap((a) => {
      a.ingest(
        {
          signal_type: 'EVAL_OUTCOME',
          agent_id: 'x',
          ts: 1,
          owasp_violations: [{ code: 'LLM01', risk_level: 'L', pattern: 'old' }],
        },
        1,
      );
      a.ingest(
        {
          signal_type: 'EVAL_OUTCOME',
          agent_id: 'x',
          ts: 2,
          owasp_violations: [{ code: 'LLM02', risk_level: 'L', pattern: 'new' }],
        },
        1,
      );
    }));
    expect(html.indexOf('LLM02')).toBeLessThan(html.indexOf('LLM01'));
  });
});
