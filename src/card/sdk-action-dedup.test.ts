import { DefaultCache, LarkChannel } from '@larksuiteoapi/node-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

// LarkChannel exposes no offline event-injection API. Use its dispatcher only
// as the test transport so the actual SDK normalizer and dedup pipeline run.
interface OfflineChannelDriver {
  registerDispatcherHandlers(): void;
  dispatcher: { invoke(event: object, options: { needCheck: false }): Promise<unknown> };
  safety: { dispose(): Promise<void> };
}

const drivers: OfflineChannelDriver[] = [];

function harness() {
  const channel = new LarkChannel({
    appId: 'test-app', appSecret: 'test-secret', includeRawEvent: true,
    cache: new DefaultCache(),
  });
  const driver = channel as unknown as OfflineChannelDriver;
  drivers.push(driver);
  driver.registerDispatcherHandlers();
  const handler = vi.fn().mockResolvedValue(undefined);
  channel.on('cardAction', handler);

  return {
    handler,
    emit(eventId?: string, token?: string) {
      return driver.dispatcher.invoke({
        schema: '2.0',
        header: { event_type: 'card.action.trigger', ...(eventId ? { event_id: eventId } : {}) },
        event: {
          ...(token ? { token } : {}),
          context: { open_message_id: 'test-card', open_chat_id: 'test-chat' },
          operator: { open_id: 'test-user' },
          action: { tag: 'button', value: { cmd: 'sessions' } },
        },
      }, { needCheck: false });
    },
  };
}

describe('SDK card action deduplication', () => {
  afterEach(async () => {
    await Promise.all(drivers.splice(0).map((driver) => driver.safety.dispose()));
  });

  it('runs distinct clicks on the same card button using their event IDs', async () => {
    const { emit, handler } = harness();

    await emit('event-1', 'same-token');
    await emit('event-2', 'same-token');

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('processes a redelivery of the same event only once', async () => {
    const { emit, handler } = harness();

    await emit('event-1', 'token-1');
    await emit('event-1', 'token-2');

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('falls back to the callback token when no event ID is available', async () => {
    const { emit, handler } = harness();

    await emit(undefined, 'token-1');
    await emit(undefined, 'token-2');
    await emit(undefined, 'token-1');

    expect(handler).toHaveBeenCalledTimes(2);
  });
});
