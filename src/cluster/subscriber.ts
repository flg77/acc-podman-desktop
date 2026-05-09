/**
 * NATS subscriber for cluster topology.
 *
 * Connects to the operator's NATS endpoint, subscribes to
 * `acc.{collective_id}.>`, decodes each frame from msgpack(json)
 * to a plain object, and dispatches into the aggregator.
 *
 * Wire format mirrors `acc/backends/signaling_nats.py`:
 *   1. Bus payload is `msgpack(<utf-8 bytes of JSON>)`.
 *   2. Inner JSON has `signal_type`, optional `cluster_id`, etc.
 */

import { connect, type NatsConnection, type Subscription } from 'nats';
import { decode as msgpackDecode } from '@msgpack/msgpack';

import type { TopologyAggregator } from './aggregator';

export interface SubscriberOptions {
  natsUrl: string;
  collectiveId: string;
  /**
   * Called whenever the aggregator state changes.  Suitable for
   * a debounced webview re-render — invoked from inside the
   * subscription callback so the listener should be quick.
   */
  onUpdate?: () => void;
  /** Logger sink — defaults to console for unit tests. */
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

export interface SubscriberHandle {
  /** Stop the subscription + drain the connection. */
  stop: () => Promise<void>;
  /** True between `start()` returning and `stop()` resolving. */
  isRunning: () => boolean;
}


/**
 * Decode a NATS frame into a plain JS object — or null when the
 * frame is malformed.  Telemetry can be lossy; we never throw
 * out of the dispatch path.
 */
export function decodeFrame(data: Uint8Array): Record<string, unknown> | null {
  let outer: unknown;
  try {
    outer = msgpackDecode(data);
  } catch {
    return null;
  }
  // The Python side wraps the JSON bytes; the msgpack-decoded result
  // is therefore typically a Buffer / Uint8Array carrying UTF-8 JSON.
  // We tolerate both shapes (some publishers may have moved to direct
  // JSON over NATS).
  if (outer instanceof Uint8Array) {
    try {
      const text = new TextDecoder('utf-8').decode(outer);
      const parsed = JSON.parse(text);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  if (typeof outer === 'object' && outer !== null) {
    return outer as Record<string, unknown>;
  }
  return null;
}


export async function startSubscriber(
  aggregator: TopologyAggregator,
  options: SubscriberOptions,
): Promise<SubscriberHandle> {
  const log = options.logger ?? {
    info: (m) => console.info(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
  };

  const subject = `acc.${options.collectiveId}.>`;
  log.info(`subscriber: connecting to ${options.natsUrl}`);
  const nc: NatsConnection = await connect({ servers: options.natsUrl });

  const sub: Subscription = nc.subscribe(subject);
  log.info(`subscriber: subscribed to ${subject}`);

  // Async iteration in the background; teardown via sub.unsubscribe().
  let running = true;
  const drainPromise = (async () => {
    for await (const msg of sub) {
      if (!running) {
        break;
      }
      try {
        const decoded = decodeFrame(msg.data);
        if (decoded === null) {
          continue;
        }
        const changed = aggregator.ingest(decoded);
        if (changed && options.onUpdate) {
          try {
            options.onUpdate();
          } catch (err) {
            // Keep the subscription alive even when a single
            // listener throws — exception isolation contract.
            log.warn(
              `subscriber: onUpdate threw: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
      } catch (err) {
        log.error(
          `subscriber: dispatch failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  })();

  return {
    stop: async () => {
      running = false;
      try {
        sub.unsubscribe();
      } catch {
        // already torn down
      }
      try {
        await nc.drain();
      } catch {
        // best-effort
      }
      try {
        await drainPromise;
      } catch {
        // best-effort
      }
      log.info('subscriber: stopped');
    },
    isRunning: () => running,
  };
}
