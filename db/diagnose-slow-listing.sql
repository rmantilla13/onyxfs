-- Why is the file listing slow?  ONE statement — paste and run.
--
-- Written after /api/files blew its 15s deadline while the connection itself
-- was healthy: transaction pooler, connect and first query in 199ms, five
-- other queries on the same instance succeeding.
--
-- The mechanism, reproduced locally against this schema with 200k rows: the
-- listing reads `created_at DESC` and excludes artifacts with two regex `!~`
-- predicates and an anti-join. None of those can be served by an index, so
-- they are evaluated per row. Identical query, identical row count, only the
-- distribution changed:
--
--     artifacts mixed through       141 rows skipped     0.97ms
--     artifacts sorting newest  140,000 rows skipped   478ms
--
-- ...and the 478ms was entirely from shared buffers, no disk. The row named
-- "rows walked past on EVERY page load" is the one that decides whether this
-- is what your database is doing.

WITH tagged AS (
  SELECT created_at, deleted_at,
         (storage_key IS NOT NULL AND (
            storage_key ~ '(^|/)_thumbs/|(^|/)[^/]*-thumb-[^/]*\.(jpe?g|png|webp)$'
         OR storage_key ~ '(^|/)(\.DS_Store|\.localized|Thumbs\.db|desktop\.ini|\._[^/]*)$'
         )) AS is_artifact
  FROM files
),
newest_real AS (
  SELECT max(created_at) AS c FROM tagged WHERE NOT is_artifact AND deleted_at IS NULL
),
stats AS (
  SELECT n_live_tup, n_dead_tup, last_analyze, last_autoanalyze, last_vacuum, last_autovacuum
  FROM pg_stat_user_tables WHERE relname = 'files'
)
SELECT * FROM (
  SELECT 1 AS ord, 'total rows in files'            AS metric, (SELECT count(*)::text FROM tagged) AS value
  UNION ALL SELECT 2, 'trashed (deleted_at set)',   (SELECT count(*)::text FROM tagged WHERE deleted_at IS NOT NULL)
  UNION ALL SELECT 3, 'artifacts (thumbs + OS junk)', (SELECT count(*)::text FROM tagged WHERE is_artifact)
  UNION ALL SELECT 4, 'artifact %',                 (SELECT round(100.0 * count(*) FILTER (WHERE is_artifact)
                                                       / greatest(count(*), 1), 1)::text FROM tagged)
  UNION ALL SELECT 5, '>>> rows walked past on EVERY page load <<<',
                      (SELECT count(*)::text FROM tagged
                        WHERE is_artifact AND created_at > (SELECT c FROM newest_real))
  UNION ALL SELECT 6, 'table size',                 pg_size_pretty(pg_total_relation_size('files'))
  UNION ALL SELECT 7, 'live / dead tuples',         (SELECT n_live_tup || ' / ' || n_dead_tup FROM stats)
  UNION ALL SELECT 8, 'dead %  (bloat slows scans)',(SELECT round(100.0 * n_dead_tup
                                                       / greatest(n_live_tup + n_dead_tup, 1), 1)::text FROM stats)
  UNION ALL SELECT 9, 'last analyze (stale stats = bad plan)',
                      (SELECT coalesce(greatest(last_analyze, last_autoanalyze)::text, 'never') FROM stats)
  UNION ALL SELECT 10,'last vacuum',                (SELECT coalesce(greatest(last_vacuum, last_autovacuum)::text, 'never') FROM stats)
) q ORDER BY ord;
