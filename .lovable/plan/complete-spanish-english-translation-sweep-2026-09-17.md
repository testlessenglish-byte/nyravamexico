# Complete Spanish / English translation sweep

## Goal
Every visible interface string follows the selected language across pages, dialogs, menus, notifications, empty states, errors, and shared navigation. User-entered names, case facts, document titles, and stored records remain unchanged.

## Batch 1 — Trust and documentation experience
1. Translate the complete Trust Center shown in the screenshot: headings, body copy, cards, table of contents, FAQs, links, and accessibility labels.
2. Translate the shared documentation search dialog, including search results, empty state, keyboard guidance, and result count.
3. Translate the shared pipeline diagram and documentation navigation labels so these do not remain English on other documentation pages.
4. Add matching Spanish and English dictionary keys and a focused parity test.
5. Verify the Trust Center and search dialog in both languages on desktop and mobile, then pause for a spot-check.

## Following batches
- Batch 2: remaining Help and Learning Center pages and their dialogs.
- Batch 3: remaining public Trust, policy, company, and resource pages.
- Batch 4: signed-in navigation, account/settings menus, alerts, toasts, and common dialogs.
- Batch 5: case, evidence, report, and administration screens not already localized.
- Final pass: automated hard-coded-string scan, locale-key parity checks, and browser spot-checks of every route family.

## Guardrails
- Localization only; no redesign or legal/report/database/auth/billing behavior changes.
- Keep Spanish as the default language.
- Never translate client-entered or stored case data.
- Do not modify protected legal-content files.
- Ship 2–3 screens per batch and pause after each batch for review.

## Technical notes
- Use the existing local JSON dictionaries and `useI18n()` pattern.
- Keep Spanish and English keys identical and test parity.
- Shared components receive translated strings from the active locale rather than duplicating page-specific logic.
