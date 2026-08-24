-- Destructive rollback. Run only if the feature must be fully removed.
begin;
drop trigger if exists social_case_assignment_prepare_ack on public.social_case_assignments;
drop function if exists public.prepare_social_assignment_acknowledgement();
drop function if exists public.acknowledge_social_case_assignment(uuid);
drop function if exists public.escalate_overdue_social_assignments(uuid);
drop function if exists public.run_care_case_review(uuid,text,text);
drop function if exists public.cancel_care_case_review(uuid);
drop function if exists public.review_care_recommendation(uuid,text,text,uuid,timestamptz,text);
drop function if exists public.confirm_care_recommendation(uuid);
drop table if exists public.care_review_recommendations;
drop table if exists public.care_review_finding_sources;
drop table if exists public.care_review_findings;
drop table if exists public.care_pipeline_check_results;
drop table if exists public.care_pipeline_stage_runs;
drop table if exists public.care_pipeline_runs;
drop table if exists public.social_case_assignment_acknowledgements;
notify pgrst,'reload schema';
commit;
