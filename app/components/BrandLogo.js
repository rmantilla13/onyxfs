/**
 * The brand's logo, from the resolved brand (loadBrand → visual.logo).
 *
 * With a wordmark it draws both versions and lets the stylesheet show the
 * one for the current scheme — [data-theme] is set before first paint
 * (lib/theme.js), so neither version flashes — because a wordmark with dark
 * letters vanishes on the dark scheme's near-black. Without one (a
 * deployment that renamed itself: resolveLogo in lib/brand-config.js) it
 * falls back to the square mark, with the name beside it when `withName`.
 *
 * No hooks, so server pages and client components can both render it.
 */
export default function BrandLogo({ logo, name, height = 22, markSize = 24, withName = false, className = '' }) {
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
