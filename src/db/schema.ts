import { sqliteTable, text, primaryKey } from 'drizzle-orm/sqlite-core';

export const pluginConfig = sqliteTable('plugin_config', {
  teamId: text('team_id').notNull(),
  key: text('key').notNull(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.teamId, t.key] }) }));

export const conversation = sqliteTable('conversation', {
  id: text('id').primaryKey(),
  teamId: text('team_id').notNull(),
  userId: text('user_id').notNull(),
  /** 'active' | 'archived' — archived threads are kept, never auto-deleted. */
  status: text('status').notNull().default('active'),
  summary: text('summary'),
  summarizedAt: text('summarized_at'),
  createdAt: text('created_at').notNull(),
  lastActiveAt: text('last_active_at').notNull(),
});

export const message = sqliteTable('message', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull(),
  role: text('role').notNull(),
  content: text('content').notNull(),
  sources: text('sources'),
  createdAt: text('created_at').notNull(),
});

export const issueReport = sqliteTable('issue_report', {
  id: text('id').primaryKey(),
  teamId: text('team_id').notNull(),
  conversationId: text('conversation_id'),
  userId: text('user_id').notNull(),
  userEmail: text('user_email'),
  title: text('title').notNull(),
  /** The draft the model wrote, as JSON. */
  draft: text('draft').notNull(),
  /** The email body that went out, verbatim. */
  prompt: text('prompt').notNull(),
  /** Comma-separated addresses. */
  recipients: text('recipients').notNull(),
  /** 'pending' | 'sent' | 'failed' */
  status: text('status').notNull().default('pending'),
  error: text('error'),
  createdAt: text('created_at').notNull(),
});
