'use client';

/**
 * Where a drive lives and with which keys: one set of fields, in one order,
 * with one wording, for "New drive" (NewDriveDialog, on the files page and
 * in Admin → Drives) and for a drive's settings (the drive drawer).
 *
 *   form      { bucket, region, roleArn, accessKeyId, secretAccessKey, endpoint }
 *   onField   k => change handler for that field
 *   ownKeys   whether the key fields are shown; onOwnKeys(bool) toggles it
 *   storage   { bucket, region } — the Storage settings, as placeholders
 *   mode      'new' (blank means the Storage setting) | 'edit'
 *   folder    the "Folder in the bucket" field, placed after Bucket (edit)
 *   locked    the drive holds files: the bucket (and the folder the caller
 *             renders) cannot change; `lockId` is the notice that says why
 *   hasSecret a secret is stored, so a blank one keeps it (edit)
 *
 * The role to assume is always shown, whether or not the drive has keys of
 * its own: hiding a field while keeping its value is how a setting nobody
 * can see ends up saved.
 */
export default function DriveLocationFields({
  form, onField, ownKeys, onOwnKeys, storage = {}, mode = 'new', folder = null,
  locked = false, lockId, hasSecret = false,
}) {
  const bucketHint = ownKeys
    ? 'Required with its own keys.'
    : mode === 'new'
      ? 'Blank uses the Storage bucket.'
      : storage.bucket && String(form.bucket || '').trim() === storage.bucket ? 'The Storage bucket.' : null;
  return (
    <>
      <div className="admin-form-grid">
        <label className="admin-field">
          <span className="admin-field-label">Bucket</span>
          <input
            className="input mono" value={form.bucket || ''} onChange={onField('bucket')} disabled={locked}
            placeholder={ownKeys ? '' : storage.bucket || ''} aria-describedby={locked ? lockId : undefined} autoComplete="off"
          />
          {bucketHint && !locked && <span className="admin-field-hint">{bucketHint}</span>}
        </label>
        {folder}
        <label className="admin-field">
          <span className="admin-field-label">Region</span>
          <input className="input mono" value={form.region || ''} onChange={onField('region')} placeholder={storage.region || 'us-east-1'} autoComplete="off" />
          <span className="admin-field-hint">Blank uses the Storage region.</span>
        </label>
        <label className="admin-field">
          <span className="admin-field-label">Role to assume (ARN)</span>
          <input className="input mono" value={form.roleArn || ''} onChange={onField('roleArn')} autoComplete="off" />
          <span className="admin-field-hint">AWS only. The desktop app gets this drive’s credentials by assuming this role.</span>
        </label>
      </div>

      <label className="admin-check">
        <input type="checkbox" checked={ownKeys} onChange={(e) => onOwnKeys(e.target.checked)} />
        <span>
          <span className="admin-field-label">Its own access keys</span>
          <span className="admin-field-hint">For a bucket apart from Storage, on another account or service. Off, it uses the Storage keys.</span>
        </span>
      </label>
      {ownKeys && (
        <div className="admin-form-grid">
          <label className="admin-field">
            <span className="admin-field-label">Access key ID</span>
            <input className="input mono" value={form.accessKeyId || ''} onChange={onField('accessKeyId')} autoComplete="off" />
          </label>
          <label className="admin-field">
            <span className="admin-field-label">Secret access key</span>
            <input
              className="input mono" type="password" value={form.secretAccessKey || ''} onChange={onField('secretAccessKey')}
              placeholder={hasSecret ? '••••••••••••' : ''} autoComplete="new-password"
            />
            <span className="admin-field-hint">
              {hasSecret ? 'A secret is stored. Leave blank to keep it.' : 'Stored on the server and never shown again.'}
            </span>
          </label>
          <label className="admin-field">
            <span className="admin-field-label">Endpoint</span>
            <input className="input mono" value={form.endpoint || ''} onChange={onField('endpoint')} placeholder="https://…" autoComplete="off" />
            <span className="admin-field-hint">For a service other than AWS. Blank for AWS.</span>
          </label>
        </div>
      )}
    </>
  );
}
