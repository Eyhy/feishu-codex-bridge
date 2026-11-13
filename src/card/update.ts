import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';

/** The SDK's updateCard discards Feishu's business-error response. */
export async function updateMessageCard(
  channel: LarkChannel,
  messageId: string,
  card: object,
): Promise<void> {
  log.info('card', 'message-update-start');
  const response = await channel.rawClient.im.v1.message.patch({
    path: { message_id: messageId },
    data: { content: JSON.stringify(card) },
  });
  log.info('card', 'message-update-result', { code: response.code });
  if (typeof response.code === 'number' && response.code !== 0) {
    throw new Error(`Feishu card update failed (${response.code}): ${response.msg ?? 'unknown error'}`);
  }
}
