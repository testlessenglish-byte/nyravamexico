begin;

create table if not exists public.social_case_assignment_acknowledgements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  social_case_id uuid not null references public.social_cases(id),
  assignment_id uuid not null references public.social_case_assignments(id),
  assigned_user_id uuid not null references auth.users(id),
  assigned_by uuid not null references auth.users(id),
  due_at timestamptz not null,
  acknowledged_at timestamptz,
  acknowledged_by uuid references auth.users(id),
  escalated_at timestamptz,
  created_at timestamptz not null default now(),
  unique(assignment_id)
);

create table if not exists public.care_pipeline_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  case_id uuid not null references public.social_cases(id),
  requested_by uuid not null references auth.users(id),
  run_type text not null check(run_type in ('initial','update','closure')),
  status text not null default 'queued' check(status in (
    'queued','preflight','collecting_records','checking_completeness',
    'reviewing_risk','reviewing_care_plan','reviewing_services',
    'reviewing_referrals','reviewing_documents','ai_review',
    'validating_sources','building_recommendations',
    'awaiting_employee_review','completed','failed','cancelled'
  )),
  started_at timestamptz,
  completed_at timestamptz,
  last_successful_stage text,
  records_reviewed integer not null default 0,
  documents_reviewed integer not null default 0,
  restricted_records_excluded integer not null default 0,
  limited_mode boolean not null default false,
  error_summary text,
  base_run_id uuid references public.care_pipeline_runs(id),
  change_cursor timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists care_pipeline_one_active_case
  on public.care_pipeline_runs(case_id)
  where status not in ('awaiting_employee_review','completed','failed','cancelled');
create index if not exists care_pipeline_case_time_idx
  on public.care_pipeline_runs(case_id,created_at desc);
create index if not exists care_pipeline_org_status_idx
  on public.care_pipeline_runs(organization_id,status,created_at desc);

create table if not exists public.care_pipeline_stage_runs (
  id uuid primary key default gen_random_uuid(),
  pipeline_run_id uuid not null references public.care_pipeline_runs(id) on delete cascade,
  stage_key text not null,
  status text not null check(status in ('queued','running','completed','failed','cancelled','skipped')),
  started_at timestamptz,
  completed_at timestamptz,
  input_count integer not null default 0,
  output_count integer not null default 0,
  error text,
  unique(pipeline_run_id,stage_key)
);

create table if not exists public.care_pipeline_check_results (
  id uuid primary key default gen_random_uuid(),
  pipeline_run_id uuid not null references public.care_pipeline_runs(id) on delete cascade,
  check_key text not null,
  category text not null,
  result text not null check(result in ('pass','fail','warning','not_applicable')),
  severity text not null check(severity in ('info','warning','high','critical')),
  message text not null,
  source_entity_type text,
  source_entity_id uuid,
  created_at timestamptz not null default now(),
  unique(pipeline_run_id,check_key)
);

create table if not exists public.care_review_findings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  case_id uuid not null references public.social_cases(id),
  pipeline_run_id uuid not null references public.care_pipeline_runs(id) on delete cascade,
  finding_type text not null check(finding_type in (
    'immediate_attention','missing_information','unresolved_need','overdue_task',
    'risk_review','care_plan_gap','referral_followup','document_gap',
    'consent_issue','possible_legal_need','closure_blocker'
  )),
  severity text not null check(severity in ('info','warning','high','critical')),
  title text not null,
  description text not null,
  deterministic boolean not null default true,
  confidence numeric(5,4),
  status text not null default 'open' check(status in ('open','accepted','rejected','resolved','superseded')),
  assigned_to uuid references auth.users(id),
  due_at timestamptz,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists care_review_findings_case_idx
  on public.care_review_findings(case_id,status,created_at desc);

