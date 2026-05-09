/**
 * Pure-fn health checks for operator-supplied configuration.
 *
 * Three concerns:
 *  1. `validateRepoPath` — does the path actually contain an ACC
 *     install (`acc-deploy.sh` + `deploy/podman-compose.yml`)?
 *     Mirrors the success criteria in `core/paths.ts`.
 *  2. `validateNatsUrl` — does the string parse as a `nats://` /
 *     `tls://` URL with a host?  We don't probe the network here
 *     — that's `probeNats` below.
 *  3. `probeNats` — opens a connection, drains, returns latency.
 *     Best-effort + never throws into the caller.
 *
 * Validators are pure TS so they round-trip through unit tests
 * without ever touching the network or filesystem (apart from the
 * stat-only repoPath check, which is trivially tmpdir-fakeable).
 */

import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { connect } from 'nats';


export interface ValidationResult {
  ok: boolean;
  /** Human-readable reason — set on failure, empty on success. */
  reason: string;
}


// ---------------------------------------------------------------------------
// repoPath
// ---------------------------------------------------------------------------


/**
 * Confirm that `repoPath` looks like a real ACC install.  The two
 * sentinels — `acc-deploy.sh` and `deploy/podman-compose.yml` — are
 * what `core/paths.ts` already searches for during auto-detection,
 * so a hand-set path satisfies the same contract.
 *
 * Empty `repoPath` is reported as a soft "auto-detect mode" rather
 * than a failure; auto-detect lives in `core/paths.ts`.
 */
export async function validateRepoPath(repoPath: string): Promise<ValidationResult> {
  const trimmed = repoPath.trim();
  if (trimmed.length === 0) {
    return {
      ok: true,
      reason: 'auto-detect (no explicit acc.repoPath set)',
    };
  }
  try {
    const s = await stat(trimmed);
    if (!s.isDirectory()) {
      return { ok: false, reason: `${trimmed} is not a directory` };
    }
  } catch {
    return { ok: false, reason: `${trimmed} does not exist or is unreadable` };
  }
  const deployScript = join(trimmed, 'acc-deploy.sh');
  const compose = join(trimmed, 'deploy', 'podman-compose.yml');
  try {
    await stat(deployScript);
  } catch {
    return {
      ok: false,
      reason: `acc-deploy.sh missing under ${trimmed}`,
    };
  }
  try {
    await stat(compose);
  } catch {
    return {
      ok: false,
      reason: `deploy/podman-compose.yml missing under ${trimmed}`,
    };
  }
  return { ok: true, reason: 'acc-deploy.sh + deploy/podman-compose.yml present' };
}


// ---------------------------------------------------------------------------
// natsUrl
// ---------------------------------------------------------------------------


/**
 * Shape-check a NATS URL.  We accept `nats://`, `tls://`, and
 * `ws://` / `wss://` schemes and require a host.  The runtime
 * supports more; the panel-side check is intentionally narrower so
 * a typo'd URL surfaces quickly.
 */
export function validateNatsUrl(url: string): ValidationResult {
  const trimmed = url.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'NATS URL is empty' };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      reason: `not a parseable URL (expected scheme://host:port)`,
    };
  }
  const protocol = parsed.protocol.replace(/:$/, '');
  const accepted = ['nats', 'tls', 'ws', 'wss'];
  if (!accepted.includes(protocol)) {
    return {
      ok: false,
      reason: `scheme "${protocol}://" not supported (use nats:// / tls:// / ws://)`,
    };
  }
  if (!parsed.hostname) {
    return { ok: false, reason: 'NATS URL is missing a host' };
  }
  return { ok: true, reason: `${protocol}://${parsed.host}` };
}


export interface NatsProbeResult {
  ok: boolean;
  latencyMs: number;
  reason: string;
}


/**
 * Open a connection to the NATS endpoint, immediately drain it,
 * report the round-trip.  `connectTimeoutMs` defaults to 1500 ms
 * to keep the panel responsive when the server is unreachable.
 */
export async function probeNats(
  url: string,
  options: { connectTimeoutMs?: number } = {},
): Promise<NatsProbeResult> {
  const shape = validateNatsUrl(url);
  if (!shape.ok) {
    return { ok: false, latencyMs: 0, reason: shape.reason };
  }
  const start = Date.now();
  const timeout = options.connectTimeoutMs ?? 1500;
  try {
    const nc = await connect({ servers: url, timeout });
    const latencyMs = Date.now() - start;
    try {
      await nc.drain();
    } catch {
      // best-effort
    }
    return {
      ok: true,
      latencyMs,
      reason: `connected in ${latencyMs} ms`,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
