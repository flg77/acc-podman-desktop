/**
 * Pure-fn renderer for the Performance webview.
 *
 * Five sections: latency percentiles header, per-agent table
 * (queue + backpressure + latency + token util + drift sparkline),
 * capability_stats table (kind:target invocations + ok rate),
 * plan-level cost-cap progress bars, and a single-line empty
 * placeholder when no signals have arrived yet.
 */

import {
  type AgentPerf,
  type CapabilityStat,
  type PerfSnapshot,
  type PlanCost,
} from './aggregator';


export function escapeHtml(s: unknown): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


// ---------------------------------------------------------------------------
// Latency percentiles header
// ---------------------------------------------------------------------------


export function renderLatencyHeader(snap: PerfSnapshot): string {
  const { p50, p90, p95, p99 } = snap.latency;
  const fmt = (n: number) => (n > 0 ? `${Math.round(n)} ms` : '—');
  return `<div class="acc-latency">
    <span class="acc-latency-cell"><span class="acc-latency-label">p50</span>
      <span class="acc-latency-value">${fmt(p50)}</span></span>
    <span class="acc-latency-cell"><span class="acc-latency-label">p90</span>
      <span class="acc-latency-value">${fmt(p90)}</span></span>
    <span class="acc-latency-cell"><span class="acc-latency-label">p95</span>
      <span class="acc-latency-value">${fmt(p95)}</span></span>
    <span class="acc-latency-cell"><span class="acc-latency-label">p99</span>
      <span class="acc-latency-value">${fmt(p99)}</span></span>
  </div>`;
}


// ---------------------------------------------------------------------------
// Per-agent table
// ---------------------------------------------------------------------------


export function renderAgentTable(snap: PerfSnapshot): string {
  const agents = Object.values(snap.agents);
  if (agents.length === 0) {
    return '<div class="acc-empty">No agent heartbeats yet.</div>';
  }
  agents.sort((a, b) => a.agent_id.localeCompare(b.agent_id));
  const rows = agents.map(renderAgentRow).join('');
  return `<table class="acc-table acc-perf-table">
    <thead><tr>
      <th>Agent</th><th>Role</th>
      <th>Queue</th><th>Backpressure</th>
      <th>Latency</th><th>Tokens</th>
      <th>Step</th><th>Drift</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}


function renderAgentRow(a: AgentPerf): string {
  const tokenPct = Math.round(a.token_budget_utilization * 100);
  const tokenCls =
    tokenPct >= 90 ? 'crit' : tokenPct >= 75 ? 'warn' : 'ok';
  const bpCls =
    a.backpressure_state === 'OPEN'
      ? 'ok'
      : a.backpressure_state === 'THROTTLE'
      ? 'warn'
      : a.backpressure_state === 'CLOSED'
      ? 'crit'
      : '';
  const latency = a.last_task_latency_ms > 0 ? `${Math.round(a.last_task_latency_ms)} ms` : '—';
  const step =
    a.total_task_steps > 0
      ? `${a.current_task_step}/${a.total_task_steps}`
      : '—';
  const stepLabel = a.task_progress_label
    ? `<div class="acc-step-label">${escapeHtml(a.task_progress_label)}</div>`
    : '';
  return `<tr>
    <td><code>${escapeHtml(a.agent_id)}</code></td>
    <td>${escapeHtml(a.role_id)}</td>
    <td>${a.queue_depth}</td>
    <td><span class="acc-bp acc-bp--${bpCls}">${escapeHtml(a.backpressure_state)}</span></td>
    <td>${latency}</td>
    <td><span class="acc-token acc-token--${tokenCls}">${tokenPct}%</span></td>
    <td>${step}${stepLabel}</td>
    <td>${renderDriftSparkline(a.drift_history)}
      <span class="acc-drift-value">${a.drift_score.toFixed(3)}</span></td>
  </tr>`;
}


/**
 * Inline-SVG sparkline.  Empty buffer → a faint dash so the column
 * never collapses; small buffer normalises to its own range so the
 * shape stays readable even at low magnitudes.
 */
export function renderDriftSparkline(values: number[]): string {
  if (values.length === 0) {
    return '<span class="acc-spark acc-spark--empty">—</span>';
  }
  const w = 80;
  const h = 18;
  const pad = 2;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = values.length === 1 ? 0 : (w - pad * 2) / (values.length - 1);
  const points = values
    .map((v, i) => {
      const x = pad + stepX * i;
      const y = h - pad - ((v - min) / range) * (h - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return `<svg class="acc-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <polyline fill="none" stroke="currentColor" stroke-width="1.2"
      points="${points}" />
  </svg>`;
}


// ---------------------------------------------------------------------------
// Capability stats table
// ---------------------------------------------------------------------------


export function renderCapabilityStats(snap: PerfSnapshot): string {
  const rows = Object.values(snap.capabilityStats);
  if (rows.length === 0) {
    return '<div class="acc-empty">No skill / MCP invocations yet.</div>';
  }
  rows.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind.localeCompare(b.kind);
    }
    return a.target.localeCompare(b.target);
  });
  const body = rows.map(renderCapabilityRow).join('');
  return `<table class="acc-table acc-cap-table">
    <thead><tr>
      <th>Kind</th><th>Target</th>
      <th>Total</th><th>OK</th><th>Fail</th>
      <th>OK rate</th><th>Last error</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}


function renderCapabilityRow(c: CapabilityStat): string {
  const okRate = c.total > 0 ? c.ok / c.total : 1;
  const pct = Math.round(okRate * 100);
  const cls = pct >= 95 ? 'ok' : pct >= 80 ? 'warn' : 'crit';
  return `<tr>
    <td><span class="acc-pill acc-pill--${escapeHtml(c.kind)}">${escapeHtml(c.kind)}</span></td>
    <td><code>${escapeHtml(c.target)}</code></td>
    <td>${c.total}</td>
    <td>${c.ok}</td>
    <td class="${c.fail > 0 ? 'acc-warn' : ''}">${c.fail}</td>
    <td><span class="acc-okrate acc-okrate--${cls}">${pct}%</span></td>
    <td><code class="acc-truncate">${escapeHtml(c.last_error)}</code></td>
  </tr>`;
}


// ---------------------------------------------------------------------------
// Plan cost-cap progress
// ---------------------------------------------------------------------------


export function renderPlanCosts(snap: PerfSnapshot): string {
  const plans = Object.values(snap.planCosts);
  if (plans.length === 0) {
    return '<div class="acc-empty">No plan-level token totals yet.</div>';
  }
  plans.sort((a, b) => a.plan_id.localeCompare(b.plan_id));
  const rows = plans.map(renderPlanCostRow).join('');
  return `<div class="acc-cost-grid">${rows}</div>`;
}


function renderPlanCostRow(p: PlanCost): string {
  const cap = p.max_run_tokens;
  const used = p.tokens_used;
  const pct =
    cap > 0
      ? Math.min(100, Math.round((used / cap) * 100))
      : 0;
  const cls =
    cap === 0 ? 'unknown' : pct >= 90 ? 'crit' : pct >= 75 ? 'warn' : 'ok';
  const capLabel = cap > 0 ? cap.toLocaleString() : '∅ (no cap)';
  return `<div class="acc-cost-card">
    <div class="acc-cost-head">
      <code>${escapeHtml(p.plan_id)}</code>
      <span class="acc-cost-numbers">${used.toLocaleString()} / ${capLabel}</span>
    </div>
    <div class="acc-cost-bar">
      <div class="acc-cost-fill acc-cost-fill--${cls}"
        style="width:${pct}%"></div>
    </div>
  </div>`;
}
