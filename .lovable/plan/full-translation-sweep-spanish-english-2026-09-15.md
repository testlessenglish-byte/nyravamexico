# Full translation sweep (Spanish / English)

Goal: with Spanish selected, every visible string is Spanish — pages, tabs, buttons, dialogs, dropdowns, toasts, empty states, error messages — and the same in English.

## What I found

A scan of the app's screens found about 316 hard-coded English phrases spread over 64 screens and panels. They never pass through the translation dictionary, so switching language leaves them in English.

Separately, the screenshot shows a second, different problem: the "Última intervención registrada" card prints stored assistant output raw — `**riesgo_de_revisión**`, `GAPS DETERMINISTAS:` — so asterisks and underscore keys show up as-is. That text is saved data, so it will not be rewritten; it will be cleaned up at display time only.

## Batch 1 (this pass)

1. Display cleanup for stored assistant text: strip markdown asterisks, turn `underscore_keys` into readable words, and translate the structural headings (gaps / next steps / case fact) into the selected language at render time. Stored records are untouched.
2. Translate the Comprehensive Care case workspace (all tabs, panels, buttons, empty states) — the screen in the screenshot.
3. Translate the case detail screen (`cases.$caseId`), the largest single source of English.

Then pause so you can spot-check both screens in Spanish and English.

## Later batches (2-3 screens each, same pattern)

- Batch 2: Messages, Alerts & Notes, Settings, account menus
- Batch 3: Reports / Legal memorandum / pipeline panels
- Batch 4: Public pages (Trust, Confidentiality, Responsible AI, Accessibility, Learning Center, Roadmap)
- Batch 5: Admin screens (team, users, beta, AI providers, legal knowledge, health)

## Technical notes

- New strings go into `src/i18n/locales/es.json` and `en.json` with matching keys; components read them via `useI18n()`. Files that already use the local `es ? "…" : "…."` pattern keep that pattern where converting them would be a rewrite rather than a translation.
- The stored-text cleanup lives in `CaseDynamicText` (presentation layer only) plus a small normalizer helper; no server, database, or assistant-prompt changes.
- Client-entered data (names, notes, document titles, case numbers) is never translated.
