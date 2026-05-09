/**
 * AI Lab Model Service discovery.
 *
 * AI Lab does NOT expose a typed extension-to-extension API today
 * (its `activate()` returns void; no public commands list running
 * inference servers).  The stable surface is the local REST API the
 * AI Lab backend stands up on `localhost:<apiPort>` (default 10434):
 *
 *   GET /api/v1/ps   →  array of running inference servers, each
 *                       with the per-service port + model name.
 *
 * We hit that endpoint, parse it, and project the OpenAI-compatible
 * base URL `http://localhost:<port>/v1` per service.  Falls back to
 * `podman ps --format json` filtering for the AI Lab label-set when
 * the REST API is unreachable.
 *
 * The parser functions are pure + side-effect-free so they can be
 * unit-tested without spinning up AI Lab.
 */

import { spawn } from 'node:child_process';


/** Discovered model service the operator can wire to deploy/.env. */
export interface ModelService {
  /** Stable identifier — container name or AI Lab service id. */
  id: string;
  /** Human-readable label — model name, falls back to id. */
  label: string;
  /** OpenAI-compatible base URL ending in `/v1`. */
  baseUrl: string;
  /** Port the inference server is exposed on. */
  port: number;
  /** Where the entry came from — useful for surfacing in the UI. */
  source: 'ai-lab-api' | 'podman-ps';
  /** Optional model id reported by AI Lab. */
  modelName?: string;
}


// ---------------------------------------------------------------------------
// REST-API parser — `GET /api/v1/ps`
// ---------------------------------------------------------------------------


/**
 * Parse the AI Lab `/api/v1/ps` response.  AI Lab's schema isn't
 * versioned in stone today, so the parser is tolerant: every field
 * is optional except `port`; entries without a port are dropped.
 */
export function parseAiLabPs(jsonText: string): ModelService[] {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    return [];
  }
  // AI Lab returns an array directly; some builds wrap in `{servers: [...]}`.
  let entries: unknown[] = [];
  if (Array.isArray(raw)) {
    entries = raw;
  } else if (raw !== null && typeof raw === 'object') {
    const wrapped = (raw as Record<string, unknown>)['servers'];
    if (Array.isArray(wrapped)) {
      entries = wrapped;
    }
  }
  const out: ModelService[] = [];
  for (const e of entries) {
    if (e === null || typeof e !== 'object') {
      continue;
    }
    const rec = e as Record<string, unknown>;
    // Filter to running services only.
    const status = String(rec['status'] ?? rec['state'] ?? '').toLowerCase();
    if (status && status !== 'running') {
      continue;
    }
    const portRaw = rec['port'] ?? rec['Port'];
    const port = typeof portRaw === 'number' ? portRaw : Number(portRaw);
    if (!Number.isFinite(port) || port <= 0) {
      continue;
    }
    const containerId = String(rec['containerId'] ?? rec['container_id'] ?? '');
    const id =
      String(rec['serverId'] ?? rec['server_id'] ?? '') ||
      containerId ||
      `ai-lab-${port}`;
    const modelName = String(
      rec['modelName'] ?? rec['model_name'] ?? rec['model'] ?? '',
    );
    out.push({
      id,
      label: modelName || id,
      baseUrl: `http://localhost:${port}/v1`,
      port,
      source: 'ai-lab-api',
      modelName: modelName || undefined,
    });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}


// ---------------------------------------------------------------------------
// Fallback parser — `podman ps --format json`
// ---------------------------------------------------------------------------


/**
 * Filter `podman ps --format json` output to AI Lab inference
 * containers.  AI Lab labels its serving containers with
 * `ai-lab.model-id` (and historically `ai-studio.model-id`); we
 * accept either prefix.
 *
 * Per-container port is the first published port mapping on
 * containerPort 8000 (AI Lab's in-container vLLM/llama.cpp port).
 */
export function parsePodmanPsForAiLab(jsonText: string): ModelService[] {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: ModelService[] = [];
  for (const e of raw) {
    if (e === null || typeof e !== 'object') {
      continue;
    }
    const rec = e as Record<string, unknown>;
    const labels = (rec['Labels'] ?? {}) as Record<string, unknown>;
    const aiLabId =
      labels && typeof labels === 'object'
        ? String(
            (labels['ai-lab.model-id'] as string) ??
              (labels['ai-studio.model-id'] as string) ??
              '',
          )
        : '';
    if (!aiLabId) {
      continue;
    }
    const state = String(rec['State'] ?? '').toLowerCase();
    if (state && state !== 'running') {
      continue;
    }
    const ports = rec['Ports'];
    let hostPort = 0;
    if (Array.isArray(ports)) {
      for (const p of ports) {
        if (p === null || typeof p !== 'object') {
          continue;
        }
        const prec = p as Record<string, unknown>;
        const cp = Number(prec['container_port'] ?? prec['containerPort']);
        const hp = Number(prec['host_port'] ?? prec['hostPort']);
        if (Number.isFinite(hp) && hp > 0 && (cp === 8000 || hostPort === 0)) {
          hostPort = hp;
          if (cp === 8000) {
            break;
          }
        }
      }
    }
    if (hostPort === 0) {
      continue;
    }
    const names = rec['Names'];
    const id = Array.isArray(names) && names.length > 0 ? String(names[0]) : aiLabId;
    out.push({
      id,
      label: aiLabId,
      baseUrl: `http://localhost:${hostPort}/v1`,
      port: hostPort,
      source: 'podman-ps',
      modelName: aiLabId,
    });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}


// ---------------------------------------------------------------------------
// Live discovery — REST API first, podman fallback.
// ---------------------------------------------------------------------------


export interface DiscoveryResult {
  services: ModelService[];
  /** Where the result came from (or 'none' if neither path produced data). */
  source: 'ai-lab-api' | 'podman-ps' | 'none';
  /** Diagnostic message — shown in the panel when source === 'none'. */
  reason?: string;
}


export async function discoverModelServices(
  options: { aiLabPort?: number; timeoutMs?: number } = {},
): Promise<DiscoveryResult> {
  const port = options.aiLabPort ?? 10434;
  const timeout = options.timeoutMs ?? 1500;
  // 1. REST-API path.
  try {
    const text = await fetchText(`http://localhost:${port}/api/v1/ps`, timeout);
    const services = parseAiLabPs(text);
    if (services.length > 0) {
      return { services, source: 'ai-lab-api' };
    }
  } catch {
    // fall through
  }
  // 2. Podman fallback.
  try {
    const text = await podmanPsJson();
    const services = parsePodmanPsForAiLab(text);
    if (services.length > 0) {
      return { services, source: 'podman-ps' };
    }
  } catch (err) {
    return {
      services: [],
      source: 'none',
      reason: `podman ps failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return {
    services: [],
    source: 'none',
    reason:
      `No AI Lab Model Services detected.  Tried http://localhost:${port}/api/v1/ps ` +
      `and \`podman ps\` (filtered to ai-lab.model-id label).`,
  };
}


async function fetchText(url: string, timeoutMs: number): Promise<string> {
  // Node 18+ has fetch globally; bail out if not available.
  const f = (globalThis as { fetch?: typeof fetch }).fetch;
  if (typeof f !== 'function') {
    throw new Error('fetch unavailable');
  }
  const ctrl = new AbortController();
  const handle = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await f(url, { signal: ctrl.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.text();
  } finally {
    clearTimeout(handle);
  }
}


async function podmanPsJson(): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn('podman', ['ps', '--format', 'json'], {
      shell: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`podman ps exited ${code}: ${stderr.trim()}`));
      }
    });
  });
}
