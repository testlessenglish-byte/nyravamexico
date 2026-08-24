begin;

-- Comprehensive Care cases belong to an organization. Only its owner or an
-- authorized organization manager may create them. Invited employees receive
-- assigned cases and work them; they cannot create or self-assign cases.
create or replace function public.enforce_social_case_manager_creation()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $manager_case_creation$
begin
  -- Preserve trusted backend and migration operations. Interactive signed-in
  -- users must pass the organization manager check.
  if auth.uid() is not null
     and not public.social_can_manage_org(new.org_id,auth.uid()) then
    raise exception 'Only the organization owner or manager can create Comprehensive Care cases'
      using errcode='42501';
  end if;
  return new;
end
$manager_case_creation$;

revoke all on function public.enforce_social_case_manager_creation() from public,anon,authenticated;
grant execute on function public.enforce_social_case_manager_creation() to service_role;

drop trigger if exists social_cases_manager_only_insert on public.social_cases;
create trigger social_cases_manager_only_insert
before insert on public.social_cases
for each row execute function public.enforce_social_case_manager_creation();

comment on function public.enforce_social_case_manager_creation() is
'Rejects interactive Comprehensive Care case creation unless the authenticated user manages the target organization.';

notify pgrst,'reload schema';
commit;
