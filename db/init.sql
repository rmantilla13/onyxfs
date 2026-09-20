-- db/init.sql — OPTIONAL.
--
-- Onyx creates every table lazily, on first use, from the ensure*Table()
-- guards in lib/db.js. A fresh database self-assembles on the first request
-- and no migration step is needed to deploy.
--
-- This file exists for the case where you would rather have the whole schema
-- up front: run it once in the SQL editor and the guards become no-ops. It is
-- GENERATED from the same statements lib/db.js executes, so the two agree by
-- construction; regenerate it rather than hand-editing.
--
-- Statements: 73

CREATE TABLE IF NOT EXISTS "user" (
    id              TEXT PRIMARY KEY,
    name            TEXT,
    email           TEXT UNIQUE,
    "emailVerified" TIMESTAMPTZ,
    image           TEXT
  );

CREATE TABLE IF NOT EXISTS "account" (
    "userId"            TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    type                TEXT NOT NULL,
    provider            TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    refresh_token       TEXT,
    access_token        TEXT,
    expires_at          BIGINT,
    token_type          TEXT,
    scope               TEXT,
    id_token            TEXT,
    session_state       TEXT,
    PRIMARY KEY (provider, "providerAccountId")
  );

CREATE TABLE IF NOT EXISTS "session" (
    "sessionToken" TEXT PRIMARY KEY,
    "userId"       TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    expires        TIMESTAMPTZ NOT NULL
  );

CREATE TABLE IF NOT EXISTS "verificationToken" (
    identifier TEXT NOT NULL,
    token      TEXT NOT NULL,
    expires    TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (identifier, token)
  );

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  BIGINT NOT NULL,
  updated_by  TEXT
);

CREATE TABLE IF NOT EXISTS magic_link_redirects (
    id TEXT PRIMARY KEY,
    target_url TEXT NOT NULL,
    email TEXT,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL
  );

CREATE INDEX IF NOT EXISTS magic_link_redirects_expires_idx ON magic_link_redirects (expires_at);

CREATE TABLE IF NOT EXISTS invite_requests (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  reason TEXT,
  status TEXT NOT NULL,
  requested_at BIGINT NOT NULL,
  reviewed_at BIGINT,
  reviewed_by TEXT,
  review_note TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_email TEXT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  agent_key TEXT,
  metadata JSONB,
  created_at BIGINT NOT NULL,
  read_at BIGINT
);

CREATE TABLE IF NOT EXISTS notification_reads (
  notification_id TEXT NOT NULL,
  user_email TEXT NOT NULL,
  read_at BIGINT NOT NULL,
  PRIMARY KEY (notification_id, user_email)
);

CREATE TABLE IF NOT EXISTS user_preferences (
    email TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    updated_at BIGINT NOT NULL
  );

CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    folder TEXT DEFAULT '',
    kind TEXT,
    mime TEXT,
    size BIGINT,
    url TEXT NOT NULL,
    storage TEXT DEFAULT 'blob',
    storage_key TEXT,
    tags JSONB,
    notes TEXT,
    created_by TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  );

CREATE INDEX IF NOT EXISTS brand_files_folder_idx ON files (folder);

CREATE INDEX IF NOT EXISTS brand_files_created_idx ON files (created_at DESC);

ALTER TABLE files ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'org';

ALTER TABLE files ADD COLUMN IF NOT EXISTS caption TEXT;

ALTER TABLE files ADD COLUMN IF NOT EXISTS captioned_at BIGINT;

ALTER TABLE files ADD COLUMN IF NOT EXISTS thumbnail_url TEXT;

ALTER TABLE files ADD COLUMN IF NOT EXISTS thumbnail_key TEXT;

ALTER TABLE files ADD COLUMN IF NOT EXISTS deleted_at BIGINT;

ALTER TABLE files ADD COLUMN IF NOT EXISTS trash_key TEXT;

ALTER TABLE files ADD COLUMN IF NOT EXISTS thumb_status TEXT;

CREATE INDEX IF NOT EXISTS brand_files_thumb_status_idx ON files (thumb_status);

CREATE INDEX IF NOT EXISTS brand_files_kind_idx ON files (kind);

ALTER TABLE files ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS brand_files_metadata_gin ON files USING GIN (metadata jsonb_path_ops);

CREATE INDEX IF NOT EXISTS brand_files_tags_gin ON files USING GIN (tags jsonb_path_ops);

CREATE SEQUENCE IF NOT EXISTS files_change_seq;

ALTER TABLE files ADD COLUMN IF NOT EXISTS seq BIGINT;

CREATE INDEX IF NOT EXISTS files_seq_idx ON files (seq);

-- Two version tokens per item, for syncing clients. `version` changes on any
-- write and backs the If-Match precondition; `content_hash` changes only when
-- the bytes change, so a client can tell a rename from a re-upload without a
-- HEAD to S3 per item.
ALTER TABLE files ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1;
ALTER TABLE files ADD COLUMN IF NOT EXISTS content_hash TEXT;

ALTER TABLE files ADD COLUMN IF NOT EXISTS search_tsv tsvector
    GENERATED ALWAYS AS (
      to_tsvector('english',
        coalesce(name, '') || ' ' || coalesce(notes, '') || ' ' || coalesce(caption, ''))
    ) STORED;

CREATE INDEX IF NOT EXISTS files_search_idx ON files USING GIN (search_tsv);

