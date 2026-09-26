'use client';

/**
 * The file page's layout, on its own so that the opening shell (FileOpening)
 * draws exactly the same geometry as the page it stands in for: the header
 * row (← Back and the name), then the stage column beside the 360px
 * inspector. If the two ever differed, the picture would jump as the page
 * replaced the shell.
 *
 * `as` is 'div' for the shell, which is drawn inside the files page's own
 * <main>.
 */
export default function FileDetailFrame({ as: Tag = 'main', className = '', header, stage, aside, children, ...rest }) {
  return (
    <Tag className={`shell file-detail ${className}`.trim()} style={{ padding: 'var(--s5) var(--s5) 64px' }} {...rest}>
      <div className="row" style={{ marginBottom: 'var(--s4)' }}>{header}</div>
      <div className="file-detail-body">
        <div style={{ minWidth: 0 }}>{stage}</div>
        <aside style={{ minWidth: 0 }}>{aside}</aside>
      </div>
      {children}
    </Tag>
  );
}
