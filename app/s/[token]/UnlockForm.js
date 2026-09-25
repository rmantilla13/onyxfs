'use client';

// useFormState (react-dom), not useActionState (react) — this is React 18.
import { useFormState, useFormStatus } from 'react-dom';
import { unlockShare } from './actions';

export default function UnlockForm({ token, locked = false }) {
  const [state, submit] = useFormState(unlockShare, {});
  return (
    <form action={submit} className="stack" style={{ gap: 'var(--s2)' }}>
      <input type="hidden" name="token" value={token} />
      <input
        className="input"
        type="password"
        name="password"
        placeholder="Password"
        aria-label="Password"
        autoComplete="off"
        required
        autoFocus
      />
      <Submit />
      {(state.error || locked) && (
        <p className="small" role="alert" style={{ margin: 0, color: 'var(--danger)' }}>
          {state.error || 'Too many wrong passwords. Try again in a few minutes.'}
        </p>
      )}
    </form>
  );
}

// useFormStatus only reports on a form it is rendered inside.
function Submit() {
  const { pending } = useFormStatus();
  return (
    <button className="btn btn-primary" type="submit" disabled={pending} style={{ justifyContent: 'center' }}>
      {pending ? 'Checking…' : 'Open'}
    </button>
  );
}
