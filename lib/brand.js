// lib/brand.js — the Onyx defaults.
//
// This is the BASELINE: hand-written, version-controlled, always present. It is
// the shape that lib/brand-config.js layers admin-edited values over, so every
// field here doubles as the fallback when the corresponding admin field is left
// blank. A fresh install with an empty settings table renders exactly this.
//
// Keep it free of secrets and free of runtime lookups — it is imported by
// client components and by the magic-link email renderer, both of which run
// where process.env and the database are not available.

export const BRAND = {
  name: 'Onyx',
  tagline: 'Your files, where you work.',
  description: 'A private file workspace. Browse it on the web, mount it as a drive.',

  // The canonical origin. Used for magic-link emails, share links, the CORS
  // allowlist on the bucket, and the desktop app's default control-plane URL.
  origin: 'https://onyxfs.io',
  supportEmail: 'hi@onyxfs.io',

  visual: {
    palette: {
      // Onyx is a black stone, and the colour is light caught in it: an
      // electric blue that carries every interactive state and blends into a
      // neon magenta, with a cyan for the third note. Admin can override all
      // of these.
      paper: '#FBFBFA', // page background
      ink: '#0C0D0F', // primary text, and the near-black the brand is named for
      muted: '#6B6F76', // secondary text
      line: '#E4E4E2', // hairlines and borders
      accent: '#3D5AFE', // electric blue: links, focus rings, where every gradient starts
      accentDeep: '#2A3ECF', // accent, pressed
      // The aura hues. Decorative — the glows behind the page, gradients,
      // badges — and never body text on paper, which neither is dark enough
      // for. Buttons get a deepened magenta (brandCssVars) so their labels
      // stay legible, and the dark scheme lifts both (darkPalette).
      accentAlt: '#E040FB', // neon magenta
      accentCool: '#22D3EE', // neon cyan
      warning: '#C2410C', // expiring usage rights
      danger: '#B42318', // destructive actions, expired rights
    },
    fonts: {
      // System stacks by default — no webfont request on first paint, and no
      // licensing question for a private deployment. Point `displayUrl` at a
      // hosted face in the admin panel to override the display font.
      display: { family: "'Inter Tight', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", url: null },
      body: { family: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif", url: null },
      mono: { family: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace", url: null },
    },
    logo: {
      // Served from /public. Replace the files rather than the paths so the
      // magic-link email's <img> keeps resolving.
      markPath: '/onyx-mark.png',
      lockupPath: '/onyx-lockup.svg',
    },
    radius: '8px',
  },

  // What the desktop client is called, and the URL scheme it registers. The
  // scheme is baked into the macOS/Windows bundle at build time, so changing it
  // here alone is not enough — it must match `plugins.deep-link.desktop.schemes`
  // in desktop/src-tauri/tauri.conf.json, or browser hand-off breaks silently.
  desktop: {
    productName: 'Onyx',
    scheme: 'onyxfs',
    identifier: 'io.onyxfs.app',
    // Where the app looks for its own updates.
    updateRepo: 'rmantilla13/onyxfs',
    // The folder the mounted drive appears at, under the user's home.
    mountFolder: 'Onyx',
  },
};

export default BRAND;
