import BrandLogo from '@/app/components/BrandLogo';
import { withAccent, brandCssVars, brandDarkCssVars } from '@/lib/brand-config';
import { themeLockScript } from '@/lib/theme';

/**
 * The frame of every page a link opens onto (/s/<token> and what is under
 * it): the brand, and nothing of the app — no nav, nothing a visitor without
 * an account could not use. `narrow` is the card a message or the password
 * form sits in; `wide` gives the page the app's width (a review link's two
 * columns, a folder's grid).
 *
 * `look` is how the link's sharer had the page look (lib/share-kinds.js
 * resolveShareLook), and `view` its layout, which the stylesheet reads from
 * the page's class:
 *
 *   theme    held to light or dark for this page alone (lib/theme.js
 *            themeLockScript), the visitor's own preference untouched
 *   accent   the brand with that accent (withAccent), emitted as the root
 *            layout emits the brand — light and dark — so everything styled
 *            from the custom properties takes it, the glows included
 *   logo     'none' leaves the brand's logo off
 *
 * `intro` is what the sharer wrote for it — { title, message, sender } —
 * shown above the content. Only once the link has let the visitor in: a
 * page that asks for a password, or says the link has expired, is given a
 * look's colours at most, never its words.
 */
export default function Shell({ brand, narrow = false, wide = false, look = null, view = null, intro = null, children }) {
  const lock = themeLockScript(look?.theme);
  const accented = look?.accent ? withAccent(brand, look.accent) : null;
  const words = intro && (intro.title || intro.message || intro.sender) ? intro : null;
  const cls = ['share-page', narrow && 'is-narrow', wide && 'is-wide', view && `is-view-${view}`].filter(Boolean).join(' ');
  return (
    <main className={cls}>
      {lock && <script dangerouslySetInnerHTML={{ __html: lock }} />}
      {accented && (
        // As the root layout's, and sanitized the same way (brandCssVars); a
        // later <style> of the same specificity wins.
        <style
          dangerouslySetInnerHTML={{
            __html: `:root,::backdrop{${brandCssVars(accented)}}:root[data-theme='dark'],[data-theme='dark'] ::backdrop{${brandDarkCssVars(accented)}}`,
          }}
        />
      )}
      {look?.logo !== 'none' && (
        <header className="share-brand">
          <BrandLogo logo={brand.visual.logo} name={brand.name} withName height={22} />
        </header>
      )}
      {words && !narrow && (
        <section className="share-intro" aria-label="From the sender">
          {words.title && <h1 className="share-intro-title">{words.title}</h1>}
          {words.message && <p className="share-intro-message">{words.message}</p>}
          {words.sender && <p className="small muted share-intro-sender">Shared by {words.sender}</p>}
        </section>
      )}
      <div className={narrow ? 'card share-card' : 'share-body'}>{children}</div>
    </main>
  );
}

/**
 * What a page passes Shell as `intro`, from the link's look: the sharer's
 * title and message, and their name when the look says to show it (`sender`,
 * looked up by the caller — a display name, never an address).
 */
export function introFrom(look, sender = null) {
  if (!look) return null;
  return { title: look.title || '', message: look.message || '', sender: look.sender ? sender : null };
}
