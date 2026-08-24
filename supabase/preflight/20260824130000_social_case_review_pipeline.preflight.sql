-- Read-only preflight for 20260824130000_social_case_review_pipeline.sql
select
  to_regclass('public.social_cases') is not null as social_cases_exists,
  to_regclass('public.social_case_assignments') is not null as assignments_exist,
  to_regclass('public.social_assessments') is not null as assessments_exist,
  to_regclass('public.social_care_plans') is not null as care_plans_exist,
  to_regclass('public.social_interventions') is not null as interventions_exist,
  to_regclass('public.social_referrals') is not null as referrals_exist,
  to_regclass('public.social_tasks') is not null as tasks_exist,
  to_regclass('public.social_documents') is not null as documents_exist,
  to_regclass('public.social_consents') is not null as consents_exist,
  to_regprocedure('public.social_can_access_case(uuid,text,boolean,uuid)') is not null as case_access_helper_exists,
  to_regprocedure('public.social_org_subscription_active(uuid)') is not null as subscription_helper_exists;