create table if not exists public.care_review_finding_sources (
  id uuid primary key default gen_random_uuid(),
  finding_id uuid not null references public.care_review_findings(id) on delete cascade,
  source_type text not null,
  source_id uuid,
  source_version integer,
  source_date timestamptz,
  document_page integer check(document_page is null or document_page>0),
  excerpt text,
  created_at timestamptz not null default now()
);

create table if not exists public.care_review_recommendations (
  id uuid primary key default gen_random_uuid(),
  finding_id uuid not null references public.care_review_findings(id) on delete cascade,
  recommended_action text not null,
  title text not null,
  suggested_user_id uuid references auth.users(id),
  suggested_due_at timestamptz,
  approval_required boolean not null default true,
  status text not null default 'proposed' check(status in ('proposed','accepted','edited','rejected','completed','superseded')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  rejection_reason text,
  resulting_entity_type text,
  resulting_entity_id uuid,
  preview jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.social_case_assignment_acknowledgements enable row level security;
alter table public.care_pipeline_runs enable row level security;
alter table public.care_pipeline_stage_runs enable row level security;
alter table public.care_pipeline_check_results enable row level security;
alter table public.care_review_findings enable row level security;
alter table public.care_review_finding_sources enable row level security;
alter table public.care_review_recommendations enable row level security;

drop policy if exists social_assignment_ack_read on public.social_case_assignment_acknowledgements;
create policy social_assignment_ack_read on public.social_case_assignment_acknowledgements
for select to authenticated using(public.social_can_access_case(social_case_id,'general_case_record',false,auth.uid()));

drop policy if exists care_pipeline_runs_read on public.care_pipeline_runs;
create policy care_pipeline_runs_read on public.care_pipeline_runs
for select to authenticated using(public.social_can_access_case(case_id,'general_case_record',false,auth.uid()));

drop policy if exists care_pipeline_stages_read on public.care_pipeline_stage_runs;
create policy care_pipeline_stages_read on public.care_pipeline_stage_runs
for select to authenticated using(exists(
  select 1 from public.care_pipeline_runs r
  where r.id=pipeline_run_id
    and public.social_can_access_case(r.case_id,'general_case_record',false,auth.uid())
));

drop policy if exists care_pipeline_checks_read on public.care_pipeline_check_results;
create policy care_pipeline_checks_read on public.care_pipeline_check_results
for select to authenticated using(exists(
  select 1 from public.care_pipeline_runs r
  where r.id=pipeline_run_id
    and public.social_can_access_case(r.case_id,'general_case_record',false,auth.uid())
));

drop policy if exists care_review_findings_read on public.care_review_findings;
create policy care_review_findings_read on public.care_review_findings
for select to authenticated using(public.social_can_access_case(case_id,'general_case_record',false,auth.uid()));

drop policy if exists care_review_sources_read on public.care_review_finding_sources;
create policy care_review_sources_read on public.care_review_finding_sources
for select to authenticated using(exists(
  select 1 from public.care_review_findings f
  where f.id=finding_id
    and public.social_can_access_case(f.case_id,'general_case_record',false,auth.uid())
));

drop policy if exists care_review_recommendations_read on public.care_review_recommendations;
create policy care_review_recommendations_read on public.care_review_recommendations
for select to authenticated using(exists(
  select 1 from public.care_review_findings f
  where f.id=finding_id
    and public.social_can_access_case(f.case_id,'general_case_record',false,auth.uid())
));

revoke all on public.social_case_assignment_acknowledgements from anon,authenticated;
revoke all on public.care_pipeline_runs from anon,authenticated;
revoke all on public.care_pipeline_stage_runs from anon,authenticated;
revoke all on public.care_pipeline_check_results from anon,authenticated;
revoke all on public.care_review_findings from anon,authenticated;
revoke all on public.care_review_finding_sources from anon,authenticated;
revoke all on public.care_review_recommendations from anon,authenticated;
grant select on public.social_case_assignment_acknowledgements to authenticated;
grant select on public.care_pipeline_runs,public.care_pipeline_stage_runs,
  public.care_pipeline_check_results,public.care_review_findings,
  public.care_review_finding_sources,public.care_review_recommendations to authenticated;

create or replace function public.prepare_social_assignment_acknowledgement()
returns trigger language plpgsql security definer set search_path=public,pg_temp
as $assignment_ack$
declare
  v_priority text;
  v_due timestamptz;
begin
  if not new.active or new.assignment_role not in ('case_manager','primary_case_manager') then
    return new;
  end if;
  select priority into v_priority from public.social_cases where id=new.social_case_id;
  v_due:=case v_priority
    when 'emergency' then now()+interval '15 minutes'
    when 'urgent' then now()+interval '4 hours'
    else now()+interval '24 hours'
  end;
  insert into public.social_case_assignment_acknowledgements(
    org_id,social_case_id,assignment_id,assigned_user_id,assigned_by,due_at
  ) values(new.org_id,new.social_case_id,new.id,new.user_id,new.assigned_by,v_due)
  on conflict(assignment_id) do update set
    assigned_user_id=excluded.assigned_user_id,
    assigned_by=excluded.assigned_by,
    due_at=excluded.due_at;
  return new;
end
$assignment_ack$;

drop trigger if exists social_case_assignment_prepare_ack on public.social_case_assignments;
create trigger social_case_assignment_prepare_ack
after insert or update of active,assignment_role,user_id on public.social_case_assignments
for each row execute function public.prepare_social_assignment_acknowledgement();

insert into public.social_case_assignment_acknowledgements(
  org_id,social_case_id,assignment_id,assigned_user_id,assigned_by,due_at
)
select a.org_id,a.social_case_id,a.id,a.user_id,a.assigned_by,
  case c.priority when 'emergency' then a.assigned_at+interval '15 minutes'
    when 'urgent' then a.assigned_at+interval '4 hours'
    else a.assigned_at+interval '24 hours' end
from public.social_case_assignments a
join public.social_cases c on c.id=a.social_case_id
where a.active and a.assignment_role in ('case_manager','primary_case_manager')
on conflict(assignment_id) do nothing;

create or replace function public.acknowledge_social_case_assignment(p_case uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $ack$
declare
  v_user uuid:=auth.uid();
  v_ack public.social_case_assignment_acknowledgements%rowtype;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select k.* into v_ack
  from public.social_case_assignment_acknowledgements k
  join public.social_case_assignments a on a.id=k.assignment_id
  where k.social_case_id=p_case and k.assigned_user_id=v_user and a.active
  order by k.created_at desc limit 1;
  if v_ack.id is null then raise exception 'Active case assignment required'; end if;

  update public.social_case_assignment_acknowledgements
  set acknowledged_at=coalesce(acknowledged_at,now()),acknowledged_by=v_user
  where id=v_ack.id returning * into v_ack;

  update public.social_alerts set acknowledged_at=coalesce(acknowledged_at,now())
  where social_case_id=p_case and assigned_to=v_user and resolved_at is null;

  insert into public.social_activity_events(
    org_id,social_case_id,actor_id,event_type,entity_type,entity_id,metadata
  ) values(v_ack.org_id,p_case,v_user,'case_assignment_acknowledged',
    'social_case_assignment',v_ack.assignment_id,
    jsonb_build_object('due_at',v_ack.due_at,'acknowledged_at',v_ack.acknowledged_at));

  return jsonb_build_object('id',v_ack.id,'acknowledged_at',v_ack.acknowledged_at,'due_at',v_ack.due_at);
end
$ack$;

create or replace function public.escalate_overdue_social_assignments(p_org uuid default null)
returns integer language plpgsql security definer set search_path=public,pg_temp
as $escalate$
declare v_count integer:=0;
begin
  if auth.uid() is not null and p_org is not null
     and not public.social_can_manage_org(p_org,auth.uid()) then
    raise exception 'Organization manager access required';
  end if;
  with overdue as (
    update public.social_case_assignment_acknowledgements k
    set escalated_at=now()
    where k.acknowledged_at is null and k.escalated_at is null and k.due_at<now()
      and (p_org is null or k.org_id=p_org)
    returning k.*
  ), inserted as (
    insert into public.social_alerts(
      org_id,social_case_id,alert_type,severity,title_es,title_en,due_at,assigned_to,metadata
    )
    select o.org_id,o.social_case_id,'assignment_acknowledgement_overdue','critical',
      'Asignación urgente sin confirmar','Urgent assignment not acknowledged',
      o.due_at,o.assigned_by,jsonb_build_object('assignment_id',o.assignment_id,'assigned_user_id',o.assigned_user_id)
    from overdue o
    returning 1
  ) select count(*) into v_count from inserted;
  return v_count;
end
$escalate$;

create or replace function public.run_care_case_review(
  p_case uuid,p_run_type text default 'update',p_language text default 'es'
) returns uuid language plpgsql security definer set search_path=public,pg_temp
as $review$
declare
  v_user uuid:=auth.uid();
  v_case public.social_cases%rowtype;
  v_run uuid;
  v_base uuid;
  v_cursor timestamptz;
  v_records integer:=0;
  v_documents integer:=0;
  v_excluded integer:=0;
  v_now timestamptz:=now();
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_run_type not in ('initial','update','closure') then raise exception 'Invalid review type'; end if;

  select * into v_case from public.social_cases where id=p_case and deleted_at is null;
  if v_case.id is null then raise exception 'Case not found or inaccessible'; end if;
  if not public.social_is_org_member(v_case.org_id,v_user)
     or not public.social_can_access_case(p_case,'general_case_record',false,v_user) then
    raise exception 'Active case assignment or explicit access required';
  end if;
  if not public.social_org_subscription_active(v_case.org_id) then
    raise exception 'Active organization subscription required';
  end if;
  if exists(select 1 from public.care_pipeline_runs where case_id=p_case
    and status not in ('awaiting_employee_review','completed','failed','cancelled')) then
    raise exception 'A review is already active for this case';
  end if;
  if exists(select 1 from public.social_case_assignments a
      where a.social_case_id=p_case and a.user_id=v_user and a.active)
     and not exists(select 1 from public.social_case_assignment_acknowledgements k
      join public.social_case_assignments a on a.id=k.assignment_id
      where k.social_case_id=p_case and k.assigned_user_id=v_user and a.active
        and k.acknowledged_at is not null) then
    raise exception 'Acknowledge the case assignment before running a review';
  end if;

  select id,coalesce(change_cursor,completed_at,created_at)
    into v_base,v_cursor from public.care_pipeline_runs
    where case_id=p_case and status in ('completed','awaiting_employee_review')
    order by created_at desc limit 1;
  if p_run_type<>'update' then v_base:=null;v_cursor:=null; end if;

  insert into public.care_pipeline_runs(
    organization_id,case_id,requested_by,run_type,status,started_at,base_run_id,change_cursor
  ) values(v_case.org_id,p_case,v_user,p_run_type,'preflight',v_now,v_base,v_cursor)
  returning id into v_run;

  insert into public.care_pipeline_stage_runs(pipeline_run_id,stage_key,status,started_at,completed_at)
  values(v_run,'preflight','completed',v_now,now());

  update public.care_pipeline_runs set status='collecting_records',last_successful_stage='preflight' where id=v_run;

  select
    (select count(*) from public.social_assessments where social_case_id=p_case)+
    (select count(*) from public.social_care_plans where social_case_id=p_case)+
    (select count(*) from public.social_interventions i where i.social_case_id=p_case
      and public.social_can_access_case(p_case,i.record_type,false,v_user))+
    (select count(*) from public.social_tasks where social_case_id=p_case)+
    (select count(*) from public.social_referrals where social_case_id=p_case)+
    (select count(*) from public.social_appointments where social_case_id=p_case)
    into v_records;

  select count(*) into v_documents from public.social_documents d
  where d.social_case_id=p_case and d.deleted_at is null
    and public.social_can_access_case(p_case,d.record_type,false,v_user);
  select count(*) into v_excluded from public.social_documents d
  where d.social_case_id=p_case and d.deleted_at is null
    and not public.social_can_access_case(p_case,d.record_type,false,v_user);

  insert into public.care_pipeline_stage_runs(
    pipeline_run_id,stage_key,status,started_at,completed_at,input_count,output_count
  ) values(v_run,'collecting_records','completed',now(),now(),v_records+v_documents+v_excluded,v_records+v_documents);

  update public.care_pipeline_runs set status='checking_completeness',
    last_successful_stage='collecting_records',records_reviewed=v_records,
    documents_reviewed=v_documents,restricted_records_excluded=v_excluded
  where id=v_run;

  insert into public.care_pipeline_check_results(
    pipeline_run_id,check_key,category,result,severity,message,source_entity_type,source_entity_id
  )
  select v_run,'case_assigned','workflow',
    case when v_case.assigned_case_manager is null then 'fail' else 'pass' end,
    case when v_case.assigned_case_manager is null then 'high' else 'info' end,
    case when v_case.assigned_case_manager is null then 'Case has no responsible employee.' else 'Case is assigned.' end,
    'social_case',p_case
  union all
  select v_run,'assignment_acknowledged','workflow',
    case when exists(select 1 from public.social_case_assignment_acknowledgements k
      join public.social_case_assignments a on a.id=k.assignment_id
      where k.social_case_id=p_case and a.active and k.acknowledged_at is not null) then 'pass' else 'fail' end,
    case when v_case.priority in ('urgent','emergency') then 'critical' else 'warning' end,
    'Active assignment acknowledgement status.','social_case',p_case
  union all
  select v_run,'active_consent','consent',
    case when exists(select 1 from public.social_consents c where c.org_id=v_case.org_id
      and (c.person_id=v_case.person_id or c.family_id=v_case.family_id)
      and c.status='active' and (c.expires_at is null or c.expires_at>v_now)) then 'pass' else 'fail' end,
    'high','No current active consent was found for the case subject.','social_case',p_case
  union all
  select v_run,'initial_assessment','risk',
    case when exists(select 1 from public.social_assessments where social_case_id=p_case) then 'pass' else 'fail' end,
    'high','Initial assessment presence.','social_case',p_case
  union all
  select v_run,'current_assessment','risk',
    case when exists(select 1 from public.social_assessments where social_case_id=p_case
      and (next_review_date is null or next_review_date>=current_date)) then 'pass' else 'warning' end,
    'warning','Assessment currency and next review date.','social_case',p_case
  union all
  select v_run,'risk_safety_actions','risk',
    case when v_case.risk_level not in ('high','critical') or exists(
      select 1 from public.social_assessments a join public.social_assessment_versions av
        on av.assessment_id=a.id and av.version=a.current_version
      where a.social_case_id=p_case and nullif(btrim(av.immediate_actions),'') is not null
    ) then 'pass' else 'fail' end,
    case when v_case.risk_level='critical' then 'critical' else 'high' end,
    'High or critical risk requires documented safety actions.','social_case',p_case
  union all
  select v_run,'active_care_plan','care_plan',
    case when exists(select 1 from public.social_care_plans where social_case_id=p_case
      and status in ('active','under_review')) then 'pass' else 'fail' end,
    'warning','Active or under-review care plan presence.','social_case',p_case
  union all
  select v_run,'overdue_tasks','tasks',
    case when exists(select 1 from public.social_tasks where social_case_id=p_case
      and status not in ('done','cancelled') and due_at<v_now) then 'fail' else 'pass' end,
    'high','Open tasks were checked for overdue deadlines.','social_case',p_case
  union all
  select v_run,'referral_followup','referrals',
    case when exists(select 1 from public.social_referrals where social_case_id=p_case
      and status in ('sent','received','appointment_scheduled','in_progress')
      and coalesce(follow_up_date,current_date)<current_date) then 'warning' else 'pass' end,
    'warning','Open referrals were checked for missing follow-up.','social_case',p_case
  union all
  select v_run,'required_documents','documents',
    case when exists(select 1 from public.social_case_document_requirements
      where social_case_id=p_case and status='missing') then 'fail' else 'pass' end,
    'warning','Required document inventory was checked.','social_case',p_case
  union all
  select v_run,'document_extraction','documents',
    case when exists(select 1 from public.social_documents d where d.social_case_id=p_case
      and d.deleted_at is null and d.extraction_authorized and d.extracted_text is null
      and public.social_can_access_case(p_case,d.record_type,false,v_user)) then 'warning' else 'pass' end,
    'warning','Authorized files were checked for extraction availability.','social_case',p_case
  union all
  select v_run,'recent_contact','workflow',
    case when v_case.last_activity_at is null or v_case.last_activity_at<v_now-interval '14 days'
      then 'warning' else 'pass' end,
    'warning','Case activity was checked for possible inactivity.','social_case',p_case
  union all
  select v_run,'closure_requirements','closure',
    case when p_run_type<>'closure' then 'not_applicable'
      when exists(select 1 from public.social_tasks where social_case_id=p_case and status not in ('done','cancelled'))
        or exists(select 1 from public.social_referrals where social_case_id=p_case and status not in ('completed','rejected','unable_to_contact','cancelled'))
      then 'fail' else 'pass' end,
    'high','Closure requires no unresolved tasks or referrals.','social_case',p_case;

  insert into public.care_pipeline_stage_runs(pipeline_run_id,stage_key,status,started_at,completed_at,input_count,output_count)
  select v_run,s,'completed',now(),now(),
    (select count(*) from public.care_pipeline_check_results where pipeline_run_id=v_run),
    (select count(*) from public.care_pipeline_check_results where pipeline_run_id=v_run and result<>'pass')
  from unnest(array[
    'checking_completeness','reviewing_risk','reviewing_care_plan',
    'reviewing_services','reviewing_referrals','reviewing_documents'
  ]) s;

  insert into public.care_review_findings(
    organization_id,case_id,pipeline_run_id,finding_type,severity,title,description,deterministic
  )
  select v_case.org_id,p_case,v_run,
    case c.category
      when 'risk' then 'risk_review'
      when 'care_plan' then 'care_plan_gap'
      when 'referrals' then 'referral_followup'
      when 'documents' then 'document_gap'
      when 'consent' then 'consent_issue'
      when 'closure' then 'closure_blocker'
      when 'tasks' then 'overdue_task'
      else case when c.severity in ('critical','high') then 'immediate_attention' else 'missing_information' end
    end,
    c.severity,replace(initcap(replace(c.check_key,'_',' ')),'  ',' '),c.message,true
  from public.care_pipeline_check_results c
  where c.pipeline_run_id=v_run and c.result in ('fail','warning');

  insert into public.care_review_finding_sources(
    finding_id,source_type,source_id,source_date,excerpt
  )
  select f.id,c.source_entity_type,c.source_entity_id,v_now,null
  from public.care_review_findings f
  join public.care_pipeline_check_results c on c.pipeline_run_id=f.pipeline_run_id
    and c.message=f.description
  where f.pipeline_run_id=v_run;

  insert into public.care_review_recommendations(
    finding_id,recommended_action,title,suggested_user_id,suggested_due_at,
    approval_required,preview
  )
  select f.id,
    case f.finding_type
      when 'referral_followup' then 'start_referral'
      when 'document_gap' then 'request_document'
      when 'risk_review' then 'request_supervisor_review'
      when 'possible_legal_need' then 'refer_to_legal_services'
      else 'create_task'
    end,
    f.title,v_case.assigned_case_manager,
    v_now+case when f.severity='critical' then interval '1 day'
      when f.severity='high' then interval '3 days' else interval '7 days' end,
    true,
    jsonb_build_object(
      'case_id',p_case,'case_number',v_case.case_number,'title',f.title,
      'reason',f.description,'source_type','social_case','source_id',p_case,
      'warning','Confirmation is required. No official case state has changed.'
    )
  from public.care_review_findings f where f.pipeline_run_id=v_run;

  insert into public.care_pipeline_stage_runs(
    pipeline_run_id,stage_key,status,started_at,completed_at,error
  ) values(v_run,'ai_review','failed',now(),now(),
    'AI-assisted note analysis was unavailable. Structured checks completed; this is a Limited Review.'),
    (v_run,'validating_sources','completed',now(),now(),null),
    (v_run,'building_recommendations','completed',now(),now(),null),
    (v_run,'awaiting_employee_review','completed',now(),now(),null);

  update public.care_pipeline_runs set status='awaiting_employee_review',
    completed_at=now(),last_successful_stage='building_recommendations',
    limited_mode=true,
    error_summary='Limited Review — structured checks completed, but AI-assisted note analysis was unavailable.',
    change_cursor=now()
  where id=v_run;

  insert into public.social_activity_events(
    org_id,social_case_id,actor_id,event_type,entity_type,entity_id,metadata
  ) values(v_case.org_id,p_case,v_user,'care_case_review_completed',
    'care_pipeline_run',v_run,jsonb_build_object(
      'run_type',p_run_type,'limited_mode',true,
      'findings',(select count(*) from public.care_review_findings where pipeline_run_id=v_run),
      'restricted_records_excluded',v_excluded
    ));

  insert into public.social_alerts(
    org_id,social_case_id,alert_type,severity,title_es,title_en,assigned_to,metadata
  ) values(v_case.org_id,p_case,'care_case_review_completed',
    case when exists(select 1 from public.care_review_findings where pipeline_run_id=v_run and severity='critical') then 'critical' else 'info' end,
    'Revisión de caso completada','Case review completed',
    coalesce(v_case.supervising_manager,v_case.created_by),
    jsonb_build_object('pipeline_run_id',v_run,'run_type',p_run_type,'limited_mode',true));

  return v_run;
exception when others then
  if v_run is not null then
    update public.care_pipeline_runs set status='failed',completed_at=now(),error_summary=sqlerrm where id=v_run;
  end if;
  raise;
end
$review$;

create or replace function public.cancel_care_case_review(p_run uuid)
returns void language plpgsql security definer set search_path=public,pg_temp
as $cancel$
declare v_case uuid;
begin
  select case_id into v_case from public.care_pipeline_runs where id=p_run;
  if v_case is null or not public.social_can_access_case(v_case,'general_case_record',true,auth.uid()) then
    raise exception 'Case update access required';
  end if;
  update public.care_pipeline_runs set status='cancelled',completed_at=now()
  where id=p_run and status not in ('completed','failed','cancelled');
  update public.care_pipeline_stage_runs set status='cancelled',completed_at=now()
  where pipeline_run_id=p_run and status in ('queued','running');
end
$cancel$;

create or replace function public.review_care_recommendation(
  p_recommendation uuid,p_decision text,p_title text default null,
  p_assignee uuid default null,p_due_at timestamptz default null,
  p_rejection_reason text default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $decision$
declare
  v_user uuid:=auth.uid();
  v_rec public.care_review_recommendations%rowtype;
  v_case uuid;
begin
  select r.* into v_rec from public.care_review_recommendations r where r.id=p_recommendation;
  select f.case_id into v_case from public.care_review_findings f where f.id=v_rec.finding_id;
  if v_rec.id is null or not public.social_can_access_case(v_case,'general_case_record',true,v_user) then
    raise exception 'Case update access required';
  end if;
  if p_decision not in ('accepted','edited','rejected') then raise exception 'Invalid recommendation decision'; end if;
  if p_decision='rejected' and nullif(btrim(p_rejection_reason),'') is null then
    raise exception 'Rejection reason is required';
  end if;
  update public.care_review_recommendations set
    status=p_decision,title=coalesce(nullif(btrim(p_title),''),title),
    suggested_user_id=coalesce(p_assignee,suggested_user_id),
    suggested_due_at=coalesce(p_due_at,suggested_due_at),
    reviewed_by=v_user,reviewed_at=now(),rejection_reason=p_rejection_reason
  where id=p_recommendation returning * into v_rec;
  update public.care_review_findings set status=case when p_decision='rejected' then 'rejected' else 'accepted' end
  where id=v_rec.finding_id;
  return to_jsonb(v_rec);
end
$decision$;

create or replace function public.confirm_care_recommendation(p_recommendation uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $confirm$
declare
  v_user uuid:=auth.uid();
  v_rec public.care_review_recommendations%rowtype;
  v_finding public.care_review_findings%rowtype;
  v_entity uuid;
begin
  select * into v_rec from public.care_review_recommendations where id=p_recommendation;
  select * into v_finding from public.care_review_findings where id=v_rec.finding_id;
  if v_rec.id is null or v_rec.status not in ('accepted','edited') then
    raise exception 'Accept or edit the recommendation before confirmation';
  end if;
  if not public.social_can_access_case(v_finding.case_id,'general_case_record',true,v_user) then
    raise exception 'Case update access required';
  end if;

  if v_rec.recommended_action in ('create_task','request_document','start_referral','request_supervisor_review','refer_to_legal_services') then
    insert into public.social_tasks(
      org_id,social_case_id,title,description,assignee_id,priority,status,due_at,created_by
    ) values(
      v_finding.organization_id,v_finding.case_id,v_rec.title,
      v_finding.description,coalesce(v_rec.suggested_user_id,v_user),
      case when v_finding.severity in ('critical','high') then 'urgent' else 'normal' end,
      'todo',v_rec.suggested_due_at,v_user
    ) returning id into v_entity;
    update public.care_review_recommendations set
      status='completed',resulting_entity_type='social_task',resulting_entity_id=v_entity
    where id=p_recommendation;
  else
    raise exception 'This recommendation requires a specialized professional workflow';
  end if;

  insert into public.social_activity_events(
    org_id,social_case_id,actor_id,event_type,entity_type,entity_id,metadata
  ) values(v_finding.organization_id,v_finding.case_id,v_user,
    'care_review_recommendation_completed','care_review_recommendation',
    p_recommendation,jsonb_build_object('resulting_entity_type','social_task','resulting_entity_id',v_entity));

  return jsonb_build_object('id',p_recommendation,'status','completed',
    'resulting_entity_type','social_task','resulting_entity_id',v_entity);
end
$confirm$;

revoke all on function public.acknowledge_social_case_assignment(uuid) from public,anon;
revoke all on function public.escalate_overdue_social_assignments(uuid) from public,anon;
revoke all on function public.run_care_case_review(uuid,text,text) from public,anon;
revoke all on function public.cancel_care_case_review(uuid) from public,anon;
revoke all on function public.review_care_recommendation(uuid,text,text,uuid,timestamptz,text) from public,anon;
revoke all on function public.confirm_care_recommendation(uuid) from public,anon;
grant execute on function public.acknowledge_social_case_assignment(uuid) to authenticated,service_role;
grant execute on function public.escalate_overdue_social_assignments(uuid) to authenticated,service_role;
grant execute on function public.run_care_case_review(uuid,text,text) to authenticated,service_role;
grant execute on function public.cancel_care_case_review(uuid) to authenticated,service_role;
grant execute on function public.review_care_recommendation(uuid,text,text,uuid,timestamptz,text) to authenticated,service_role;
grant execute on function public.confirm_care_recommendation(uuid) to authenticated,service_role;

notify pgrst,'reload schema';
commit;
