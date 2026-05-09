/**
 * Panic registry tests — singleton behaviour + tear-down semantics.
 *
 * The registry is a module-level singleton; tests reset it by
 * tearing down everything at the end of each test.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { panicRegistry } from '../src/core/panic';


afterEach(async () => {
  // Drain anything tests left registered.
  await panicRegistry.tearDownAll();
});


describe('panicRegistry', () => {
  it('starts empty between tests', () => {
    expect(panicRegistry.size()).toBe(0);
  });

  it('register adds a handle and returns an unregister token', () => {
    const dispose = vi.fn();
    const token = panicRegistry.register({ label: 'foo', dispose });
    expect(panicRegistry.size()).toBe(1);
    expect(panicRegistry.labels()).toEqual(['foo']);
    token.unregister();
    expect(panicRegistry.size()).toBe(0);
  });

  it('tearDownAll calls every registered dispose once', async () => {
    const a = vi.fn();
    const b = vi.fn();
    panicRegistry.register({ label: 'a', dispose: a });
    panicRegistry.register({ label: 'b', dispose: b });
    const result = await panicRegistry.tearDownAll();
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
    expect(result.tornDown.sort()).toEqual(['a', 'b']);
    expect(result.errors).toEqual([]);
    expect(panicRegistry.size()).toBe(0);
  });

  it('tearDownAll captures errors but keeps draining the rest', async () => {
    const ok = vi.fn();
    const bad = vi.fn().mockRejectedValue(new Error('boom'));
    panicRegistry.register({ label: 'good', dispose: ok });
    panicRegistry.register({ label: 'bad', dispose: bad });
    const result = await panicRegistry.tearDownAll();
    expect(ok).toHaveBeenCalledOnce();
    expect(result.tornDown).toContain('good');
    expect(result.errors[0]).toContain('bad');
    expect(panicRegistry.size()).toBe(0);
  });

  it('handles synchronous dispose functions', async () => {
    const sync = vi.fn();
    panicRegistry.register({ label: 'sync', dispose: sync });
    const result = await panicRegistry.tearDownAll();
    expect(sync).toHaveBeenCalledOnce();
    expect(result.tornDown).toEqual(['sync']);
  });

  it('unregister after tearDownAll is a no-op', async () => {
    const t = panicRegistry.register({ label: 'x', dispose: () => {} });
    await panicRegistry.tearDownAll();
    expect(() => t.unregister()).not.toThrow();
  });

  it('size + labels reflect mutations', () => {
    expect(panicRegistry.size()).toBe(0);
    const t1 = panicRegistry.register({ label: 'first',  dispose: () => {} });
    const t2 = panicRegistry.register({ label: 'second', dispose: () => {} });
    expect(panicRegistry.labels()).toEqual(['first', 'second']);
    t1.unregister();
    expect(panicRegistry.labels()).toEqual(['second']);
    t2.unregister();
  });
});
