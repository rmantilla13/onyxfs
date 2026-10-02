-- db/init.sql — OPTIONAL, and GENERATED: run `npm run schema:sql`, never edit.
--
-- Onyx creates every table lazily, on first use, from the ensure*Table()
-- guards in lib/db.js. A fresh database self-assembles on the first request
-- and no migration step is needed to deploy.
--
-- This file exists for the case where you would rather have the whole schema
-- up front: run it once in the SQL editor and the guards become no-ops. It is
-- captured from the statements those guards send to an empty database
-- (scripts/gen-init-sql.mjs), so the two agree by construction. The large-
-- library indexes the app builds CONCURRENTLY appear here in the plain form,
-- which on a fresh database is instant.
--
-- Statements: 153

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

CREATE TABLE IF NOT EXISTS user_avatars (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  image BYTEA NOT NULL,
  type TEXT NOT NULL,
  version BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS people (
  id                   TEXT PRIMARY KEY,
  email                TEXT NOT NULL UNIQUE,
  display_name         TEXT,
  role_id              TEXT,
  status               TEXT NOT NULL DEFAULT 'active',
  status_reason        TEXT,
  status_changed_at    BIGINT,
  status_changed_by    TEXT,
  pause_links          BOOLEAN NOT NULL DEFAULT true,
  sessions_valid_after BIGINT,
  quota_bytes          BIGINT,
  max_upload_bytes     BIGINT,
  ai_monthly_cents     INT,
  prefs                JSONB NOT NULL DEFAULT '{}',
  first_seen_at        BIGINT,
  last_seen_at         BIGINT,
  created_at           BIGINT NOT NULL,
  updated_at           BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS people_role_idx ON people (role_id);

CREATE TABLE IF NOT EXISTS audit_events (
  id            TEXT PRIMARY KEY,
  at            BIGINT NOT NULL,
  actor         TEXT,
  action        TEXT NOT NULL,
  subject_type  TEXT,
  subject_id    TEXT,
  subject_label TEXT,
  detail        JSONB
);

CREATE INDEX IF NOT EXISTS audit_events_at_idx ON audit_events (at DESC);

CREATE INDEX IF NOT EXISTS audit_events_subject_idx ON audit_events (subject_type, subject_id, at DESC);

CREATE INDEX IF NOT EXISTS audit_events_actor_idx ON audit_events (actor, at DESC);

CREATE TABLE IF NOT EXISTS maintenance_runs (
  id           TEXT PRIMARY KEY,
  trigger      TEXT NOT NULL,
  triggered_by TEXT,
  started_at   BIGINT NOT NULL,
  finished_at  BIGINT,
  ok           BOOLEAN,
  result       JSONB
);

CREATE INDEX IF NOT EXISTS maintenance_runs_started_idx ON maintenance_runs (started_at DESC);

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

ALTER TABLE files ADD COLUMN IF NOT EXISTS filmstrip_key TEXT;

ALTER TABLE files ADD COLUMN IF NOT EXISTS poster_key TEXT;

CREATE INDEX IF NOT EXISTS files_poster_key_idx ON files (poster_key) WHERE poster_key IS NOT NULL;

ALTER TABLE files ADD COLUMN IF NOT EXISTS thumb_sizes TEXT;

ALTER TABLE files ADD COLUMN IF NOT EXISTS deleted_at BIGINT;

ALTER TABLE files ADD COLUMN IF NOT EXISTS trash_key TEXT;

ALTER TABLE files ADD COLUMN IF NOT EXISTS deleted_by TEXT;

ALTER TABLE files ADD COLUMN IF NOT EXISTS thumb_status TEXT;

CREATE INDEX IF NOT EXISTS brand_files_thumb_status_idx ON files (thumb_status);

ALTER TABLE files ADD COLUMN IF NOT EXISTS preview_tries INT DEFAULT 0;

ALTER TABLE files ADD COLUMN IF NOT EXISTS preview_tried_at BIGINT;

ALTER TABLE files ADD COLUMN IF NOT EXISTS preview_error TEXT;

CREATE INDEX IF NOT EXISTS brand_files_kind_idx ON files (kind);

ALTER TABLE files ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS brand_files_metadata_gin ON files USING GIN (metadata jsonb_path_ops);

CREATE INDEX IF NOT EXISTS brand_files_tags_gin ON files USING GIN (tags jsonb_path_ops);

CREATE SEQUENCE IF NOT EXISTS files_change_seq;

ALTER TABLE files ADD COLUMN IF NOT EXISTS seq BIGINT;

CREATE INDEX IF NOT EXISTS files_seq_idx ON files (seq);

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

CREATE INDEX IF NOT EXISTS files_live_folder_idx ON files (folder) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS files_content_hash_idx ON files (content_hash, size) WHERE deleted_at IS NULL AND content_hash IS NOT NULL;

ALTER TABLE files ADD COLUMN IF NOT EXISTS review_status TEXT;

ALTER TABLE files ADD COLUMN IF NOT EXISTS open_comments INT NOT NULL DEFAULT 0;

ALTER TABLE files ADD COLUMN IF NOT EXISTS file_created_at BIGINT;

ALTER TABLE files ADD COLUMN IF NOT EXISTS file_modified_at BIGINT;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS files_folder_created_idx ON files (folder, created_at, id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS files_folder_name_idx ON files (folder, name, id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS files_folder_size_idx ON files (folder, (coalesce(size, -1)), id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS files_folder_updated_idx ON files (folder, updated_at, id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS files_folder_modified_idx ON files (folder, (coalesce(file_modified_at, updated_at)), id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS files_folder_file_created_idx ON files (folder, (coalesce(file_created_at, created_at)), id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS files_folder_mime_idx ON files (folder, (coalesce(mime, '')), id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS files_live_key_idx ON files (storage_key text_pattern_ops) INCLUDE (size) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS files_name_trgm_idx ON files USING GIN (name gin_trgm_ops) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS files_created_by_size_idx ON files (created_by, size) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS files_unmoved_trash_idx ON files (storage_key) WHERE deleted_at IS NOT NULL AND trash_key IS NULL;

CREATE INDEX IF NOT EXISTS files_trash_key_idx ON files (trash_key) WHERE trash_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS files_filmstrip_key_idx ON files (filmstrip_key) WHERE filmstrip_key IS NOT NULL;

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

ALTER TABLE uploads ADD COLUMN IF NOT EXISTS replace_of TEXT;

CREATE TABLE IF NOT EXISTS upload_keys (
  storage_key TEXT NOT NULL,
  email       TEXT NOT NULL,
  bucket      TEXT NOT NULL DEFAULT '',
  issued_at   BIGINT NOT NULL,
  PRIMARY KEY (storage_key, email)
);

CREATE INDEX IF NOT EXISTS upload_keys_issued_idx ON upload_keys (issued_at);

ALTER TABLE upload_keys ADD COLUMN IF NOT EXISTS replace_of TEXT;

CREATE TABLE IF NOT EXISTS file_tombstones (
  id          TEXT PRIMARY KEY,
  seq         BIGINT NOT NULL,
  folder      TEXT,
  storage_key TEXT,
  deleted_at  BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS file_tombstones_seq_idx ON file_tombstones (seq);

CREATE TABLE IF NOT EXISTS change_marks (
  at   TIMESTAMPTZ NOT NULL,
  seq  BIGINT NOT NULL,
  next_xid BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS change_marks_at_idx ON change_marks (at);

CREATE TABLE IF NOT EXISTS folders (name TEXT PRIMARY KEY, created_at BIGINT NOT NULL);

ALTER TABLE folders ADD COLUMN IF NOT EXISTS parent TEXT DEFAULT '';

ALTER TABLE folders ADD COLUMN IF NOT EXISTS depth INT DEFAULT 0;

ALTER TABLE folders ADD COLUMN IF NOT EXISTS visibility TEXT DEFAULT 'org';

ALTER TABLE folders ADD COLUMN IF NOT EXISTS created_by TEXT;

ALTER TABLE folders ADD COLUMN IF NOT EXISTS filespace TEXT DEFAULT '';

CREATE INDEX IF NOT EXISTS folders_parent_idx ON folders (parent);

CREATE UNIQUE INDEX IF NOT EXISTS folders_scope_name_idx ON folders ((COALESCE(filespace, '')), name);

ALTER TABLE folders DROP CONSTRAINT IF EXISTS folders_pkey;

ALTER TABLE folders ALTER COLUMN name SET NOT NULL;

ALTER TABLE folders ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE folders ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS folder_move_copies (
  to_key   TEXT PRIMARY KEY,
  from_key TEXT NOT NULL,
  noted_at BIGINT NOT NULL
);

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

ALTER TABLE file_shares ADD COLUMN IF NOT EXISTS pw_failures INT NOT NULL DEFAULT 0;

ALTER TABLE file_shares ADD COLUMN IF NOT EXISTS pw_locked_until BIGINT;

CREATE INDEX IF NOT EXISTS file_shares_created_by_idx ON file_shares (created_by);

ALTER TABLE file_shares ADD COLUMN IF NOT EXISTS review TEXT;

CREATE SEQUENCE IF NOT EXISTS review_change_seq;

CREATE TABLE IF NOT EXISTS review_comments (
  id           TEXT PRIMARY KEY,
  file_id      TEXT NOT NULL,
  stack_id     TEXT,
  parent_id    TEXT,
  author_email TEXT,
  guest_id     TEXT,
  author_name  TEXT,
  body         TEXT NOT NULL,
  anchor       TEXT NOT NULL DEFAULT 'general',
  frame_in     INT,
  frame_out    INT,
  fps_num      INT,
  fps_den      INT,
  point_x      REAL,
  point_y      REAL,
  annotation   JSONB,
  mentions     JSONB,
  audience     TEXT NOT NULL DEFAULT 'all',
  share_token  TEXT,
  resolved_at  BIGINT,
  resolved_by  TEXT,
  edited_at    BIGINT,
  deleted_at   BIGINT,
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL,
  seq          BIGINT NOT NULL DEFAULT nextval('review_change_seq')
);

CREATE INDEX IF NOT EXISTS review_comments_file_seq_idx ON review_comments (file_id, seq);

CREATE INDEX IF NOT EXISTS review_comments_parent_idx ON review_comments (parent_id) WHERE parent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS review_comments_stack_idx ON review_comments (stack_id) WHERE stack_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS review_comments_share_idx ON review_comments (share_token, created_at) WHERE share_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS review_decisions (
  file_id     TEXT NOT NULL,
  reviewer    TEXT NOT NULL,
  status      TEXT NOT NULL,
  note        TEXT,
  share_token TEXT,
  decided_at  BIGINT NOT NULL,
  seq         BIGINT NOT NULL DEFAULT nextval('review_change_seq'),
  PRIMARY KEY (file_id, reviewer)
);

ALTER TABLE review_decisions ADD COLUMN IF NOT EXISTS reviewer_name TEXT;

CREATE TABLE IF NOT EXISTS review_watchers (
  file_id         TEXT NOT NULL,
  email           TEXT NOT NULL,
  added_at        BIGINT NOT NULL,
  muted           BOOLEAN NOT NULL DEFAULT false,
  last_emailed_at BIGINT,
  PRIMARY KEY (file_id, email)
);

CREATE TABLE IF NOT EXISTS review_reads (
  subject  TEXT NOT NULL,
  file_id  TEXT NOT NULL,
  last_seq BIGINT NOT NULL,
  read_at  BIGINT NOT NULL,
  PRIMARY KEY (subject, file_id)
);

CREATE TABLE IF NOT EXISTS transcripts (
  file_id         TEXT PRIMARY KEY,
  status          TEXT NOT NULL DEFAULT 'queued',
  language        TEXT,
  result_language TEXT,
  engine          TEXT,
  source_key      TEXT,
  segments        JSONB,
  text            TEXT,
  progress        REAL,
  error           TEXT,
  requested_by    TEXT,
  requested_at    TIMESTAMPTZ,
  claimed_by      TEXT,
  claimed_device  TEXT,
  lease_until     TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transcripts_queue_idx ON transcripts (requested_at) WHERE status IN ('queued', 'working');

CREATE TABLE IF NOT EXISTS saved_views (
  id          TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  name        TEXT NOT NULL,
  drive_id    TEXT,
  filters     JSONB NOT NULL DEFAULT '{}'::jsonb,
  sort        TEXT NOT NULL DEFAULT 'new',
  display     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS saved_views_owner_idx ON saved_views (owner_email, created_at);

CREATE TABLE IF NOT EXISTS folder_stars (
  owner_email TEXT NOT NULL,
  drive_id    TEXT NOT NULL DEFAULT '',
  folder      TEXT NOT NULL,
  created_at  BIGINT NOT NULL,
  PRIMARY KEY (owner_email, drive_id, folder)
);

CREATE INDEX IF NOT EXISTS folder_stars_path_idx ON folder_stars (drive_id, folder);

CREATE TABLE IF NOT EXISTS collections (
  id          TEXT PRIMARY KEY,
  drive_id    TEXT NOT NULL DEFAULT '',
  name        TEXT NOT NULL,
  match       TEXT NOT NULL DEFAULT 'all',
  rules       JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by  TEXT,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS collections_drive_idx ON collections (drive_id, name);

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

ALTER TABLE filespaces ADD COLUMN IF NOT EXISTS quota_bytes BIGINT;

ALTER TABLE filespaces ADD COLUMN IF NOT EXISTS ai_allowed BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE filespaces ADD COLUMN IF NOT EXISTS share_kinds TEXT;

CREATE TABLE IF NOT EXISTS proxies (
  file_id         TEXT PRIMARY KEY,
  status          TEXT NOT NULL DEFAULT 'queued',
  proxy_key       TEXT,
  source_key      TEXT,
  width           INT,
  height          INT,
  size            BIGINT,
  duration        REAL,
  progress        REAL,
  error           TEXT,
  requested_by    TEXT,
  requested_at    TIMESTAMPTZ,
  claimed_by      TEXT,
  claimed_device  TEXT,
  lease_until     TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS proxies_queue_idx ON proxies (requested_at) WHERE status IN ('queued', 'working');

CREATE TABLE IF NOT EXISTS storage_prices (
  account        TEXT PRIMARY KEY,
  rate           NUMERIC NOT NULL,
  unit           TEXT NOT NULL,
  base           INT NOT NULL,
  free_bytes     BIGINT NOT NULL DEFAULT 0,
  minimum_bytes  BIGINT NOT NULL DEFAULT 0,
  fee            NUMERIC NOT NULL DEFAULT 0,
  note           TEXT,
  set_at         BIGINT NOT NULL,
  set_by         TEXT
);

CREATE TABLE IF NOT EXISTS sign_in_passwords (
  email         TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  set_at        BIGINT NOT NULL,
  set_by        TEXT,
  failures      INT NOT NULL DEFAULT 0,
  locked_until  BIGINT
);

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

ALTER TABLE desktop_auth_codes ADD COLUMN IF NOT EXISTS device_token_id TEXT;

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
