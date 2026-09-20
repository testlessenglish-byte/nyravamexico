# Eliminate mobile horizontal overflow across the public site

## Scope
- Repair the shared public headers instead of masking overflow at the page root.
- Keep branding visible while moving language, sign-in, platform access, and navigation into the mobile drawer.
- Harden public page content so long headings and translated copy can shrink and wrap safely.
- Preserve desktop navigation and all existing destinations and behavior.

## Implementation
1. **Shared mobile navigation**
   - Make the drawer trigger accessible and localized.
   - Put the language selector, Sign In, and Open Platform/Workspace actions inside the drawer on mobile.
   - Ensure the drawer width never exceeds the viewport and its contents can wrap.
2. **Public headers**
   - Update the homepage header and shared `SiteHeader` to use a two-column mobile grid with a shrinkable brand area and fixed hamburger.
   - Hide duplicated desktop actions below the desktop breakpoint.
   - Update `LegalPage` and `DocsLayout` headers to use the same mobile pattern instead of keeping language and sign-in controls in one horizontal row.
3. **Content containment**
   - Add `min-w-0`, safe wrapping, and mobile typography/spacing where public headings, cards, breadcrumb rows, and footer content can exceed narrow viewports.
   - Correct actual overflowing elements only; do not add a global `overflow-x-hidden` workaround.
4. **Verification**
   - Browser-test all public routes at 320, 360, 375, 390, 412, and 430px.
   - Repeat with mobile touch/PWA-style browser context.
   - Verify zero difference between viewport width and document scroll width.
   - Open the menu and confirm navigation, language switching, Sign In, and Open Platform are reachable without horizontal movement.

## Root cause already confirmed
The homepage and shared public header render the language selector, Sign In, Open Platform, and hamburger together in a non-shrinking row beside a non-shrinking brand. `LegalPage` and `DocsLayout` similarly retain language and Sign In beside the wordmark at narrow widths. At 320px this creates document widths from 357px to 726px, depending on the header variant.
