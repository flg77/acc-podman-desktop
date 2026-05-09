/**
 * Pure-function HTML renderer for the cluster topology snapshot.
 *
 * Mirrors the TUI's `acc/tui/widgets/cluster_panel.py:_render_panel`
 * shape so operators familiar with the TUI find the extension's
 * panel immediately legible.
 *
 * Emits HTML rather than building DOM nodes so the renderer stays
 * Node-friendly + testable; the webview's bootstrap script does
 * `panel.innerHTML = html`.  Inputs are pre-typed so an XSS path
 * via untrusted strings is bounded — strings are escaped with
 * :func:`escapeHtml` before splicing.
 */

import type { TopologySnapshot, ClusterRow, MemberState } from './aggregator';


export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


export interface RenderOptions {
  /** Render every cluster expanded?  Default true (the panel is
      meant to show topology at a glance; collapsed serves the TUI's
      tight terminal grid, not a desktop UI). */
  expanded?: boolean;
}


export function renderSnapshot(
  snapshot: TopologySnapshot,
  options: RenderOptions = {},
): string {
  const expanded = options.expanded ?? true;
  const clusterIds = Object.keys(snapshot);
  if (clusterIds.length === 0) {
    return `<div class="acc-cluster-empty">No active clusters.</div>`;
  }

  const totalMembers = clusterIds.reduce(
    (acc, cid) => acc + (snapshot[cid]?.subagent_count ?? 0),
    0,
  );

  const header =
    `<div class="acc-cluster-header">` +
    `<strong>Clusters: ${clusterIds.length}</strong> ` +
    `<span class="acc-cluster-total">(Σ ${totalMembers} agents)</span>` +
    `</div>`;

  if (!expanded) {
    return header;
  }

  const rows = clusterIds
    .map((cid) => renderCluster(snapshot[cid] as ClusterRow))
    .join('\n');

  return header + `\n<div class="acc-cluster-list">\n${rows}\n</div>`;
}


function renderCluster(row: ClusterRow): string {
  const reasonHtml = row.reason
    ? `<span class="acc-cluster-reason">${escapeHtml(row.reason)}</span>`
    : '';
  const finishedClass = row.finished_at !== null ? ' acc-cluster--finished' : '';
  const target = escapeHtml(row.target_role || '?');
  const cidShort = escapeHtml(row.cluster_id.slice(0, 10));

  const members = Object.entries(row.members)
    .map(([aid, m]) => renderMember(aid, m))
    .join('\n');

  return (
    `<div class="acc-cluster${finishedClass}">\n` +
    `  <div class="acc-cluster-row">\n` +
    `    <span class="acc-cluster-id">${cidShort}</span>` +
    `    <span class="acc-cluster-role">${target}</span>` +
    `    <span class="acc-cluster-count">${row.subagent_count} agents</span>` +
    `    ${reasonHtml}\n` +
    `  </div>\n` +
    `  <ul class="acc-cluster-members">\n${members}\n  </ul>\n` +
    `</div>`
  );
}


function renderMember(agentId: string, m: MemberState): string {
  const dotClass = `acc-status acc-status--${m.status}`;
  const aidShort = escapeHtml(agentId.slice(0, 18));
  const skill = escapeHtml(m.skill_in_use || '?');
  const stepStr =
    m.total_steps > 0
      ? `step ${m.current_step}/${m.total_steps}`
      : `step ${m.current_step}`;
  const iter =
    m.iteration_n !== undefined && m.iteration_n > 0
      ? ` <span class="acc-iter">(iter ${m.iteration_n})</span>`
      : '';

  return (
    `    <li class="acc-member">\n` +
    `      <span class="${dotClass}" aria-label="${escapeHtml(m.status)}">●</span>\n` +
    `      <span class="acc-member-id">${aidShort}</span>\n` +
    `      <span class="acc-member-skill">skill:${skill}</span>\n` +
    `      <span class="acc-member-step">${stepStr}</span>\n` +
    `      <span class="acc-member-status">${escapeHtml(m.status)}${iter}</span>\n` +
    `    </li>`
  );
}
