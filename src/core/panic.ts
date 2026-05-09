/**
 * Panic-stop registry — shared kill switch for every panel that
 * holds NATS subscriptions or spawned child processes.
 *
 * Each panel registers a tear-down handle when it opens a
 * resource (NATS connection, spawned `acc-deploy.sh` / example
 * `run.sh`, etc.).  The `acc.panicStop` command iterates every
 * registered handle and calls its `dispose()` once, then drops it
 * from the registry.
 *
 * Intentionally tiny — three methods, no globals leaked outside
 * this module.  Panels import `panicRegistry` and call
 * `register()` themselves.
 */

import type { Logger } from './logger';


export interface PanicHandle {
  /** Short human-readable identity surfaced in the success toast. */
  label: string;
  /**
   * Tear down the underlying resource.  Must be idempotent — a
   * panel may also call its own teardown before the panic command
   * fires.
   */
  dispose: () => Promise<void> | void;
}


class PanicRegistry {
  private handles: PanicHandle[] = [];

  register(handle: PanicHandle): { unregister: () => void } {
    this.handles.push(handle);
    return {
      unregister: () => {
        this.handles = this.handles.filter((h) => h !== handle);
      },
    };
  }

  size(): number {
    return this.handles.length;
  }

  labels(): string[] {
    return this.handles.map((h) => h.label);
  }

  async tearDownAll(log?: Logger): Promise<{ tornDown: string[]; errors: string[] }> {
    const snapshot = [...this.handles];
    this.handles = [];
    const tornDown: string[] = [];
    const errors: string[] = [];
    for (const h of snapshot) {
      try {
        await h.dispose();
        tornDown.push(h.label);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        errors.push(`${h.label}: ${m}`);
        log?.warn(`panic: ${h.label}.dispose threw: ${m}`);
      }
    }
    return { tornDown, errors };
  }
}


export const panicRegistry = new PanicRegistry();
