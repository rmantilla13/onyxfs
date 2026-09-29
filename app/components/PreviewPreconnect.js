import * as ReactDOM from 'react-dom';
import { pictureOrigins } from '@/lib/renditions';

/**
 * Opens the connections a page's pictures need before the page asks for
 * them. Without it the first thumbnail waits on DNS, TCP and TLS to the
 * bucket before a byte of it moves — and B2 speaks HTTP/1.1, so every
 * connection a browser opens to it pays that.
 *
 * `urls` are the pictures the page draws first, already signed; only their
 * origins are used (lib/renditions.js pictureOrigins), so no signature ends
 * up in the head. Two connections to each, because a browser keeps two
 * pools: an <img> without `crossorigin` asks with credentials, and the
 * preview worker (public/thumb-sw.js) asks again with CORS and none, which
 * takes a connection from the other. A dns-prefetch too, for a browser that
 * does not preconnect.
 *
 * React turns these into Link headers or <link> tags at the top of the head.
 * A server component; renders nothing.
 */
export default function PreviewPreconnect({ urls }) {
  for (const origin of pictureOrigins(urls)) {
    ReactDOM.prefetchDNS?.(origin);
    ReactDOM.preconnect?.(origin);
    ReactDOM.preconnect?.(origin, { crossOrigin: 'anonymous' });
  }
  return null;
}
