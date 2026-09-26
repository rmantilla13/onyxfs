/**
 * Where a drive lives, said the same way in the list and in the drawer:
 * "Default bucket" in words when it is the Storage bucket, otherwise the
 * bucket's name; the folder always as the identifier it is. The full
 * bucket/folder is on hover. `row` is driveRow() (lib/admin-drives.js).
 *
 * No hooks, so the list and the drawer (both client) and any server
 * section can use it.
 */
export default function DriveLocation({ row }) {
  if (!row) return null;
  return (
    <span className="drive-loc" title={`${row.bucket || row.bucketLabel} / ${row.prefix}`}>
      {row.isDefaultBucket
        ? <span className="muted">{row.bucketLabel}</span>
        : <span className="admin-mono">{row.bucket}</span>}
      <span className="muted"> / </span>
      <span className="admin-mono">{row.prefix}</span>
    </span>
  );
}
