/**
 * A list of checks — storage diagnostics, a drive's diagnostics, Health.
 * Each row is a glyph, a label, what was found and, when it is wrong, what
 * to do about it. The glyph is decoration; the status is also in words for
 * a screen reader, since a coloured mark says nothing on its own.
 *
 *   checks: [{ id, label, status: pass|warn|fail|off|info, detail?, fix? }]
 */
const GLYPH = { pass: '✓', warn: '!', fail: '✗', off: '–', info: 'i' };
const WORD = { pass: 'passed', warn: 'warning', fail: 'failed', off: 'not set up', info: 'information' };

export default function CheckList({ checks = [], label }) {
  return (
    <ul className="checklist" aria-label={label}>
      {checks.map((c) => {
        const status = GLYPH[c.status] ? c.status : 'info';
        return (
          <li key={c.id || c.label} className={`check is-${status}`}>
            <span className="check-glyph" aria-hidden>{GLYPH[status]}</span>
            <div className="check-text">
              <div className="check-label">
                {c.label}
                <span className="sr-only">{` — ${WORD[status]}`}</span>
              </div>
              {c.detail && <div className="check-detail muted small">{c.detail}</div>}
              {c.fix && <div className="check-fix small">{c.fix}</div>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
