export { handleRequest } from './api/handler';
export type { PluginRequest, PluginResponse } from './api/handler';
export { initializeDatabase } from './db';
export * as schema from './db/schema';

export const pluginMeta = {
  id: 'concierge',
  name: 'Concierge',
  version: '0.1.0',
  teamTypes: ['marketing-team', 'ops-team'],
};
