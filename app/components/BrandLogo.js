import OnyxWordmark from '@/app/components/OnyxWordmark';

/**
 * The brand's logo, from the resolved brand (loadBrand → visual.logo).
 *
 * Our own wordmark is drawn inline (OnyxWordmark): its letters follow the
 * theme and its "/FS" moves through the platform's colours.
 *
 * A white-label deployment's own wordmark is an image, in both its versions,
 * and the stylesheet shows the one for the current scheme — [data-theme] is
 * set before first paint (lib/theme.js), so neither flashes — because dark
 * letters vanish on the dark scheme's near-black. With no wordmark at all (a
 * deployment that renamed itself: resolveLogo in lib/brand-config.js) it is
 * the square mark, with the name beside it when `withName`.
 *
 * No hooks, so server pages and client components can both render it.
 */
export default function BrandLogo({ logo, name, height = 22, markSize = 24, withName = false, className = '' }) {
  if (logo?.onyxWordmark) {
    return (
      <span className={`brand-logo ${className}`.trim()}>
        <OnyxWordmark height={height} name={name} />
      </span>
    );
  }
  if (logo?.lockupPath) {
    return (
      <span className={`brand-logo ${className}`.trim()} role="img" aria-label={name}>
        <img src={logo.lockupPath} alt="" height={height} className="brand-logo-light" />
        <img src={logo.lockupDarkPath || logo.lockupPath} alt="" height={height} className="brand-logo-dark" />
      </span>
    );
  }
  return (
    <span className={`brand-logo ${className}`.trim()}>
      <img
        src={logo?.markPath}
        alt={withName ? '' : name}
        width={markSize}
        height={markSize}
        style={{ borderRadius: Math.round(markSize / 4) }}
      />
      {withName && <strong className="brand-logo-name">{name}</strong>}
    </span>
  );
}
