import { afterEach, describe, expect, it, vi } from 'vitest';
import { deferCardAction } from './deferred-action';

describe('deferred card callbacks', () => {
  afterEach(() => vi.useRealTimers());

  it('returns for acknowledgement before starting card updates', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const action = vi.fn(async () => { order.push('update-card'); });
    const onError = vi.fn();

    const result = deferCardAction(action, onError);
    order.push('callback-returned');

    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(499);
    expect(action).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(order).toEqual(['callback-returned', 'update-card']);
    expect(action).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports an asynchronous failure after acknowledging the callback', async () => {
    vi.useFakeTimers();
    const failure = new Error('card update failed');
    const onError = vi.fn();

    deferCardAction(async () => { throw failure; }, onError);

    expect(onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it('also reports a synchronous handler failure', async () => {
    vi.useFakeTimers();
    const failure = new Error('handler failed before its first await');
    const onError = vi.fn();

    expect(() => deferCardAction(() => { throw failure; }, onError)).not.toThrow();

    await vi.advanceTimersByTimeAsync(500);
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
  });
});
