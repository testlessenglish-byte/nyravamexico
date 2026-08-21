begin;

-- 1/2. Social capability mappings are internal authorization configuration.
-- SECURITY DEFINER authorization helpers may read them; API roles may not.
alter table public.social_role_capabilities enable row level security;
revoke all on table public.social_role_capabilities from public, anon, authenticated;
grant all on table public.social_role_capabilities to service_role;

-- 3. Legacy plan-entitlement rows describe internal quota/permission design.
-- Current billing enforcement reads billing_plans server-side, so no browser
-- role requires direct access to this legacy mapping table.
alter table public.plan_entitlements enable row level security;
drop policy if exists plan_ent_public_read on public.plan_entitlements;
drop policy if exists plan_ent_read_authenticated on public.plan_entitlements;
revoke all on table public.plan_entitlements from public, anon, authenticated;
grant all on table public.plan_entitlements to service_role;

-- 4. Checkout and the signed-in billing page are server-backed. Preserve the
-- existing admin policies but remove anonymous/full-row plan reads, which
-- exposed provider identifiers, usage limits and feature flags.
alter table public.billing_plans enable row level security;
drop policy if exists plans_public_read on public.billing_plans;
drop policy if exists "Anyone can view active plans" on public.billing_plans;
revoke all on table public.billing_plans from public, anon;
grant select,insert,update,delete on table public.billing_plans to authenticated;
grant all on table public.billing_plans to service_role;

-- 5. Profiles contain PII. Reassert self-only RLS and remove every anonymous
-- or inherited PUBLIC table privilege without changing signed-in account flow.
alter table public.profiles enable row level security;
revoke all on table public.profiles from public, anon, authenticated;
grant select,insert,update on table public.profiles to authenticated;
grant all on table public.profiles to service_role;
drop policy if exists profiles_api_self_select on public.profiles;
drop policy if exists profiles_api_self_insert on public.profiles;
drop policy if exists profiles_api_self_update on public.profiles;
create policy profiles_api_self_select on public.profiles
  for select to authenticated using (id=auth.uid());
create policy profiles_api_self_insert on public.profiles
  for insert to authenticated with check (id=auth.uid());
create policy profiles_api_self_update on public.profiles
  for update to authenticated using (id=auth.uid()) with check (id=auth.uid());

-- 6. PostgreSQL grants EXECUTE to PUBLIC by default for new functions. Remove
-- that inherited anonymous access from every current SECURITY DEFINER routine.
-- Existing explicit authenticated grants remain unchanged; service jobs retain
-- access. Trigger functions continue to execute through their triggers.
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as signature
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prosecdef
  loop
    execute format('revoke execute on function %s from public, anon',r.signature);
    execute format('grant execute on function %s to service_role',r.signature);
  end loop;
end;
$$;

-- 7. Pin every exposed public-schema routine to a deterministic path. Include
-- the extensions schema for installed Supabase extensions and pg_temp last.
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as signature
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public'
      and not exists (
        select 1 from unnest(coalesce(p.proconfig,'{}'::text[])) setting
        where setting like 'search_path=%'
      )
  loop
    execute format(
      'alter function %s set search_path = public, extensions, pg_temp',
      r.signature
    );
  end loop;
end;
$$;

notify pgrst,'reload schema';
commit;

