import BrandLogo from '@/app/components/BrandLogo';

/**
 * The frame of every page a link opens onto (/s/<token> and what is under
 * it): the brand, and nothing of the app — no nav, nothing a visitor without
 * an account could not use. `narrow` is the card a message or the password
 * form sits in; `wide` gives the page the app's width (a review link's two
 * columns, a folder's grid).
 */
export default function Shell({ brand, narrow = false, wide = false, children }) {
  return (
    <main className={`share-page${narrow ? ' is-narrow' : ''}${wide ? ' is-wide' : ''}`}>
      <header className="share-brand">
        <BrandLogo logo={brand.visual.logo} name={brand.name} withName height={22} />
      </header>
      <div className={narrow ? 'card share-card' : 'share-body'}>{children}</div>
    </main>
  );
}
