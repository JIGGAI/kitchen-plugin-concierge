export { handleRequest } from './api/handler';
export type { PluginRequest, PluginResponse } from './api/handler';
export { initializeDatabase } from './db';
export * as schema from './db/schema';

export { hasRole, visibleSlices, toolsFor, toolName } from './slices/types';
export type { Slice, SliceContext, SliceParam, OpenAITool } from './slices/types';

export const pluginMeta = {
  id: 'concierge',
  name: 'Concierge',
  version: '0.1.0',
  teamTypes: ['marketing-team', 'ops-team'],
};
