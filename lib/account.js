// lib/account.js — how the signed-in account is shown (the avatar in TopNav).

/** "ricky.mantilla@…" → "RM", "hi@…" → "H", nothing → "?". */
export function initialsFor(email) {
  const local = String(email || '').split('@')[0];
  const parts = local.split(/[._\-+]+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : (parts[0] || '?')[0]).toUpperCase();
}
