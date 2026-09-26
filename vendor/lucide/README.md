# Lucide icons

The icon kit the web workspace and the Mac app draw from: Lucide
(lucide-static v1.48.0), 454 icons curated into `sprite.svg`, with `icons.json`
listing each icon's category and the older names it replaced (`filter` is
`funnel`, `unlock` is `lock-open`, …). Licence: `LICENSE` (ISC; some icons MIT).

Nothing here is served. `npm run icons` (scripts/gen-icons.mjs) copies the
icons the code names into `app/components/ui/icon-data.js` (for `<Icon>`) and
`apple/OnyxMac/LucideData.swift` (for `Image(lucide:)`). To use an icon, name
it in code and run that; `npm test` fails while either file is stale.
