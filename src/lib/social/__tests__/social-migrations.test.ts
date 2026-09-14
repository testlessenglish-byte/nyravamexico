import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration=(name: string)=>readFileSync(join(process.cwd(),"supabase","migrations",name),"utf8").replace(/\r\n/g, "\n");
const foundation=migration("20260820230000_social_case_management_foundation.sql");
const workflows=migration("20260820231000_social_case_workflows.sql");
const hardening=migration("20260820232000_social_case_management_hardening.sql");
const billing=migration("20260820233000_billing_provider_controls.sql");
const transactional=migration("20260820234000_social_transactional_workflows.sql");
const firstRun=migration("20260820235000_social_first_run_setup.sql");
const operational=migration("20260820236000_social_operational_completion.sql");
const searchRepair=migration("20260821000000_social_search_index_immutability.sql");
const organizationOnboarding=migration("20260821010000_social_organization_onboarding.sql");
const authorizationRepair=migration("20260821020000_social_authorization_argument_order.sql");
const workflowReliability=migration("20260821030000_social_core_workflow_reliability.sql");
const organizationAccount=migration("20260822143000_social_organization_account.sql");
const subscriptionEntitlements=migration("20260822150000_social_subscription_entitlements.sql");
const caseAssignmentWorkflow=migration("20260822233000_care_case_assignment_workflow.sql");
const managerOnlyCaseCreation=migration("20260824131000_social_manager_only_case_creation.sql");
const caseNumberAllocatorRepair=migration("20260824150000_social_case_number_allocator_repair.sql");
const caseReadbackAccess=migration("20260824184500_social_case_readback_access.sql");
const managerCaseDelete=migration("20260824193000_social_case_manager_delete.sql");
const caseMultifileUploads=migration("20260824203000_social_case_multifile_uploads.sql");
const documentsHubSource=readFileSync(join(process.cwd(),"src","components","social","SocialDocumentsHub.tsx"),"utf8");
const stripeWebhookSource=readFileSync(join(process.cwd(),"src","routes","api","public","hooks","stripe-webhook.ts"),"utf8");
const billingServerSource=readFileSync(join(process.cwd(),"src","lib","billing.functions.ts"),"utf8");
const serverSource=readFileSync(join(process.cwd(),"src","lib","social.functions.ts"),"utf8");
const socialTypesSource=readFileSync(join(process.cwd(),"src","lib","social","types.ts"),"utf8");
const routeSource=readFileSync(join(process.cwd(),"src","routes","_authenticated","social.tsx"),"utf8");
const accountRouteSource=readFileSync(join(process.cwd(),"src","routes","_authenticated","account.tsx"),"utf8");
const accountServerSource=readFileSync(join(process.cwd(),"src","lib","account.functions.ts"),"utf8");
const workspaceSource=readFileSync(join(process.cwd(),"src","components","social","SocialCaseWorkspace.tsx"),"utf8");
const sql=[foundation,workflows,hardening,transactional,firstRun,operational,searchRepair,organizationOnboarding,authorizationRepair,workflowReliability,caseAssignmentWorkflow].join("\n").toLowerCase();

