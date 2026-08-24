begin;
drop trigger if exists social_cases_manager_only_insert on public.social_cases;
drop function if exists public.enforce_social_case_manager_creation();
notify pgrst,'reload schema';
commit;