CREATE INDEX IF NOT EXISTS files_created_id_idx ON files (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS files_name_id_idx ON files (name ASC, id ASC);

CREATE INDEX IF NOT EXISTS files_thumbnail_key_idx ON files (thumbnail_key);

CREATE TABLE IF NOT EXISTS uploads (
    id           TEXT PRIMARY KEY,
    upload_id    TEXT NOT NULL,
    storage_key  TEXT NOT NULL,
    filename     TEXT NOT NULL,
    size         BIGINT,
    mime         TEXT,
    folder       TEXT DEFAULT '',
    filespace_id TEXT,
    part_size    BIGINT NOT NULL,
    created_by   TEXT,
    created_at   BIGINT NOT NULL,
    updated_at   BIGINT NOT NULL
  );

CREATE INDEX IF NOT EXISTS uploads_owner_idx ON uploads (created_by, created_at DESC);

CREATE TABLE IF NOT EXISTS file_tombstones (
    id          TEXT PRIMARY KEY,
    seq         BIGINT NOT NULL,
    folder      TEXT,
    storage_key TEXT,
    deleted_at  BIGINT NOT NULL
  );

CREATE INDEX IF NOT EXISTS file_tombstones_seq_idx ON file_tombstones (seq);

CREATE TABLE IF NOT EXISTS folders (name TEXT PRIMARY KEY, created_at BIGINT NOT NULL);

ALTER TABLE folders ADD COLUMN IF NOT EXISTS parent TEXT DEFAULT '';

ALTER TABLE folders ADD COLUMN IF NOT EXISTS depth INT DEFAULT 0;

ALTER TABLE folders ADD COLUMN IF NOT EXISTS visibility TEXT DEFAULT 'org';

ALTER TABLE folders ADD COLUMN IF NOT EXISTS created_by TEXT;

ALTER TABLE folders ADD COLUMN IF NOT EXISTS filespace TEXT DEFAULT '';

CREATE INDEX IF NOT EXISTS folders_parent_idx ON folders (parent);

CREATE TABLE IF NOT EXISTS file_shares (
    token TEXT PRIMARY KEY,
    file_id TEXT NOT NULL,
    created_by TEXT,
    created_at BIGINT NOT NULL
  );

CREATE INDEX IF NOT EXISTS file_shares_file_idx ON file_shares (file_id);

ALTER TABLE file_shares ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'public';

ALTER TABLE file_shares ADD COLUMN IF NOT EXISTS expires_at BIGINT;

ALTER TABLE file_shares ADD COLUMN IF NOT EXISTS password_hash TEXT;

ALTER TABLE file_shares ADD COLUMN IF NOT EXISTS view_count INT NOT NULL DEFAULT 0;

ALTER TABLE file_shares ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'file';

ALTER TABLE file_shares ADD COLUMN IF NOT EXISTS folder TEXT;

ALTER TABLE file_shares ADD COLUMN IF NOT EXISTS storage_prefix TEXT;

ALTER TABLE file_shares ADD COLUMN IF NOT EXISTS brief_id TEXT;

ALTER TABLE file_shares ALTER COLUMN file_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS folder_access (
    folder TEXT NOT NULL,
    subject_type TEXT NOT NULL,   -- 'user' | 'role'
    subject TEXT NOT NULL,        -- email | role id
    role TEXT NOT NULL DEFAULT 'viewer', -- viewer | editor | owner
    granted_by TEXT,
    granted_at BIGINT NOT NULL,
    PRIMARY KEY (folder, subject_type, subject)
  );

CREATE INDEX IF NOT EXISTS vfa_subject_idx ON folder_access (subject_type, subject);

CREATE INDEX IF NOT EXISTS vfa_folder_idx ON folder_access (folder);

CREATE TABLE IF NOT EXISTS file_acl (
    file_id TEXT NOT NULL,
    scope TEXT NOT NULL,          -- 'user' | 'role'
    principal TEXT NOT NULL,      -- email | role id
    access TEXT NOT NULL DEFAULT 'viewer',
    granted_by TEXT,
    granted_at BIGINT NOT NULL,
    PRIMARY KEY (file_id, scope, principal)
  );

CREATE INDEX IF NOT EXISTS file_acl_file_idx ON file_acl (file_id);

CREATE TABLE IF NOT EXISTS filespaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    bucket TEXT NOT NULL,
    prefix TEXT NOT NULL,
    region TEXT,
    role_arn TEXT,
    created_by TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  );

CREATE INDEX IF NOT EXISTS filespaces_updated_idx ON filespaces (updated_at DESC);

CREATE TABLE IF NOT EXISTS filespace_access (
    filespace_id TEXT NOT NULL,
    user_email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer',
    granted_by TEXT,
    granted_at BIGINT NOT NULL,
    PRIMARY KEY (filespace_id, user_email)
  );

CREATE INDEX IF NOT EXISTS filespace_access_email_idx ON filespace_access (user_email);

ALTER TABLE filespaces ADD COLUMN IF NOT EXISTS access_key TEXT;

ALTER TABLE filespaces ADD COLUMN IF NOT EXISTS secret_key TEXT;

ALTER TABLE filespaces ADD COLUMN IF NOT EXISTS endpoint TEXT;

CREATE TABLE IF NOT EXISTS desktop_auth_codes (
    code TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    code_challenge TEXT,
    kind TEXT NOT NULL DEFAULT 'pkce',
    label TEXT,
    claimed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL
  );

CREATE INDEX IF NOT EXISTS desktop_auth_codes_expires_idx ON desktop_auth_codes (expires_at);

CREATE TABLE IF NOT EXISTS desktop_tokens (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    label TEXT,
    created_at BIGINT NOT NULL,
    expires_at BIGINT,
    last_used_at BIGINT
  );

CREATE INDEX IF NOT EXISTS desktop_tokens_email_idx ON desktop_tokens (email);