describe("social-care migration security coverage",()=>{
  it.each([
    "social_people","social_families","social_family_members","social_cases",
    "social_case_assignments","social_assessments","social_assessment_versions",
    "social_care_plans","social_care_plan_goals","social_interventions",
    "social_referrals","social_referral_updates","social_consents","social_consent_versions",
    "social_documents","social_document_versions","social_tasks","social_appointments",
    "social_alerts","social_case_transfers","social_case_transfer_items","social_case_closures",
    "social_record_grants","social_activity_events","social_indicator_definitions",
    "social_indicator_snapshots","social_retention_actions","social_support_access_grants",
  ])("creates and protects %s",(table)=>{
    expect(sql).toContain(`create table if not exists public.${table}`);
    const foundationRlsList = foundation.slice(foundation.indexOf("-- RLS: configuration"));
    const protectedByFoundationLoop = foundationRlsList.includes(`'${table}'`);
    const protectedByHardening = hardening.includes(
      `alter table public.${table} enable row level security`,
    );
    expect(protectedByFoundationLoop || protectedByHardening).toBe(true);
  });

  it("uses an explicitly immutable wrapper for the people search index",()=>{
    expect(foundation).toContain("language sql\nimmutable\nparallel safe");
    expect(foundation).toContain("public.social_people_search_document(legal_name,preferred_name,aliases)");
    expect(searchRepair).toContain("drop index if exists public.social_people_search_idx");
    expect(searchRepair).toContain("public.social_people_search_document(legal_name,preferred_name,aliases)");
  });
  it("uses non-reusable immutable case numbering",()=>{
    expect(sql).toContain("social_case_number_counters");
    expect(sql).toContain("prevent_social_case_number_change");
    expect(sql).toContain("lpad(v_next::text,6,'0')");
  });
  it("versions assessments, care plans, consents and documents immutably",()=>{
    for(const table of ["social_assessment_versions","social_care_plan_versions","social_consent_versions","social_document_versions"]){
      expect(workflows).toContain(`'${table}'`);
    }
    expect(workflows).toContain("prevent_social_immutable_mutation");
  });
  it("requires exact recipient, purpose, information and validity for sharing",()=>{
    expect(sql).toContain("social_consent_covers");
    expect(sql).toContain("p_information <@ v.permitted_information");
    expect(workflows).toContain("validate_social_referral_share");
    expect(workflows).toContain("validate_social_document_share");
  });
  it("separates immigration linking and validates a Mexican immigration matter",()=>{
    expect(sql).toContain("social_immigration_links");
    expect(workflows).toContain("validate_social_immigration_link");
    expect(workflows).toContain("case_type");
    expect(workflows).toContain("'migratorio'");
  });
  it("does not treat sent referrals as completed",()=>{
    expect(sql).toContain("result_verified_at");
    expect(workflows).toContain("enforce_social_referral_completion");
  });
  it("keeps closed cases read-only and preserves reopen history",()=>{
    expect(workflows).toContain("protect_closed_social_case");
    expect(workflows).toContain("reopen_social_case");
    expect(sql).toContain("closure_version");
  });
  it("enforces restricted legal, psychosocial, medical and child-protection boundaries",()=>{
    for(const recordType of ["legal_privileged_record","psychosocial_restricted_record","medical_restricted_record","child_protection_restricted_record"]){
      expect(sql).toContain(recordType);
    }
    expect(sql).toContain("social_record_grants");
  });
  it("limits support access by scope, record type and eight-hour expiry",()=>{
    expect(hardening).toContain("social_support_access_grants");
    expect(hardening).toContain("interval '8 hours'");
    expect(hardening).toContain("not p_write and public.social_support_access_active");
  });
  it("uses record-aware private storage and never grants authenticated delete",()=>{
    expect(hardening).toContain("values('social-case-files','social-case-files',false");
    expect(transactional).toContain("(storage.foldername(name))[3]");
    expect(transactional).toContain("public.social_can_access_case");
    expect(sql).not.toMatch(/create policy social_case_files_delete/i);
  });
  it("supports safe multi-file uploads inside a Comprehensive Care case",()=>{
    expect(caseMultifileUploads).toContain("file_size_limit=104857600");
    expect(caseMultifileUploads).toContain("application/x-7z-compressed");
    expect(caseMultifileUploads).toContain("video/x-matroska");
    expect(caseMultifileUploads).toContain("storage.filename(name) ~*");
    expect(caseMultifileUploads).not.toMatch(/\|exe\|/i);
    expect(serverSource).toContain("allowedExtensions=new Set");
    expect(serverSource).toContain("blockedExtensions=new Set");
    expect(workspaceSource).toMatch(/multiple\s+accept=\{CASE_FILE_ACCEPT\}/);
    expect(workspaceSource).toContain("Array.from(e.dataTransfer.files)");
    expect(workspaceSource).toMatch(/sizeBytes\s*:\s*file\.size/);
    expect(workspaceSource).toContain("Uploading ${uploadProgress.current} of ${uploadProgress.total}");
  });
  it("creates family, consent, assessment and care plan atomically",()=>{
    for(const fn of ["create_social_family","create_social_consent","create_social_assessment_initial","create_social_care_plan"]){
      expect(transactional).toContain(`function public.${fn}`);
    }
  });
  it("preserves append-only activity history",()=>{
    expect(sql).toContain("prevent_social_activity_mutation");
    expect(sql).toContain("social_activity_no_update");
  });
  it("suppresses small institutional groups",()=>{
    expect(workflows).toContain("social_indicator_summary");
    expect(sql).toContain("small_group_threshold");
  });
  it("implements guarded referral, transfer, assignment, alert and document transitions",()=>{
    for(const fn of ["assign_social_case_manager","send_social_referral","verify_social_referral_result","advance_social_transfer","accept_social_transfer","register_social_document","refresh_social_case_alerts"]){
      expect(operational).toContain(`function public.${fn}`);
      expect(operational).toContain(`revoke all on function public.${fn}`);
    }
  });
  it("wires every operational case stage into the case workspace",()=>{
    for(const tab of ["assessment","plan","intervention","consent","referral","tasks","documents","transfer","closure","immigration","activity"]){
      expect(workspaceSource).toMatch(new RegExp(`tab\\s*===\\s*"${tab}"`));
    }
    expect(routeSource).toContain("SocialCaseWorkspace");
    expect(routeSource).toContain("onOpen={setSelectedCaseId}");
  });
  it("provides working family, alert, indicator, activity and Account team administration screens",()=>{
    for(const marker of ["createSocialFamily","getSocialIndicators","acknowledgeSocialAlert"]){
      expect(routeSource).toContain(marker);
    }
    for(const marker of ["inviteSocialOrganizationMember","updateSocialOrganizationMember","OrganizationTeamCard"]){
      expect(accountRouteSource).toContain(marker);
    }
  });
  it("exposes consent-checked sharing and ethical-screen access grants",()=>{
    expect(serverSource).toContain("export const shareSocialDocument");
    expect(serverSource).toContain("export const grantSocialRecordAccess");
    expect(workspaceSource).toContain("Selective sharing");
    expect(workspaceSource).toContain("Ethical-screen record access");
  });
  it("keeps audit logging safe for INSERT, UPDATE and DELETE",()=>{
    expect(workflowReliability).toContain("if tg_op='DELETE' then v_row:=to_jsonb(old)");
    expect(workflowReliability).toContain("else v_row:=to_jsonb(new)");
    expect(workflowReliability).not.toContain("coalesce(new.org_id,old.org_id)");
  });
  it("creates clients and assigned cases through authorized transactions",()=>{
    for(const fn of ["create_social_person","create_social_family"]){
      expect(workflowReliability).toContain(`function public.${fn}`);
    }
    expect(caseAssignmentWorkflow).toContain("function public.create_and_assign_care_case");
    expect(caseAssignmentWorkflow).toContain("insert into public.social_case_assignments");
    expect(caseAssignmentWorkflow).toContain("insert into public.social_case_status_history");
    expect(caseAssignmentWorkflow).toContain("insert into public.social_alerts");
    expect(caseAssignmentWorkflow).toContain("insert into public.social_tasks");
    expect(caseAssignmentWorkflow).toContain("revoke all on function public.create_social_case");
    expect(serverSource).toContain('.rpc("create_social_person"');
    expect(serverSource).toContain('.rpc("create_and_assign_care_case"');
    expect(serverSource).not.toContain('.rpc("create_social_case"');
    expect(serverSource).not.toMatch(/from\("social_cases"\)\.insert/);
  });
  it("uses direct active memberships and canonical document organizations",()=>{
    expect(workflowReliability).toContain("from public.org_memberships m");
    expect(workflowReliability).toContain("m.status='active'");
    expect(workflowReliability).toContain("c.org_id=((storage.foldername(name))[1])::uuid");
    expect(serverSource).toContain('.select("org_id").eq("id",data.socialCaseId).single()');
  });
  it("matches the five-argument institutional indicator RPC",()=>{
    expect(workflowReliability).toContain("p_org uuid,p_from date,p_to date,p_program uuid,p_office uuid");
    expect(serverSource).toContain("p_program:data.programId??null,p_office:data.officeId??null");
  });
  it("surfaces actionable Social errors and an empty-workspace creation path",()=>{
    expect(routeSource).toContain("function errorMessage");
    expect(routeSource).toContain("Register New Case");
    expect(routeSource).toContain("Open and Assign Case");
    expect(routeSource).not.toContain("Start by registering the first person");
  });
  it("repairs Social authorization argument order without email-specific access",()=>{
    expect(authorizationRepair).toContain("public.is_org_member(p_user,p_org)");
    expect(authorizationRepair).toContain("public.can_manage_org(p_user,p_org)");
    expect(authorizationRepair).toContain("public.social_is_platform_admin(p_user)");
    expect(authorizationRepair).toContain("alter policy social_people_create");
    expect(authorizationRepair).toContain("begin;");
    expect(authorizationRepair).toContain("commit;");
    expect(authorizationRepair).not.toContain("create policy social_programs_read");
    expect(authorizationRepair).toContain("public.social_is_org_member(org_id,auth.uid())");
    expect(authorizationRepair).toContain("public.social_can_manage_org(org_id,auth.uid())");
    expect(authorizationRepair).not.toMatch(/[\w.+-]+@[\w.-]+/);
    expect(authorizationRepair).not.toContain("social_family_members_access");
    expect(authorizationRepair).not.toContain("social_consents_access");
  });
  it("creates the organization from Account before Social intake",()=>{
    expect(accountRouteSource).toContain("Firm / law firm / organization");
    expect(accountServerSource).toContain('"create_account_organization"');
    expect(accountServerSource).toContain('.from("org_memberships")');
    expect(organizationOnboarding).toContain("function public.create_account_organization");
    expect(organizationOnboarding).toContain("'organization_owner'");
    expect(organizationOnboarding).toContain("'Atención Integral'");
    expect(accountServerSource).toContain("Profile completion is the organization onboarding boundary");
    expect(routeSource).not.toContain('to="/account"');
    expect(routeSource).not.toContain("createOrganization({name,slug:");
  });
  it("uses one organization subscription for employee seats and assignment-scoped work",()=>{
    expect(organizationAccount).toContain("create table if not exists public.organization_invitations");
    expect(organizationAccount).toContain("public.org_subscriptions");
    expect(organizationAccount).toContain("public.billing_plans");
    expect(organizationAccount).toContain("Organization seat limit reached");
    expect(organizationAccount).toContain("update public.social_case_assignments set active=false,ended_at=now()");
    expect(organizationAccount).toContain("update public.social_role_assignments set active=false,ends_at=now()");
    expect(organizationAccount).toContain("public.social_org_role_to_care_role");
    expect(organizationAccount).not.toContain("create table if not exists public.organizations");
    expect(organizationAccount).not.toContain("create table if not exists public.firms");
    expect(accountRouteSource).toContain("OrganizationTeamCard");
    expect(accountRouteSource).toContain("Invite team member");
    expect(routeSource).not.toContain("OrganizationSeatAdmin");
    expect(routeSource).toContain("TeamActivity");
    expect(workspaceSource).toContain("organizationMembers");
  });
  it("supports assignment visibility and emergency acknowledgement without requiring a linked family",()=>{
    expect(socialTypesSource).not.toContain("A family record is required for a family case");
    expect(serverSource).toContain("due_at,assigned_to,acknowledged_at");
    expect(routeSource).toContain("Assigned emergency case. Immediate attention and acknowledgement are required.");
    expect(routeSource).toContain('"Assigned cases"');
    expect(caseAssignmentWorkflow).toContain("'new_case_assignment'");
    expect(caseAssignmentWorkflow).toContain("'emergency_case_supervision'");
    expect(caseAssignmentWorkflow).toContain("coalesce(p_assigned_user,v_actor)");
  });
  it("limits case creation and assignment controls to organization managers",()=>{
    expect(managerOnlyCaseCreation).toContain("public.social_can_manage_org(new.org_id,auth.uid())");
    expect(managerOnlyCaseCreation).toContain("social_cases_manager_only_insert");
    expect(routeSource).toContain("canManageOrganization");
    expect(routeSource).toContain("availableOrganizations");
    expect(routeSource).toContain("canCreateCases={canManageOrganization}");
    expect(documentsHubSource).toContain("This is a team-member account");
  });
  it("allocates collision-proof case numbers and paginates organization cases",()=>{
    expect(caseNumberAllocatorRepair).toContain("pg_advisory_xact_lock");
    expect(caseNumberAllocatorRepair).toContain("hashtext(new.org_id::text||':'||v_prefix||':'||v_year::text)");
    expect(caseNumberAllocatorRepair).toContain("exit when not exists");
    expect(caseNumberAllocatorRepair).toContain("c.case_number=v_candidate");
    expect(caseNumberAllocatorRepair).toContain("greatest(");
    expect(caseNumberAllocatorRepair).not.toContain("legal_name");
    expect(caseNumberAllocatorRepair).not.toContain("case_type");
    expect(routeSource).toContain("caseListQuery");
    expect(routeSource).toContain("dashboardCasePage");
    expect(routeSource).toContain("Math.ceil(dashboardCases.length/10)");
    expect(routeSource).toContain("Search by name or case number");
    expect(routeSource).toContain("members={organizationMembers}");
    expect(routeSource).toContain('es?"Asignado a":"Assigned to"');
    expect(routeSource).toContain("m.user_id===c.assigned_case_manager");
    expect(routeSource).toContain('es?"Sin asignar":"Unassigned"');
  });
  it("allows only the assigning manager to soft-delete a case",()=>{
    expect(managerCaseDelete).toContain("delete_social_case_by_assigning_manager");
    expect(managerCaseDelete).toContain("v_case.created_by is distinct from v_actor");
    expect(managerCaseDelete).toContain("v_case.supervising_manager is distinct from v_actor");
    expect(managerCaseDelete).not.toContain("v_case.assigned_case_manager = v_actor");
    expect(managerCaseDelete).toContain("set deleted_at=now()");
    expect(managerCaseDelete).toContain("'case_deleted'");
    expect(serverSource).toContain("export const deleteSocialCase=");
    expect(workspaceSource).toMatch(/es\s*\?\s*"Eliminar caso"\s*:\s*"Delete case"/);
    expect(routeSource).toContain("currentUserId={currentUserId}");
  });
  it("reads a created case through the authorized core RPC",()=>{
    expect(caseReadbackAccess).toContain("create or replace function public.get_social_case_core");
    expect(caseReadbackAccess).toContain("assigned_case_manager = p_user");
    expect(caseReadbackAccess).toContain("supervising_manager = p_user");
    expect(caseReadbackAccess).toContain("social_cases_direct_participant_read");
    expect(serverSource).toContain('supabase.rpc("get_social_case_core",{p_case:data.caseId})');
  });
  it("opens the core case even when an optional workspace section fails",()=>{
    expect(serverSource).toContain('fail(caseRow.error)');
    expect(serverSource).toContain('const optionalRows=');
    expect(serverSource).toContain('warnings.push');
    expect(workspaceSource).toMatch(/retry\s*:\s*1/);
    expect(workspaceSource).toContain('Case could not be opened');
    expect(workspaceSource).toContain("detail.refetch()");
    expect(workspaceSource).not.toContain('if(detail.isLoading||!caseData||!c)');
  });
  it("keeps employee passwords outside manager-controlled data",()=>{
    expect(organizationAccount).not.toMatch(/password|credential/i);
    expect(organizationAccount).toContain("Invitation email does not match the signed-in account");
    expect(organizationAccount).toContain("extensions.digest(p_token,'sha256')");
  });
  it("keeps the Stripe billing provider control in place",()=>{
    expect(billing).toContain("'stripe'");
    expect(billing).toContain("prevent_disabling_all_billing_providers");
    expect(billing).toContain("billing_provider_events");
  });
  it("defines Basic as one owner plus three employee seats without counting clients",()=>{
    expect(subscriptionEntitlements).toContain("owner_seats=1");
    expect(subscriptionEntitlements).toContain("employee_seats=3");
    expect(subscriptionEntitlements).toContain("total_user_limit=4");
    expect(subscriptionEntitlements).toContain("'client_records_consume_seats',false");
    expect(subscriptionEntitlements).toContain("role_in_org::text<>'owner'");
    expect(subscriptionEntitlements).toContain("organization_invitations_require_subscription");
  });
  it("uses one provider-neutral and idempotent entitlement materialization path",()=>{
    for(const marker of [
      "organization_entitlements","organization_usage_periods",
      "organization_usage_events","billing_webhook_events",
      "provision_organization_subscription_from_webhook",
      "unique(provider,provider_event_id)",
    ]) expect(subscriptionEntitlements).toContain(marker);
    expect(subscriptionEntitlements).toContain("on conflict(provider,provider_event_id) do nothing");
    expect(subscriptionEntitlements).not.toContain("create table if not exists public.organizations");
  });
  it("activates organization access only after verified Stripe webhooks",()=>{
    expect(stripeWebhookSource.indexOf("constructEvent")).toBeLessThan(
      stripeWebhookSource.indexOf("provisionOrganizationSubscription(admin"),
    );
    for(const source of [stripeWebhookSource]){
      expect(source).toContain('"provision_organization_subscription_from_webhook"');
      expect(source).toContain("p_payload_hash");
    }
    expect(billingServerSource).toContain("billing_provider_settings");
    expect(billingServerSource).toContain("org_id: organizationId");
  });
});
