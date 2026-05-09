/**
 * Shared stub of `@podman-desktop/api` used by every test file.
 *
 * Real PD types live in `node_modules/@podman-desktop/api/src/extension-api.d.ts`
 * but the package ships no runtime JS (it's a host-injected
 * module).  Tests get a settable in-memory replica.
 */

const config: Record<string, Record<string, unknown>> = {
  acc: { repoPath: '', collectiveId: 'sol-01', natsUrl: 'nats://localhost:4222' },
};

export const configuration = {
  getConfiguration: (section: string) => ({
    get: <T>(key: string): T | undefined =>
      (config[section]?.[key] as T | undefined),
  }),
};

export const __setConfig = (section: string, key: string, value: unknown): void => {
  config[section] ??= {};
  (config[section] as Record<string, unknown>)[key] = value;
};
