// lib/schema.js — Drizzle table definitions for Auth.js ONLY.
//
// Onyx's own tables are not here. They are created lazily by the ensure*
// guards in lib/db.js and queried with tagged-template SQL, which keeps the
// schema next to the code that uses it and removes the migration step.
//
// Auth.js is the exception: its DrizzleAdapter needs real Drizzle table
// objects to talk to the four tables the spec defines. So these four live
// here, in Drizzle's DSL, and nothing else does. The matching DDL is in
// db/init.sql and is also applied lazily by ensureAuthTables() in lib/db.js.

import { pgTable, text, timestamp, bigint, primaryKey } from 'drizzle-orm/pg-core';

export const users = pgTable('user', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text('name'),
  email: text('email').unique(),
  emailVerified: timestamp('emailVerified', { mode: 'date' }),
  image: text('image'),
});

export const accounts = pgTable(
  'account',
  {
    userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('providerAccountId').notNull(),
    refresh_token: text('refresh_token'),
    access_token: text('access_token'),
    expires_at: bigint('expires_at', { mode: 'number' }),
    token_type: text('token_type'),
    scope: text('scope'),
    id_token: text('id_token'),
    session_state: text('session_state'),
  },
  (t) => ({ pk: primaryKey({ columns: [t.provider, t.providerAccountId] }) })
);

export const sessions = pgTable('session', {
  sessionToken: text('sessionToken').primaryKey(),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expires: timestamp('expires', { mode: 'date' }).notNull(),
});

export const verificationTokens = pgTable(
  'verificationToken',
  {
    identifier: text('identifier').notNull(),
    token: text('token').notNull(),
    expires: timestamp('expires', { mode: 'date' }).notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.identifier, t.token] }) })
);
