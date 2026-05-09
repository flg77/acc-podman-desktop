/**
 * Container status — shells out to `podman ps --format json` and
 * filters for `acc-*` services.
 *
 * We intentionally avoid PD's containers-API for v0.0.x — the
 * podman-CLI shape is already what the operator's runtime uses
 * (`acc-deploy.sh` shells out to podman-compose).  Falling back
 * to the same source of truth keeps the panel's reading
 * consistent with whatever the deploy script witnesses.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);


export interface ContainerStatus {
  name: string;
  /** Container's primary image. */
  image: string;
  /** Running / Exited / Created / Paused. */
  state: string;
  /** Operator-readable detail line — used as a tooltip. */
  status: string;
  /** Unix seconds when the container started; 0 when not running. */
  startedAt: number;
}


export interface PodmanPsRow {
  Names?: string[];
  Image?: string;
  State?: string;
  Status?: string;
  StartedAt?: number;
}


/**
 * Parse a `podman ps --format json` payload (an array of rows)
 * into the panel-friendly summary.  Pure function — easy to test
 * with a fixture string.
 */
export function parsePodmanPs(jsonText: string): ContainerStatus[] {
  let rows: PodmanPsRow[];
  try {
    const parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed)) {
      return [];
    }
    rows = parsed as PodmanPsRow[];
  } catch {
    return [];
  }
  const out: ContainerStatus[] = [];
  for (const row of rows) {
    const name = Array.isArray(row.Names) && row.Names[0] ? row.Names[0] : '';
    if (!name || !name.startsWith('acc-')) {
      continue;
    }
    out.push({
      name,
      image: typeof row.Image === 'string' ? row.Image : '',
      state: typeof row.State === 'string' ? row.State : 'unknown',
      status: typeof row.Status === 'string' ? row.Status : '',
      startedAt: typeof row.StartedAt === 'number' ? row.StartedAt : 0,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}


/**
 * Run `podman ps --all --format json` and parse the result.
 *
 * Returns ``[]`` when podman is missing / errors — the panel
 * surfaces "No ACC containers detected" rather than crashing.
 */
export async function listAccContainers(): Promise<ContainerStatus[]> {
  try {
    const { stdout } = await execFileP('podman', [
      'ps',
      '--all',
      '--format',
      'json',
    ]);
    return parsePodmanPs(stdout);
  } catch {
    return [];
  }
}
