export { handleRequest } from './api/handler';
export type { PluginRequest, PluginResponse } from './api/handler';
export { initializeDatabase } from './db';
export * as schema from './db/schema';

export { hasRole, visibleSlices, toolsFor, toolName } from './slices/types';
export type { Slice, SliceContext, SliceParam, OpenAITool } from './slices/types';

export { streamChat } from './chat/stream';
export type { ConciergeEvent, StreamChatInput, Source, ChatTurn } from './chat/stream';
export { readCodexCredential, credentialIsFresh } from './chat/credentials';
export type { CodexCredential } from './chat/credentials';
export { systemPrompt, DEFAULT_PERSONA } from './chat/prompt';

export const pluginMeta = {
  id: 'concierge',
  name: 'Concierge',
  version: '0.1.0',
  teamTypes: ['marketing-team', 'ops-team'],
};

export {
  openConversation, appendMessage, recentTurns, transcriptFor,
  archiveConversation, archiveActiveFor, recentSummaries,
  listConversations, deleteConversation, idleUnsummarized,
} from './db/history';
export type { ConversationRow } from './db/history';
export { summarizeTurns } from './chat/summarize';
