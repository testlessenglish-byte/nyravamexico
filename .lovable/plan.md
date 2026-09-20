# Fix client-card name overflow

## Scope
- Update only the reusable client card presentation.
- Preserve client data, behavior, routing, counts, icons, and the directory width.

## Changes
- Make the card and its header/text columns shrink within the grid cell.
- Keep the person/company icon fixed-size.
- Clamp client names to two lines with wrapping and an ellipsis.
- Constrain the email and expediente columns so their contents cannot widen the card.

## Verification
- Render the requested short, long, and deliberately extreme names.
- Check desktop, tablet, and mobile widths.
- Confirm every card stays within its grid cell and the page has no name-caused horizontal scrollbar.
- Confirm the preview build remains healthy.
