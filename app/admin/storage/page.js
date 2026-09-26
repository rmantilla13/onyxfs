import { requireAdminPage } from '../_lib/guard';
import BackendClient from './BackendClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Backend · Admin' };

/**
 * Admin → Storage → Backend. The form loads its settings from
 * /api/admin/storage itself, so a slow or failed read is an error with
 * Retry on the page, never an empty form that invites overwriting a
 * working bucket. Admins for now; super-admins only with Phase 1.
 */
export default async function BackendPage() {
  await requireAdminPage('/admin/storage');
  return <BackendClient />;
}
