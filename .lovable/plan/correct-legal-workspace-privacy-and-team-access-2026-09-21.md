# Correct Legal Workspace Privacy and Team Access

## Root cause

The current system has several competing authorization models instead of one case-access rule:

- `clients` grants every active organization member access to every client in that organization, and the New Case client query relies entirely on that broad rule. This is the client-list leak shown in the screenshot.
- `cases` still has a separate firm-admin/same-firm read rule, while reports, report versions, and canonical analyses retain same-firm access.
- the privileged global search function explicitly includes platform admins, all firm members, and all organization clients, bypassing the corrected personal case list.
- the private `case-files` storage bucket still gives platform admins direct read/delete access.
- `/cases` and direct case loading were recently narrowed to `cases.user_id`, which blocks the admin leak there but is only a partial workaround: it cannot grant a team owner access to worker-created cases or grant a worker access to an assigned case.
- the standard legal-case domain has no canonical assignment/share table. The existing assignment table belongs to the separate social-care domain and cannot safely authorize legal cases.
- tenant identity is split between `firms`, `organizations`, client `org_id`, case `firm_id`, and creator `user_id`. All 7 current legal cases have an owner but no firm; linked clients provide a deterministic organization for 5 cases, while 2 admin-owned cases have no client/workspace link and must remain owner-private.

## Build

1. **Create the canonical legal authorization layer**
   - Use the existing `organizations` and active `org_memberships` as the customer workspace boundary.
   - Add a nullable organization link to legal cases for team work; an absent organization means an individual/private case.
   - Add a legal case assignment table with active/revoked state and `view`, `contribute`, and `manage` permission levels.
   - Add centralized, fail-closed database helpers for case read/write/manage access. They will authorize only the case owner, that case's workspace owner, or an active explicitly assigned member with sufficient permission. Platform roles will not participate.
   - Ensure revoking an assignment immediately removes access. Do not add an emergency support bypass.

2. **Reconcile existing data without destructive ownership changes**
   - Preserve every existing `user_id`, case, client, document, and report.
   - Backfill a case workspace only when the relationship is deterministic from its linked client's organization and the case owner is an active member there.
   - Leave ambiguous or clientless cases private to their current owner and produce an audit query/report for anything unresolved.
   - Do not create worker assignments implicitly from organization membership.

3. **Replace all legal-content access rules**
   - Make `cases` use the centralized rule for reads and permission-aware writes.
   - Convert all case-derived tables—documents, evidence, reports and versions, analyses, findings, scores, execution/pipeline records, timelines, parties, communications, tasks, strategies, work products, and generated artifacts—to derive access from their parent case, not copied `user_id`, admin role, or broad firm membership.
   - Make client/CRM reads visible only to the client owner, the workspace owner, or a worker through an accessible linked case. Keep client mutation restricted to its owner/workspace owner unless a deliberate client-level permission exists.
   - Remove platform-admin and broad organization/firm shortcuts from confidential CRM activity.

4. **Close non-table bypasses**
   - Rewrite global search to use the centralized case/client authorization and remove caller-supplied identity and admin bypasses.
   - Audit every callable RPC, server function, public endpoint, background worker, and service-role query touching legal work; require a verified user plus centralized authorization before privileged content access.
   - Replace `case-files` storage rules with case-derived authorization for read/write/delete, including direct object paths and signed-download creation. Keep unrelated demo/admin storage unchanged.
   - Update dashboards, recent cases, alerts, client selectors, downloads, and direct-ID loaders to consume authorized resources rather than owner-only or organization-wide filters.

5. **Add team workflows**
   - Let a workspace owner view all workspace cases and explicitly assign/revoke workers per case with a permission level.
   - Let workers list and open only assigned cases. A worker-created case belongs to its selected workspace so the workspace owner can access it; it does not become visible to other members automatically.
   - Keep platform administration limited to account, subscription, billing, seat, system, and non-content audit metadata.

6. **Verify exact privacy boundaries**
   - Add database regression tests for Individual A/B isolation, platform-admin denial, Team Owner access, Worker 1/Worker 2 assignment isolation, cross-team denial, direct UUID access, client derivation, storage paths, and immediate revocation.
   - Run the same identities through direct browser/API requests and the UI: case lists, New Case client dropdown, direct case URL, search, reports, document download, dashboard/recent items, and assignment removal.
   - Test attempted caller-supplied owner/workspace IDs and confirm they cannot change ownership or access.
   - Run focused tests, typecheck, build, and the database security linter; report new versus pre-existing findings separately.

## Technical details

- New public tables will include explicit grants followed by RLS policies in the same migration.
- Authorization helpers will validate `auth.uid()` and active membership internally, run with a fixed search path, and not be directly executable as data-returning APIs.
- Parent-case authorization will be the single policy source; copied child-row owner IDs will remain provenance fields, not independent access grants.
- Database policies remain the enforcement boundary. Server-side checks add clearer errors but never replace RLS.
- Existing social-care authorization remains separate and unchanged unless an audit finds a direct bridge into standard legal-case data.

## Not included

- No deletion or blind reassignment of existing customer data.
- No hidden platform-admin or support access to confidential content.
- No emergency support-access mechanism. A future mechanism would require separate customer consent, expiry, narrow scope, and immutable audit logging.