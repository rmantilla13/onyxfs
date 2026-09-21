-- Run this WHILE the files page is spinning. That is the whole point: the
-- question is what the server is doing during those fifteen seconds, and
-- afterwards there is nothing left to see.
--
-- Context: /api/files times out at 15s with [executing on the server] — sent,
-- awaiting a reply — while connect takes 202ms, three other queries on the
-- same instance succeed, and `files` holds ONE row. So it is not the
-- connection, not the data, and not head-of-line blocking in the driver.
--
-- Three possibilities remain, and this tells them apart:
--   the query is HERE and waiting on a lock   -> wait_event_type = 'Lock'
--   the query is HERE and burning CPU         -> state=active, no wait event
--   the query never arrived                   -> it does not appear at all,
--                                                which points at Supavisor
SELECT
  pid,
  state,
  wait_event_type,              -- 'Lock' is the answer if it is contention
  wait_event,
  now() - query_start  AS running_for,
  now() - state_change AS in_state_for,
  -- Who is blocking this one, if anyone.
  pg_blocking_pids(pid) AS blocked_by,
  left(regexp_replace(query, '\s+', ' ', 'g'), 90) AS query
FROM pg_stat_activity
WHERE datname = current_database()
  AND pid <> pg_backend_pid()
ORDER BY (state = 'active') DESC, query_start
LIMIT 20;
