# Replace legacy social preview branding

## Scope
Correct only public social/search metadata and its preview artwork. Do not alter application, legal, report, billing, authentication, or database behavior.

## Implementation
1. Create a dedicated 1200×630 Nyrava México social card using the current purple N mark, purple/pink/orange brand palette, and the exact requested Spanish copy at preview-readable sizes.
2. Publish the card as a new immutable asset named `nyrava-mexico-social-2026.png` so no old image cache can be reused.
3. Replace the root server-rendered `og:image` and `twitter:image` defaults, add secure URL/image dimensions and `summary_large_image`, and keep page-specific titles/descriptions and self-referencing URLs intact.
4. Ensure homepage Twitter title/description are present in the initial HTML and remove any legacy social-image URL from public metadata/structured data where applicable.
5. Audit all public route metadata so every shareable page inherits the new card and no page references the old black/blue image.

## Social profile areas
1. Add optional LinkedIn, Discord, X/Twitter, and Facebook URL fields to existing user profiles, preserving current authentication and roles.
2. Add a private Account form so subscribers and admins can save their own social links.
3. Expose only the super admin's explicitly configured links through a narrow public read path. No subscriber profile or links will be publicly listed.
4. Show the super admin social links in the shared footer used by the main public pages.

## Verification
- Confirm the generated image is exactly 1200×630 and visually inspect text/logo legibility.
- Fetch initial HTML for `/`, `/platform`, `/modules`, `/how-it-works`, `/resources`, `/contact`, and the remaining public routes in preview.
- Verify subscriber links remain private and only the super admin public links render in the shared footer.
- Publish the metadata update.
- Fetch `https://mexico.nyrava.com/` after deployment and report exact Open Graph/Twitter values; confirm the old image URL is absent from homepage HTML.
