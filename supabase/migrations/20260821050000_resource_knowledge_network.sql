-- Resource and Institutional Knowledge Network for Atención Integral.
-- Additive only: preserves existing social people, cases, consent and referral workflows.

alter table public.social_institutions
  add column if not exists official_name text,
  add column if not exists description text,
  add column if not exists state_code text,
  add column if not exists municipality text,
  add column if not exists address text,
  add column if not exists latitude double precision,
  add column if not exists longitude double precision,
  add column if not exists phone text,
  add column if not exists whatsapp text,
  add column if not exists email text,
  add column if not exists website text,
  add column if not exists contact_person text,
  add column if not exists hours jsonb not null default '{}'::jsonb,
  add column if not exists languages text[] not null default '{}',
  add column if not exists populations text[] not null default '{}',
  add column if not exists eligibility text,
  add column if not exists required_documents text[] not null default '{}',
  add column if not exists cost_type text not null default 'unknown',
  add column if not exists cost_notes text,
  add column if not exists appointment_required boolean not null default false,
  add column if not exists walk_in_available boolean not null default false,
  add column if not exists accessibility text[] not null default '{}',
  add column if not exists emergency_available boolean not null default false,
  add column if not exists remote_available boolean not null default false,
  add column if not exists referral_methods text[] not null default '{}',
  add column if not exists coverage_levels text[] not null default '{}',
  add column if not exists coverage_states text[] not null default '{}',
  add column if not exists coverage_municipalities text[] not null default '{}',
  add column if not exists capacity_status text not null default 'unknown',
  add column if not exists confidentiality_level text not null default 'standard',
  add column if not exists location_confidential boolean not null default false,
  add column if not exists public_notes text,
  add column if not exists internal_notes text,
  add column if not exists verification_status text not null default 'unverified',
  add column if not exists verification_source text,
  add column if not exists verification_evidence_url text,
  add column if not exists verified_by uuid references auth.users(id),
  add column if not exists next_verification_at timestamptz,
  add column if not exists status text not null default 'unverified',
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by uuid references auth.users(id),
  add column if not exists updated_at timestamptz not null default now();

update public.social_institutions set official_name=coalesce(official_name,name) where official_name is null;

