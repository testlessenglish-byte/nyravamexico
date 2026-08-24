select
  to_regprocedure('public.enforce_social_case_manager_creation()') is not null as manager_case_creation_guard_exists,
  exists(
    select 1
    from pg_trigger
    where tgrelid='public.social_cases'::regclass
      and tgname='social_cases_manager_only_insert'
      and not tgisinternal
  ) as manager_case_creation_trigger_exists,
  not has_function_privilege('anon','public.enforce_social_case_manager_creation()','EXECUTE') as anon_cannot_execute_guard,
  not has_function_privilege('authenticated','public.enforce_social_case_manager_creation()','EXECUTE') as authenticated_cannot_execute_guard;
