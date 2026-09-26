import { createElement } from 'react';
import ICONS from './icon-data';

/**
 * One icon from the Lucide kit (vendor/lucide): a 24-unit outline drawn in
 * `currentColor`, so it takes the colour of the text around it — and with it
 * the brand's colours and dark mode.
 *
 *   <Icon name="search" />              decorative (aria-hidden)
 *   <Icon name="trash" label="Delete" /> meaningful on its own
 *
 * Only icons the app names are bundled: after using a new one, run
 * `npm run icons` (scripts/gen-icons.mjs). A name chosen at run time needs an
 * `icons:` comment listing the candidates so the generator sees them.
 */
export default function Icon({ name, size = 16, strokeWidth = 2, label, className, ...rest }) {
  const shapes = ICONS[name];
  if (!shapes) {
    if (process.env.NODE_ENV !== 'production') console.warn(`<Icon name="${name}">: not in icon-data.js — run \`npm run icons\`.`);
    return null;
  }
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ? `icon ${className}` : 'icon'}
      focusable="false"
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      {...rest}
    >
      {shapes.map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))}
    </svg>
  );
}
