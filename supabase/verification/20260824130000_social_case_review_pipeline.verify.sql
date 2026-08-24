-- Read-only verification for 20260824130000_social_case_review_pipeline.sql
select
  to_regclass('public.social_case_assignment_acknowledgements') is not null as acknowledgements_exist,
  to_regclass('public.care_pipeline_runs') is not null as pipeline_runs_exist,
  to_regclass('public.care_pipeline_stage_runs') is not null as stage_runs_exist,
  to_regclass('public.care_pipeline_check_results') is not null as check_results_exist,
  to_regclass('public.care_review_findings') is not null as findings_exist,
  to_regclass('public.care_review_finding_sources') is not null as finding_sources_exist,
  to_regclass('public.care_review_recommendations') is not null as recommendations_exist,
  to_regprocedure('public.acknowledge_social_case_assignment(uuid)') is not null as acknowledge_function_exists,
  to_regprocedure('public.run_care_case_review(uuid,text,text)') is not null as review_function_exists,
  to_regprocedure('public.review_care_recommendation(uuid,text,text,uuid,timestamp with time zone,text)') is not null as decision_function_exists,
  to_regprocedure('public.confirm_care_recommendation(uuid)') is not null as confirmation_function_exists;

select relname,relrowsecurity
from pg_class
where oid in (
  'public.social_case_assignment_acknowledgements'::regclass,
  'public.care_pipeline_runs'::regclass,
  'public.care_pipeline_stage_runs'::regclass,
  'public.care_pipeline_check_results'::regclass,
  'public.care_review_findings'::regclass,
  'public.care_review_finding_sources'::regclass,
  'public.care_review_recommendations'::regclass
)
order by relname;

select count(*) as active_assignments_without_acknowledgement
from public.social_case_assignments a
left join public.social_case_assignment_acknowledgements k on k.assignment_id=a.id
where a.active and a.assignment_role in ('case_manager','primary_case_manager') and k.id is null;
