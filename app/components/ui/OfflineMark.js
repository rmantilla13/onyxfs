import Icon from '@/app/components/ui/Icon';

/**
 * A file, folder or drive Onyx for Mac keeps offline (lib/offline-marks.js):
 * a tick in a circle after its name, where Finder puts its own sync marks
 * and other cloud drives put "available offline". Only ever drawn inside the
 * Mac app, which is the only place anything is kept. `title` says what keeps
 * it when that is not the item itself ("Kept offline with “Footage”").
 */
export default function OfflineMark({ title = 'Kept offline on this Mac', size = 14 }) {
  return (
    <span className="offline-mark" title={title} role="img" aria-label={title}>
      <Icon name="circle-check" size={size} strokeWidth={2.25} />
    </span>
  );
}
