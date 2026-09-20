// Single source of truth for the app version. Surfaced in the admin panel and
// in /api/health, and reported to the desktop client so it can tell whether
// the control plane it is talking to is newer than the app.
export const VERSION = '0.1.0';
export default VERSION;
