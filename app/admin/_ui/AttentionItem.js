import Link from 'next/link';
import Icon from '@/app/components/ui/Icon';

/**
 * One row of "Needs attention" (lib/admin-overview.js attentionItems): what
 * is wrong, in a sentence, and what to do about it. `children` go before
 * the item's link — a fix that can be made there and then, such as
 * ClaimDrives — and an item with no `href` has no link.
 *
 * No hooks, so any section can use it; the Overview's list and the notice
 * on Drives both do.
 */
export default function AttentionItem({ item, children }) {
  const danger = item.tone === 'danger';
  return (
    <li className={`attention-item check is-${danger ? 'fail' : 'warn'}`}>
      <Icon name={danger ? 'circle-x' : 'triangle-alert'} size={18} className="check-glyph" />
      <div className="attention-text">
        <div className="attention-title">
          {item.title}
          <span className="sr-only">{danger ? ' — failing' : ' — warning'}</span>
        </div>
        {item.detail && <div className="attention-detail muted small">{item.detail}</div>}
      </div>
      <div className="attention-actions">
        {children}
        {item.href && <Link href={item.href} className="btn btn-sm">{item.action}</Link>}
      </div>
    </li>
  );
}
