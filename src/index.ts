export { handleRequest } from './api/handler';
export type { PluginRequest, PluginResponse } from './api/handler';
export { initializeDatabase } from './db';
export * as schema from './db/schema';

export { hasRole, visibleSlices, toolsFor, toolName } from './slices/types';
export type { Slice, SliceContext, SliceParam, OpenAITool } from './slices/types';

export { streamChat } from './chat/stream';
export type { ConciergeEvent, StreamChatInput, Source, ChatTurn } from './chat/stream';
export { readGatewayTarget, sessionKeyFor, DEFAULT_AGENT_ID } from './chat/gateway';
export type { GatewayTarget } from './chat/gateway';
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

export {
  REPORT_ISSUE_TOOL, REPORT_ISSUE_TOOL_NAME, normalizeIssueDraft, buildIssuePrompt, issueRef,
  createIssueReport, markIssueReport, countRecentIssueReports, listIssueReports, getIssueReport,
} from './reports/issue';
export type { IssueDraft, IssueReporter, IssuePromptInput, IssueReportRow } from './reports/issue';
