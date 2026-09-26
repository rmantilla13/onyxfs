import RouteDrawer from '../../_ui/RouteDrawer';

/** The drawer's frame at once, its contents as they load. */
export default function Loading() {
  return (
    <RouteDrawer back="/admin/drives" title="Loading…">
      <div className="admin-skeleton drawer-pad" role="status" aria-live="polite">
        <span className="sr-only">Loading the drive…</span>
        {Array.from({ length: 6 }, (_, i) => <span key={i} className="skel skel-row" aria-hidden />)}
      </div>
    </RouteDrawer>
  );
}
