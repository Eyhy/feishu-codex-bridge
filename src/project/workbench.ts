import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { projectWelcomeCard } from '../card/templates';
import { updateMessageCard } from '../card/update';
import type { Project, ProjectBindingStore } from './types';
import { log } from '../core/logger';

/**
 * Keep one visible project-group workbench. Older bridge versions sent a new
 * card for every top-level message, which made the group look like a stream
 * of competing entry points.
 */
export async function showProjectWorkbench(
  channel: LarkChannel,
  bindings: ProjectBindingStore,
  project: Project,
  targetMessageId?: string,
): Promise<void> {
  const messageId = targetMessageId ?? project.homeMessageId;
  if (messageId) {
    try {
      await updateMessageCard(channel, messageId, projectWelcomeCard(project));
      if (!project.homeMessageId) await bindings.bindProjectHomeMessage(project.projectKey, messageId);
      return;
    } catch (err) {
      log.warn('project', 'workbench-update-failed', { messageId, err: String(err) });
    }
  }

  const sent = await channel.send(project.chatId ?? '', { card: projectWelcomeCard(project) });
  if (sent.messageId) await bindings.bindProjectHomeMessage(project.projectKey, sent.messageId);
}
