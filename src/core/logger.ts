/**
 * Tiny logger interface used across the extension.
 *
 * Podman Desktop's API does not expose a VS-Code-style
 * ``OutputChannel`` today, so we declare the minimal shape
 * we need and default the implementation to ``console`` (the
 * messages land in PD's developer-tools console).  PR #6
 * (the docs closer) revisits this once the upstream API
 * stabilises.
 */

export interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}


export function consoleLogger(prefix = 'ACC'): Logger {
  return {
    info: (m) => console.info(`[${prefix}] ${m}`),
    warn: (m) => console.warn(`[${prefix}] ${m}`),
    error: (m) => console.error(`[${prefix}] ${m}`),
  };
}
