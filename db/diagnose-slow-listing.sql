-- Why is the file listing slow?
--
-- Written after /api/files blew its 15s deadline in production while the
-- connection itself was healthy — transaction pooler, connect and first query
-- in 199ms, five other queries on the same instance succeeding.
--
-- The mechanism, reproduced locally against 200k rows: the listing reads
-- `created_at DESC` and filters artifacts out with two regex `!~` predicates
-- and an anti-join. None of those can be served by an index, so they are
-- evaluated per row. The same query took 0.97ms with artifacts mixed through
-- the table and 478ms with 140,000 of them sorting above the newest real
-- file — and that 478ms was entirely from shared buffers, no disk. Section 2
-- below is the number that decides it.
--
-- Read-only. Paste into Supabase -> SQL Editor.

-- === 1. how much of the table is NOT a real file ===
WITH tagged AS (
  SELECT created_at, deleted_at,
         (storage_key IS NOT NULL AND (
            storage_key ~ '(^|/)_thumbs/|(^|/)[^/]*-thumb-[^/]*\.(jpe?g|png|webp)$'
         OR storage_key ~ '(^|/)(\.DS_Store|\.localized|Thumbs\.db|desktop\.ini|\._[^/]*)$'
         )) AS is_artifact
  FROM files
)
SELECT count(*)                                            AS total_rows,
       count(*) FILTER (WHERE deleted_at IS NOT NULL)      AS trashed,
       count(*) FILTER (WHERE is_artifact)                 AS artifacts,
       round(100.0 * count(*) FILTER (WHERE is_artifact) / greatest(count(*),1), 1) AS artifact_pct,
       pg_size_pretty(pg_total_relation_size('files'))     AS table_size
FROM tagged;

-- === 2. THE number: artifacts the listing must walk past before page 1 ===
-- The listing reads created_at DESC. Everything non-real that sorts above the
-- newest real file is skipped on EVERY page load, evaluating two regexes and
-- an index probe per row.
WITH tagged AS (
  SELECT created_at, deleted_at,
         (storage_key IS NOT NULL AND (
            storage_key ~ '(^|/)_thumbs/|(^|/)[^/]*-thumb-[^/]*\.(jpe?g|png|webp)$'
         OR storage_key ~ '(^|/)(\.DS_Store|\.localized|Thumbs\.db|desktop\.ini|\._[^/]*)$'
         )) AS is_artifact
  FROM files
), newest_real AS (
  SELECT max(created_at) AS c FROM tagged WHERE NOT is_artifact AND deleted_at IS NULL
)
SELECT (SELECT c FROM newest_real)                                  AS newest_real_file_at,
       count(*)                                                     AS rows_skipped_every_page_load
FROM tagged WHERE is_artifact AND created_at > (SELECT c FROM newest_real);

-- === 3. are the statistics current? a stale plan looks identical to a slow query ===
SELECT relname, n_live_tup, n_dead_tup,
       round(100.0 * n_dead_tup / greatest(n_live_tup + n_dead_tup, 1), 1) AS dead_pct,
       last_vacuum, last_autovacuum, last_analyze, last_autoanalyze
FROM pg_stat_user_tables WHERE relname = 'files';

-- === 4. anything blocked or long-running right now ===
SELECT state, count(*) AS conns, max(now() - query_start) AS longest
FROM pg_stat_activity WHERE datname = current_database() GROUP BY state ORDER BY conns DESC;
