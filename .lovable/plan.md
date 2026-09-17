# Make footer social links more noticeable

## Scope
Update only the public footer’s social-link presentation. Keep the existing destinations, privacy rules, and super-admin-only public display unchanged.

## Implementation
1. Add semantic brand-color tokens for LinkedIn, Facebook, X, and Discord.
2. Restyle each footer link with its network color, stronger contrast, larger click target, and a visible network label where space permits.
3. Preserve accessible names, keyboard focus, external-link behavior, and responsive wrapping.

## Verification
- Check the footer at desktop and mobile widths.
- Confirm each icon and label uses the correct network color and all links remain clickable.
- Confirm the preview build remains healthy.
