# Add social links to account entry screens

## Changes
- Extract the existing compact, branded LinkedIn, Facebook, X, and Discord links into one reusable display.
- Keep the public footer using that shared display with no personal name shown.
- Add the same compact links beneath the login panel and beneath the plan-selection content.
- Preserve the existing authentication, signup, trial, and billing behavior.

## Verification
- Check both `/auth` and `/choose-plan` at desktop and mobile sizes.
- Confirm links use the configured super-admin URLs, open safely in a new tab, and remain hidden when unavailable.
- Confirm the preview builds without errors.