do $$ begin
  alter table public.social_institutions add constraint social_institutions_geo_check
    check ((latitude is null and longitude is null) or (latitude between -90 and 90 and longitude between -180 and 180));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.social_institutions add constraint social_institutions_status_check
    check (status in ('verified','verification_due','unverified','temporarily_unavailable','at_capacity','closed','archived'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.social_institutions add constraint social_institutions_cost_check
    check (cost_type in ('free','sliding_scale','paid','public_coverage','unknown'));
exception when duplicate_object then null; end $$;

create table if not exists public.resource_service_categories (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id),
  code text not null,
  name_es text not null,
  name_en text not null,
  description_es text,
  description_en text,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique nulls not distinct (org_id,code)
);

create table if not exists public.resource_verifications (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.social_institutions(id) on delete cascade,
  org_id uuid references public.organizations(id),
  status text not null check(status in ('verified','verification_due','unverified','temporarily_unavailable','at_capacity','closed','archived')),
  source text not null,
  evidence_url text,
  notes text,
  verified_by uuid not null references auth.users(id),
  verified_at timestamptz not null default now(),
  next_verification_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.resource_corrections (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.social_institutions(id) on delete cascade,
  org_id uuid references public.organizations(id),
  field_name text,
  suggested_value text,
  reason text not null,
  status text not null default 'pending' check(status in ('pending','accepted','rejected')),
  submitted_by uuid not null references auth.users(id),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.resource_internal_experiences (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.social_institutions(id) on delete cascade,
  org_id uuid not null references public.organizations(id),
  outcome text,
  wait_time_notes text,
  accessibility_notes text,
  staff_notes text not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.resource_knowledge_records (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id),
  title_es text not null,
  title_en text not null,
  summary_es text,
  summary_en text,
  knowledge_type text not null check(knowledge_type in ('procedure','protocol','manual','form','legal_update','service_guide','institution_note')),
  service_categories text[] not null default '{}',
  state_codes text[] not null default '{}',
  municipality text,
  population_tags text[] not null default '{}',
  source_url text,
  document_path text,
  version integer not null default 1,
  approval_status text not null default 'draft' check(approval_status in ('draft','in_review','approved','retired')),
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  effective_at timestamptz,
  review_due_at timestamptz,
  internal_only boolean not null default true,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.resource_knowledge_versions (
  id uuid primary key default gen_random_uuid(),
  knowledge_id uuid not null references public.resource_knowledge_records(id) on delete cascade,
  version integer not null,
  snapshot jsonb not null,
  change_summary text not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique(knowledge_id,version)
);

create index if not exists social_institutions_search_idx on public.social_institutions using gin
  (to_tsvector('spanish',coalesce(official_name,'')||' '||coalesce(description,'')||' '||array_to_string(services,' ')));
create index if not exists social_institutions_location_idx on public.social_institutions(state_code,municipality,status);
create index if not exists resource_verifications_institution_idx on public.resource_verifications(institution_id,verified_at desc);
create index if not exists resource_knowledge_filters_idx on public.resource_knowledge_records(approval_status,knowledge_type,review_due_at);

alter table public.resource_service_categories enable row level security;
alter table public.resource_verifications enable row level security;
alter table public.resource_corrections enable row level security;
alter table public.resource_internal_experiences enable row level security;
alter table public.resource_knowledge_records enable row level security;
alter table public.resource_knowledge_versions enable row level security;

drop policy if exists resource_categories_read on public.resource_service_categories;
create policy resource_categories_read on public.resource_service_categories for select to authenticated
  using (org_id is null or public.social_is_org_member(org_id,auth.uid()) or public.social_is_platform_admin(auth.uid()));
drop policy if exists resource_categories_manage on public.resource_service_categories;
create policy resource_categories_manage on public.resource_service_categories for all to authenticated
  using (public.social_is_platform_admin(auth.uid()) or (org_id is not null and public.social_can_manage_org(org_id,auth.uid())))
  with check (public.social_is_platform_admin(auth.uid()) or (org_id is not null and public.social_can_manage_org(org_id,auth.uid())));
drop policy if exists resource_verifications_read on public.resource_verifications;
create policy resource_verifications_read on public.resource_verifications for select to authenticated
  using (public.social_is_platform_admin(auth.uid()) or (org_id is not null and public.social_is_org_member(org_id,auth.uid())));
drop policy if exists resource_verifications_manage on public.resource_verifications;
create policy resource_verifications_manage on public.resource_verifications for all to authenticated
  using (public.social_is_platform_admin(auth.uid()) or (org_id is not null and public.social_can_manage_org(org_id,auth.uid())))
  with check (public.social_is_platform_admin(auth.uid()) or (org_id is not null and public.social_can_manage_org(org_id,auth.uid())));
drop policy if exists resource_corrections_read on public.resource_corrections;
create policy resource_corrections_read on public.resource_corrections for select to authenticated
  using (submitted_by=auth.uid() or public.social_is_platform_admin(auth.uid()) or (org_id is not null and public.social_can_manage_org(org_id,auth.uid())));
drop policy if exists resource_corrections_insert on public.resource_corrections;
create policy resource_corrections_insert on public.resource_corrections for insert to authenticated
  with check (submitted_by=auth.uid() and (org_id is null or public.social_is_org_member(org_id,auth.uid()) or public.social_is_platform_admin(auth.uid())));
drop policy if exists resource_corrections_manage on public.resource_corrections;
create policy resource_corrections_manage on public.resource_corrections for update to authenticated
  using (public.social_is_platform_admin(auth.uid()) or (org_id is not null and public.social_can_manage_org(org_id,auth.uid())));
drop policy if exists resource_experiences_access on public.resource_internal_experiences;
create policy resource_experiences_access on public.resource_internal_experiences for all to authenticated
  using (public.social_is_platform_admin(auth.uid()) or public.social_is_org_member(org_id,auth.uid()))
  with check ((created_by=auth.uid() and public.social_is_org_member(org_id,auth.uid())) or public.social_is_platform_admin(auth.uid()));
drop policy if exists resource_knowledge_read on public.resource_knowledge_records;
create policy resource_knowledge_read on public.resource_knowledge_records for select to authenticated
  using ((approval_status='approved' and (org_id is null or public.social_is_org_member(org_id,auth.uid()))) or public.social_is_platform_admin(auth.uid()) or (org_id is not null and public.social_can_manage_org(org_id,auth.uid())));
drop policy if exists resource_knowledge_manage on public.resource_knowledge_records;
create policy resource_knowledge_manage on public.resource_knowledge_records for all to authenticated
  using (public.social_is_platform_admin(auth.uid()) or (org_id is not null and public.social_can_manage_org(org_id,auth.uid())))
  with check (public.social_is_platform_admin(auth.uid()) or (org_id is not null and public.social_can_manage_org(org_id,auth.uid())));
drop policy if exists resource_knowledge_versions_read on public.resource_knowledge_versions;
create policy resource_knowledge_versions_read on public.resource_knowledge_versions for select to authenticated
  using (exists(select 1 from public.resource_knowledge_records k where k.id=knowledge_id));
drop policy if exists resource_knowledge_versions_manage on public.resource_knowledge_versions;
create policy resource_knowledge_versions_manage on public.resource_knowledge_versions for all to authenticated
  using (exists(select 1 from public.resource_knowledge_records k where k.id=knowledge_id and (public.social_is_platform_admin(auth.uid()) or (k.org_id is not null and public.social_can_manage_org(k.org_id,auth.uid())))))
  with check (exists(select 1 from public.resource_knowledge_records k where k.id=knowledge_id and (public.social_is_platform_admin(auth.uid()) or (k.org_id is not null and public.social_can_manage_org(k.org_id,auth.uid())))));

drop policy if exists social_institutions_read on public.social_institutions;
create policy social_institutions_read on public.social_institutions for select to authenticated
  using (status<>'archived' and (org_id is null or public.social_is_org_member(org_id,auth.uid()) or public.social_is_platform_admin(auth.uid())));
drop policy if exists social_institutions_manage on public.social_institutions;
create policy social_institutions_manage on public.social_institutions for all to authenticated
  using (public.social_is_platform_admin(auth.uid()) or (org_id is not null and public.social_can_manage_org(org_id,auth.uid())))
  with check (public.social_is_platform_admin(auth.uid()) or (org_id is not null and public.social_can_manage_org(org_id,auth.uid())));

create or replace function public.search_resource_network(
  p_query text default null,p_state text default null,p_municipality text default null,
  p_latitude double precision default null,p_longitude double precision default null,p_radius_km double precision default null,
  p_service text default null,p_urgency text default null,p_population text default null,p_language text default null,
  p_cost_type text default null,p_availability text default null,p_limit integer default 50
) returns table(
  id uuid,official_name text,institution_type text,services text[],description text,state_code text,municipality text,
  address text,latitude double precision,longitude double precision,phone text,whatsapp text,email text,website text,
  hours jsonb,languages text[],populations text[],eligibility text,required_documents text[],cost_type text,
  appointment_required boolean,walk_in_available boolean,emergency_available boolean,remote_available boolean,
  referral_methods text[],coverage_levels text[],capacity_status text,verification_status text,verified_at timestamptz,
  next_verification_at timestamptz,status text,distance_km double precision,match_score integer,match_explanation text[]
) language sql stable security invoker set search_path=public as $$
  with ranked as (
    select i.*,
      case when p_latitude is not null and p_longitude is not null and i.latitude is not null and i.longitude is not null then
        6371 * 2 * asin(sqrt(power(sin(radians(i.latitude-p_latitude)/2),2)+cos(radians(p_latitude))*cos(radians(i.latitude))*power(sin(radians(i.longitude-p_longitude)/2),2)))
      end as km,
      (case when p_service is not null and p_service=any(i.services) then 35 else 0 end+
       case when p_state is not null and (upper(i.state_code)=upper(p_state) or upper(p_state)=any(i.coverage_states)) then 20 else 0 end+
       case when p_municipality is not null and (lower(i.municipality)=lower(p_municipality) or lower(p_municipality)=any(i.coverage_municipalities)) then 15 else 0 end+
       case when p_language is not null and lower(p_language)=any(select lower(x) from unnest(i.languages)x) then 10 else 0 end+
       case when p_population is not null and lower(p_population)=any(select lower(x) from unnest(i.populations)x) then 10 else 0 end+
       case when i.status='verified' then 10 else 0 end+
       case when p_urgency='emergency' and i.emergency_available then 20 else 0 end) as score
    from public.social_institutions i
    where i.active and i.status not in ('closed','archived')
      and (p_query is null or to_tsvector('spanish',coalesce(i.official_name,i.name,'')||' '||coalesce(i.description,'')||' '||array_to_string(i.services,' ')) @@ plainto_tsquery('spanish',p_query))
      and (p_state is null or upper(i.state_code)=upper(p_state) or upper(p_state)=any(i.coverage_states) or 'national'=any(i.coverage_levels) or i.remote_available)
      and (p_municipality is null or lower(i.municipality)=lower(p_municipality) or lower(p_municipality)=any(i.coverage_municipalities) or 'statewide'=any(i.coverage_levels) or 'national'=any(i.coverage_levels) or i.remote_available)
      and (p_service is null or p_service=any(i.services))
      and (p_language is null or lower(p_language)=any(select lower(x) from unnest(i.languages)x))
      and (p_population is null or lower(p_population)=any(select lower(x) from unnest(i.populations)x))
      and (p_cost_type is null or i.cost_type=p_cost_type)
      and (p_availability is null or i.capacity_status=p_availability)
      and (p_urgency is null or p_urgency<>'emergency' or i.emergency_available)
  )
  select r.id,coalesce(r.official_name,r.name),r.institution_type,r.services,r.description,r.state_code,r.municipality,
    case when r.location_confidential then null else r.address end,
    case when r.location_confidential then null else r.latitude end,
    case when r.location_confidential then null else r.longitude end,
    r.phone,r.whatsapp,r.email,r.website,r.hours,r.languages,r.populations,r.eligibility,r.required_documents,r.cost_type,
    r.appointment_required,r.walk_in_available,r.emergency_available,r.remote_available,r.referral_methods,r.coverage_levels,
    r.capacity_status,r.verification_status,r.verified_at,r.next_verification_at,r.status,r.km,r.score,
    array_remove(array[
      case when p_service is not null and p_service=any(r.services) then 'service_match' end,
      case when p_state is not null and (upper(r.state_code)=upper(p_state) or upper(p_state)=any(r.coverage_states)) then 'geographic_match' end,
      case when p_language is not null and lower(p_language)=any(select lower(x) from unnest(r.languages)x) then 'language_match' end,
      case when p_population is not null and lower(p_population)=any(select lower(x) from unnest(r.populations)x) then 'population_match' end,
      case when p_urgency='emergency' and r.emergency_available then 'emergency_available' end,
      case when r.status='verified' then 'verified_resource' end
    ],null)
  from ranked r
  where (p_radius_km is null or r.km is null or r.km<=p_radius_km)
  order by r.score desc,r.km nulls last,coalesce(r.official_name,r.name)
  limit least(greatest(p_limit,1),100)
$$;

revoke all on function public.search_resource_network(text,text,text,double precision,double precision,double precision,text,text,text,text,text,text,integer) from public,anon;
grant execute on function public.search_resource_network(text,text,text,double precision,double precision,double precision,text,text,text,text,text,text,integer) to authenticated;

create or replace function public.verify_resource(
  p_institution uuid,p_status text,p_source text,p_evidence_url text default null,p_notes text default null,p_next_verification timestamptz default null
) returns uuid language plpgsql security invoker set search_path=public as $$
declare i public.social_institutions%rowtype; v_id uuid;
begin
  select * into i from public.social_institutions where id=p_institution for update;
  if not found then raise exception 'Resource not found'; end if;
  if not (public.social_is_platform_admin(auth.uid()) or (i.org_id is not null and public.social_can_manage_org(i.org_id,auth.uid()))) then raise exception 'Resource verification denied'; end if;
  insert into public.resource_verifications(institution_id,org_id,status,source,evidence_url,notes,verified_by,next_verification_at)
  values(i.id,i.org_id,p_status,p_source,p_evidence_url,p_notes,auth.uid(),p_next_verification) returning id into v_id;
  update public.social_institutions set status=p_status,verification_status=p_status,verification_source=p_source,
    verification_evidence_url=p_evidence_url,verified_at=now(),verified_by=auth.uid(),next_verification_at=p_next_verification,
    approved_at=case when p_status='verified' then coalesce(approved_at,now()) else approved_at end,
    approved_by=case when p_status='verified' then coalesce(approved_by,auth.uid()) else approved_by end,updated_at=now()
  where id=i.id;
  return v_id;
end $$;

revoke all on function public.verify_resource(uuid,text,text,text,text,timestamptz) from public,anon;
grant execute on function public.verify_resource(uuid,text,text,text,text,timestamptz) to authenticated;

alter table public.social_referrals drop constraint if exists social_referrals_status_check;
alter table public.social_referrals add constraint social_referrals_status_check check(status in
 ('draft','awaiting_consent','sent','received','appointment_scheduled','in_progress','service_in_progress','completed','rejected','unable_to_contact','cancelled'));

insert into public.resource_service_categories(org_id,code,name_es,name_en,sort_order) values
 (null,'legal_aid','Asistencia jurídica','Legal aid',10),(null,'shelter','Albergue','Shelter',20),
 (null,'health','Salud','Health',30),(null,'mental_health','Salud mental','Mental health',40),
 (null,'social_support','Apoyo social','Social support',50),(null,'interpretation','Interpretación','Interpretation',60),
 (null,'court','Tribunales','Courts',70),(null,'notary','Notarías','Notaries',80),
 (null,'government','Instituciones públicas','Government agencies',90)
on conflict (org_id,code) do update set name_es=excluded.name_es,name_en=excluded.name_en,active=true;

comment on function public.search_resource_network is 'Neutral directory search only. Never accepts person, family, case, document, or client-identifying data.';
comment on column public.social_institutions.internal_notes is 'Organization-only operational knowledge; never include in public or referral payloads.';
comment on column public.social_institutions.location_confidential is 'General search suppresses address and coordinates for protected facilities.';

