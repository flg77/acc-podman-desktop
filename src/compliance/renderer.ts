/**
 * Pure-fn renderer for the Compliance webview.
 *
 * The body is generated once at panel-open time from a static
 * skeleton (in `panel.ts`); this module produces the fragments the
 * panel updates on every snapshot change.  Keeping the renderer
 * pure means the unit tests can pin the exact HTML strings without
 * mounting a real WebviewPanel.
 */

import {
  type AgentCompliance,
  type ComplianceSnapshot,
  type OversightItem,
  type ViolationLogEntry,
  OWASP_CODES,
} from './aggregator';


export function escapeHtml(s: unknown): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


/**
 * Health bar fragment — a coloured pill + numeric percentage.
 * Mirrors the TUI's biological framing (immune health = inverse of
 * violation pressure).
 */
export function renderHealth(snapshot: ComplianceSnapshot): string {
  const pct = Math.round(snapshot.collectiveHealth * 100);
  const cls =
    pct >= 90 ? 'good' : pct >= 70 ? 'warn' : pct >= 50 ? 'bad' : 'crit';
  return `<div class="acc-health acc-health--${cls}">
    <span class="acc-health-label">Collective compliance health</span>
    <span class="acc-health-bar"><span class="acc-health-fill"
      style="width:${pct}%"></span></span>
    <span class="acc-health-value">${pct}%</span>
  </div>`;
}


/**
 * Per-OWASP-code count table.  Always renders all ten rows so the
 * operator can see "no violations" as a positive — green zeros
 * communicate "watching" rather than "missing data".
 */
export function renderOwaspTable(snapshot: ComplianceSnapshot): string {
  const rows = OWASP_CODES.map((code) => {
    const n = snapshot.owaspCounts[code] ?? 0;
    const cls = n === 0 ? 'zero' : 'nonzero';
    return `<tr class="acc-owasp-row acc-owasp-row--${cls}">
      <td><code>${escapeHtml(code)}</code></td>
      <td>${OWASP_NAMES[code] ?? ''}</td>
      <td class="acc-owasp-count">${n}</td>
    </tr>`;
  }).join('');
  return `<table class="acc-table acc-owasp-table">
    <thead><tr><th>Code</th><th>Name</th><th>Count</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}


/**
 * Per-agent Cat-A / Cat-B trigger summary.  Sorted by total trigger
 * count descending, then by agent_id for stable ordering.
 */
export function renderAgentTriggers(snapshot: ComplianceSnapshot): string {
  const agents = Object.values(snapshot.agents);
  if (agents.length === 0) {
    return '<div class="acc-empty">No agent heartbeats yet.</div>';
  }
  agents.sort((a, b) => {
    const ta = a.cat_a_trigger_count + a.cat_b_trigger_count;
    const tb = b.cat_a_trigger_count + b.cat_b_trigger_count;
    if (ta !== tb) {
      return tb - ta;
    }
    return a.agent_id.localeCompare(b.agent_id);
  });
  const rows = agents.map((a) => renderAgentRow(a)).join('');
  return `<table class="acc-table acc-trigger-table">
    <thead><tr>
      <th>Agent</th><th>Role</th>
      <th>Cat-A</th><th>Cat-B</th>
      <th>OWASP</th><th>Health</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}


function renderAgentRow(a: AgentCompliance): string {
  const health = Math.round(a.compliance_health_score * 100);
  return `<tr>
    <td><code>${escapeHtml(a.agent_id)}</code></td>
    <td>${escapeHtml(a.role_id)}</td>
    <td class="${a.cat_a_trigger_count > 0 ? 'acc-warn' : ''}">${a.cat_a_trigger_count}</td>
    <td class="${a.cat_b_trigger_count > 0 ? 'acc-warn' : ''}">${a.cat_b_trigger_count}</td>
    <td>${a.owasp_violation_count}</td>
    <td>${health}%</td>
  </tr>`;
}


/**
 * Oversight queue.  Each row gets Approve / Reject buttons; the
 * reject button reads a free-text reason from a paired `<input>`.
 * The host posts `OVERSIGHT_DECISION` on click.
 */
export function renderOversightQueue(snapshot: ComplianceSnapshot): string {
  if (snapshot.oversightPending.length === 0) {
    return '<div class="acc-empty">No pending oversight items.</div>';
  }
  const rows = snapshot.oversightPending
    .map((item) => renderOversightRow(item))
    .join('');
  return `<table class="acc-table acc-oversight-table">
    <thead><tr>
      <th>ID</th><th>Risk</th><th>Role</th><th>Agent</th>
      <th>Summary</th><th>Actions</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}


function renderOversightRow(item: OversightItem): string {
  const id = escapeHtml(item.oversight_id);
  return `<tr>
    <td><code>${id.slice(0, 8)}</code></td>
    <td><span class="acc-pill acc-pill--${escapeHtml(item.risk_level)}"
      >${escapeHtml(item.risk_level)}</span></td>
    <td>${escapeHtml(item.role_id)}</td>
    <td><code>${escapeHtml(item.agent_id)}</code></td>
    <td>${escapeHtml(item.summary)}</td>
    <td class="acc-oversight-actions">
      <button data-decision="approve" data-oid="${id}">Approve</button>
      <input type="text" placeholder="reason"
        data-reject-reason="${id}" />
      <button class="acc-secondary" data-decision="reject"
        data-oid="${id}">Reject</button>
    </td>
  </tr>`;
}


/**
 * Tail of the OWASP violation log.  Newest-last; renders empty
 * panel content when the log is still empty.
 */
export function renderViolationLog(snapshot: ComplianceSnapshot): string {
  if (snapshot.violationLog.length === 0) {
    return '<div class="acc-empty">No OWASP violations recorded yet.</div>';
  }
  // Renderer-side: show newest-first for the operator.
  const rows = [...snapshot.violationLog].reverse().map((v) => renderLogRow(v)).join('');
  return `<table class="acc-table acc-log-table">
    <thead><tr>
      <th>Time</th><th>Code</th><th>Agent</th><th>Risk</th><th>Pattern</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}


function renderLogRow(v: ViolationLogEntry): string {
  const t = new Date(v.ts * 1000);
  const ts = isFinite(t.getTime())
    ? t.toISOString().slice(11, 19)
    : '--:--:--';
  return `<tr>
    <td><code>${ts}</code></td>
    <td><code>${escapeHtml(v.code)}</code></td>
    <td><code>${escapeHtml(v.agent_id)}</code></td>
    <td>${escapeHtml(v.risk_level)}</td>
    <td>${escapeHtml(v.pattern)}</td>
  </tr>`;
}


// ---------------------------------------------------------------------------
// OWASP code → human name (for the table second column).
// Source: https://owasp.org/www-project-top-10-for-large-language-model-applications/
// ---------------------------------------------------------------------------


const OWASP_NAMES: Record<string, string> = {
  LLM01: 'Prompt Injection',
  LLM02: 'Insecure Output Handling',
  LLM03: 'Training Data Poisoning',
  LLM04: 'Model Denial of Service',
  LLM05: 'Supply Chain',
  LLM06: 'Sensitive Information Disclosure',
  LLM07: 'Insecure Plugin Design',
  LLM08: 'Excessive Agency',
  LLM09: 'Overreliance',
  LLM10: 'Model Theft',
};
