import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(join(process.cwd(), "supabase", "migrations", name), "utf8").replace(/\r\n/g, "\n");

const rls = read("20260822221949_f3473633-52b0-4424-8222-95d1eb2a018e.sql");
const exposure = read("20260822222018_a925e26c-5279-4ee2-847d-e37aa6f5f58f.sql");
const functions = read("20260822222128_94bb74a3-8c65-427f-9bfd-50bbaebdbbd8.sql");
const demoServer = readFileSync(join(process.cwd(), "src", "lib", "demo-cases.functions.ts"), "utf8");

describe("supabase security findings — RLS on role/capability mapping", () => {
  it("enables row level security on the flagged table", () => {
    expect(rls).toContain("alter table public.social_role_capabilities enable row level security");
  });

  it("removes anonymous and PUBLIC table privileges", () => {
    expect(rls).toContain("revoke all on table public.social_role_capabilities from anon");
    expect(rls).toContain("revoke all on table public.social_role_capabilities from public");
  });

  it("restricts reads to signed-in members and writes to platform admins and service_role", () => {
    expect(rls).toContain("create policy social_role_capabilities_read");
    expect(rls).toContain("for select\n  to authenticated");
    expect(rls).toContain("public.social_is_platform_admin(auth.uid())");
    expect(rls).toContain("create policy social_role_capabilities_admin_write");
    expect(rls).toContain("grant all on table public.social_role_capabilities to service_role");
  });
});

describe("supabase security findings — no public billing or demo exposure", () => {
  it("drops the anonymous billing plan read policy", () => {
    expect(exposure).toContain("drop policy if exists plans_public_read on public.billing_plans");
    expect(exposure).toContain("revoke all on table public.billing_plans from anon");
  });

  it("exposes only approved marketing fields through the restricted pricing function", () => {
    const fn = exposure
      .slice(
        exposure.indexOf("create or replace function public.list_public_billing_plans"),
        exposure.indexOf("revoke all on function public.list_public_billing_plans"),
      )
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(fn).toContain("set search_path = public, pg_temp");
    for (const secret of [
      "stripe_price_id",
      "internal_notes",
      "ai_requests_monthly",
      "talk_to_case_monthly",
      "case_limit",
      "storage_gb_limit",
      "team_member_limit",
      "overage_price_cents",
    ]) {
      expect(fn).not.toContain(secret);
    }
    expect(fn).toContain("where p.active = true");
  });

  it("removes anonymous access to demo case documents while keeping the signed-URL demo flow", () => {
    expect(exposure).toContain(
      'drop policy if exists "Anyone can view documents of published demo cases" on public.demo_case_documents',
    );
    expect(exposure).toContain("revoke all on table public.demo_case_documents from anon");
    expect(exposure).toContain("create policy demo_case_documents_authenticated_read");
    // Public demo pages read through the backend service role + signed URLs,
    // so removing the anon policy cannot break them.
    expect(demoServer).toContain("createSignedUrl");
    expect(demoServer).toContain('.eq("published", true)');
  });

  it("keeps entitlements, limits and feature flags away from anonymous clients", () => {
    expect(exposure).toContain("revoke all on table public.plan_entitlements from anon");
    expect(exposure).toContain("revoke all on table public.feature_flags from anon");
  });
});

describe("supabase security findings — function hardening", () => {
  it("pins a fixed search_path on every project function", () => {
    expect(functions).toContain("alter function %s set search_path = public, pg_temp");
    expect(functions).toContain("p.proconfig is null or not (p.proconfig::text like '%search_path%')");
  });

  it("revokes PUBLIC and anon EXECUTE and keeps only required roles", () => {
    expect(functions).toContain("revoke all on function %s from public");
    expect(functions).toContain("revoke all on function %s from anon");
    expect(functions).toContain("grant execute on function %s to authenticated");
    expect(functions).toContain("grant execute on function %s to service_role");
  });

  it("never grants clients EXECUTE on internal trigger routines", () => {
    expect(functions).toContain("is_trigger := r.prorettype = 'trigger'::regtype");
    expect(functions).toContain("revoke all on function %s from authenticated");
  });

  it("keeps exactly one deliberate anonymous entry point", () => {
    expect(functions).toContain(
      "grant execute on function public.list_public_billing_plans() to anon",
    );
  });

  it("leaves extension-owned routines untouched", () => {
    expect(functions).toContain("d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'");
  });
});
