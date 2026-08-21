import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration=(name:string)=>readFileSync(join(process.cwd(),"supabase","migrations",name),"utf8");
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
const apiSecurity=migration("20260821040000_public_api_security_hardening.sql");
const serverSource=readFileSync(join(process.cwd(),"src","lib","social.functions.ts"),"utf8");
const routeSource=readFileSync(join(process.cwd(),"src","routes","_authenticated","social.tsx"),"utf8");
const accountRouteSource=readFileSync(join(process.cwd(),"src","routes","_authenticated","account.tsx"),"utf8");
const accountServerSource=readFileSync(join(process.cwd(),"src","lib","account.functions.ts"),"utf8");
const workspaceSource=readFileSync(join(process.cwd(),"src","components","social","SocialCaseWorkspace.tsx"),"utf8");
const sql=[foundation,workflows,hardening,transactional,firstRun,operational,searchRepair,organizationOnboarding,authorizationRepair,workflowReliability,apiSecurity].join("\n").toLowerCase();

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
      expect(workspaceSource).toContain(`tab==="${tab}"`);
    }
    expect(routeSource).toContain("SocialCaseWorkspace");
    expect(routeSource).toContain("onOpen={setSelectedCaseId}");
  });
  it("provides working family, alert, indicator, activity and role administration screens",()=>{
    for(const marker of ["createSocialFamily","getSocialIndicators","acknowledgeSocialAlert","upsertSocialRoleAssignment"]){
      expect(routeSource).toContain(marker);
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
  it("creates people, families and cases through explicitly authorized transactions",()=>{
    for(const fn of ["create_social_person","create_social_family","create_social_case"]){
      expect(workflowReliability).toContain(`function public.${fn}`);
    }
    expect(workflowReliability).toContain("security definer");
    expect(serverSource).toContain('.rpc("create_social_person"');
    expect(serverSource).toContain('.rpc("create_social_case"');
    expect(serverSource).not.toMatch(/from\("social_people"\)\.insert/);
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
    expect(routeSource).toContain("Start by registering the first person");
    expect(routeSource).toContain("No people registered yet");
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
    expect(routeSource).toContain('to="/account"');
    expect(routeSource).not.toContain("createOrganization({name,slug:");
  });
  it("closes all seven public API security findings without user-specific bypasses",()=>{
    expect(apiSecurity).toContain("alter table public.social_role_capabilities enable row level security");
    expect(apiSecurity).toContain("revoke all on table public.social_role_capabilities from public, anon, authenticated");
    expect(apiSecurity).toContain("drop policy if exists plan_ent_read_authenticated");
    expect(apiSecurity).toContain("revoke all on table public.plan_entitlements from public, anon, authenticated");
    expect(apiSecurity).toContain('drop policy if exists "Anyone can view active plans"');
    expect(apiSecurity).toContain("revoke all on table public.billing_plans from public, anon");
    expect(apiSecurity).toContain("alter table public.profiles enable row level security");
    expect(apiSecurity).toContain("for select to authenticated using (id=auth.uid())");
    expect(apiSecurity).toContain("where n.nspname='public' and p.prosecdef");
    expect(apiSecurity).toContain("revoke execute on function %s from public, anon");
    expect(apiSecurity).toContain("alter function %s set search_path = public, extensions, pg_temp");
    expect(apiSecurity).toContain("begin;");
    expect(apiSecurity).toContain("commit;");
    expect(apiSecurity).not.toMatch(/[\\w.+-]+@[\\w.-]+/);
  });
  it("controls Stripe and Mercado Pago independently while keeping one enabled",()=>{
    expect(billing).toContain("'mercadopago','stripe'");
    expect(billing).toContain("prevent_disabling_all_billing_providers");
    expect(billing).toContain("billing_provider_events");
  });
});
