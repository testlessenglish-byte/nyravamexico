-- Comprehensive Care Knowledge Center: approved organizational library, review workflow and case references.
-- Knowledge records never become legal evidence automatically.

alter table public.resource_knowledge_records
  add column if not exists content_es text,
  add column if not exists content_en text,
  add column if not exists purpose text,
  add column if not exists when_to_use text,
  add column if not exists applicable_programs text[] not null default '{}',
  add column if not exists required_steps jsonb not null default '[]'::jsonb,
  add column if not exists related_forms uuid[] not null default '{}',
  add column if not exists related_resources uuid[] not null default '{}',
  add column if not exists official_sources jsonb not null default '[]'::jsonb,
  add column if not exists authority text,
  add column if not exists language_codes text[] not null default array['es'],
  add column if not exists audience text not null default 'internal_staff',
  add column if not exists owner_id uuid references auth.users(id),
  add column if not exists last_verified_at timestamptz,
  add column if not exists archived_at timestamptz,
  add column if not exists file_type text;

alter table public.resource_knowledge_records drop constraint if exists resource_knowledge_records_approval_status_check;
update public.resource_knowledge_records set approval_status='archived' where approval_status='retired';
update public.resource_knowledge_records set approval_status='pending_review' where approval_status='in_review';

alter table public.resource_knowledge_records add constraint resource_knowledge_records_approval_status_check
  check(approval_status in ('draft','pending_review','approved','published','revision_required','expired','archived'));
alter table public.resource_knowledge_records drop constraint if exists resource_knowledge_records_knowledge_type_check;
alter table public.resource_knowledge_records add constraint resource_knowledge_records_knowledge_type_check
  check(knowledge_type in (
    'procedure','protocol','intake_manual','risk_guidance','care_plan_instruction','consent_template',
    'referral_instruction','emergency_procedure','immigration_guidance','state_municipal_guidance',
    'official_form','training_material','document_checklist','legal_update','institutional_policy','faq',
    'manual','form','service_guide','institution_note'
  ));
alter table public.resource_knowledge_records add constraint resource_knowledge_records_audience_check
  check(audience in ('internal_staff','official_government','client_facing','case_evidence_reference'));

create table if not exists public.resource_knowledge_corrections (
  id uuid primary key default gen_random_uuid(),
  knowledge_id uuid not null references public.resource_knowledge_records(id) on delete cascade,
  org_id uuid references public.organizations(id),
  suggestion text not null,
  status text not null default 'pending' check(status in ('pending','accepted','rejected')),
  submitted_by uuid not null references auth.users(id),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.resource_knowledge_case_actions (
  id uuid primary key default gen_random_uuid(),
  knowledge_id uuid not null references public.resource_knowledge_records(id),
  org_id uuid not null references public.organizations(id),
  social_case_id uuid not null references public.social_cases(id),
  action_type text not null check(action_type in (
    'attach_reference','add_required_form','create_checklist','create_task','find_related_resources',
    'start_referral','share_client_version','ask_talk_to_case'
  )),
  details jsonb not null default '{}'::jsonb,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  constraint resource_knowledge_not_evidence check(coalesce(details->>'legal_evidence','false')='false')
);

create table if not exists public.resource_knowledge_usage (
  id uuid primary key default gen_random_uuid(),
  knowledge_id uuid not null references public.resource_knowledge_records(id) on delete cascade,
  org_id uuid references public.organizations(id),
  action text not null check(action in ('open','download','case_action')),
  actor_id uuid not null references auth.users(id),
  social_case_id uuid references public.social_cases(id),
  created_at timestamptz not null default now()
);

alter table public.resource_knowledge_corrections enable row level security;
alter table public.resource_knowledge_case_actions enable row level security;
alter table public.resource_knowledge_usage enable row level security;

drop policy if exists resource_knowledge_read on public.resource_knowledge_records;
create policy resource_knowledge_read on public.resource_knowledge_records for select to authenticated
using (
  (approval_status in ('approved','published') and (org_id is null or public.social_is_org_member(org_id,auth.uid())))
  or public.social_is_platform_admin(auth.uid())
  or (org_id is not null and public.social_can_manage_org(org_id,auth.uid()))
);

drop policy if exists knowledge_corrections_access on public.resource_knowledge_corrections;
create policy knowledge_corrections_access on public.resource_knowledge_corrections for all to authenticated
using (submitted_by=auth.uid() or public.social_is_platform_admin(auth.uid()) or (org_id is not null and public.social_can_manage_org(org_id,auth.uid())))
with check (submitted_by=auth.uid() and (org_id is null or public.social_is_org_member(org_id,auth.uid()) or public.social_is_platform_admin(auth.uid())));

drop policy if exists knowledge_case_actions_access on public.resource_knowledge_case_actions;
create policy knowledge_case_actions_access on public.resource_knowledge_case_actions for all to authenticated
using (public.social_can_access_case(social_case_id,'general_case_record',false,auth.uid()))
with check (created_by=auth.uid() and public.social_can_access_case(social_case_id,'general_case_record',true,auth.uid()));

drop policy if exists knowledge_usage_insert on public.resource_knowledge_usage;
create policy knowledge_usage_insert on public.resource_knowledge_usage for insert to authenticated
with check (actor_id=auth.uid() and (org_id is null or public.social_is_org_member(org_id,auth.uid()) or public.social_is_platform_admin(auth.uid())));
drop policy if exists knowledge_usage_manage on public.resource_knowledge_usage;
create policy knowledge_usage_manage on public.resource_knowledge_usage for select to authenticated
using (actor_id=auth.uid() or public.social_is_platform_admin(auth.uid()) or (org_id is not null and public.social_can_manage_org(org_id,auth.uid())));

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('social-knowledge-files','social-knowledge-files',false,52428800,array[
  'application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg','image/png','text/plain','text/markdown'
])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

drop policy if exists social_knowledge_files_read on storage.objects;
create policy social_knowledge_files_read on storage.objects for select to authenticated using (
  bucket_id='social-knowledge-files' and exists(
    select 1 from public.resource_knowledge_records k where k.document_path=name
  )
);
drop policy if exists social_knowledge_files_write on storage.objects;
create policy social_knowledge_files_write on storage.objects for insert to authenticated with check (
  bucket_id='social-knowledge-files' and (storage.foldername(name))[1] ~* '^[0-9a-f-]{36}$'
  and (public.social_is_platform_admin(auth.uid()) or public.social_can_manage_org(((storage.foldername(name))[1])::uuid,auth.uid()))
);

-- Normalize legacy literal escape tokens in library text at the source.
update public.resource_knowledge_records set
  title_es=replace(replace(replace(title_es,E'\\r\\n',E'\n'),E'\\n',E'\n'),E'\\t',' '),
  title_en=replace(replace(replace(title_en,E'\\r\\n',E'\n'),E'\\n',E'\n'),E'\\t',' '),
  summary_es=replace(replace(replace(summary_es,E'\\r\\n',E'\n'),E'\\n',E'\n'),E'\\t',' '),
  summary_en=replace(replace(replace(summary_en,E'\\r\\n',E'\n'),E'\\n',E'\n'),E'\\t',' '),
  content_es=replace(replace(replace(content_es,E'\\r\\n',E'\n'),E'\\n',E'\n'),E'\\t',' '),
  content_en=replace(replace(replace(content_en,E'\\r\\n',E'\n'),E'\\n',E'\n'),E'\\t',' ');

comment on table public.resource_knowledge_case_actions is
'Case-scoped workflow references only. Rows do not create evidence or enter Legal Intelligence.';
