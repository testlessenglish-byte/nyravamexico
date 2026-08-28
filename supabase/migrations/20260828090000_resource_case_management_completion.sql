-- Complete the existing Resource Network with case-linked communications and follow-up.
-- Reuses social cases, consents, documents, tasks, referrals, institutions and activity.

create table if not exists public.social_resource_communications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  social_case_id uuid not null references public.social_cases(id),
  institution_id uuid not null references public.social_institutions(id),
  referral_id uuid references public.social_referrals(id),
  sender_id uuid not null references auth.users(id),
  recipient text not null,
  subject text not null,
  communication_type text not null check (communication_type in ('email','message','phone','website_portal')),
  message text,
  document_ids uuid[] not null default '{}',
  consent_id uuid references public.social_consents(id),
  status text not null default 'draft' check (status in ('draft','sent','delivered','failed','attempted','completed')),
  delivery_detail text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.social_resource_communications enable row level security;
create index if not exists social_resource_communications_case_idx
  on public.social_resource_communications(social_case_id,created_at desc);

drop policy if exists social_resource_communications_read on public.social_resource_communications;
drop policy if exists social_resource_communications_insert on public.social_resource_communications;
drop policy if exists social_resource_communications_update on public.social_resource_communications;

create policy social_resource_communications_read on public.social_resource_communications
  for select to authenticated using (
    public.social_is_platform_admin(auth.uid()) or public.social_can_access_case(social_case_id,'general_case_record',false,auth.uid())
  );
create policy social_resource_communications_insert on public.social_resource_communications
  for insert to authenticated with check (
    sender_id=auth.uid() and public.social_can_access_case(social_case_id,'general_case_record',true,auth.uid())
  );
create policy social_resource_communications_update on public.social_resource_communications
  for update to authenticated using (
    sender_id=auth.uid() and public.social_can_access_case(social_case_id,'general_case_record',true,auth.uid())
  );

alter table public.social_referrals add column if not exists notes text;

create or replace function public.validate_social_resource_communication()
returns trigger language plpgsql security invoker set search_path=public as $$
declare
  c public.social_cases%rowtype;
  i public.social_institutions%rowtype;
  d uuid;
  allowed text[];
begin
  select * into c from public.social_cases where id=new.social_case_id;
  if not found or c.org_id<>new.org_id or not public.social_can_access_case(c.id,'general_case_record',true,auth.uid()) then
    raise exception 'Case access denied';
  end if;
  select * into i from public.social_institutions where id=new.institution_id and active;
  if not found then raise exception 'Resource not found'; end if;
  if new.communication_type='email' and (i.email is null or lower(i.email)<>lower(new.recipient)) then
    raise exception 'Recipient must be the resource verified email address';
  end if;

  if cardinality(new.document_ids)>0 or coalesce(new.message,'')<>'' then
    if new.consent_id is null then raise exception 'Consent required. Open Documents and Consent.'; end if;
    select cv.permitted_information into allowed
    from public.social_consents co join public.social_consent_versions cv
      on cv.consent_id=co.id and cv.version=co.current_version
    where co.id=new.consent_id and co.status='active'
      and (co.expires_at is null or co.expires_at>now())
      and (co.person_id=c.person_id or co.family_id=c.family_id)
      and ('referral'=any(cv.permitted_purpose) or 'resource_contact'=any(cv.permitted_purpose))
      and (i.id::text=any(cv.permitted_recipients) or coalesce(i.official_name,i.name)=any(cv.permitted_recipients));
    if allowed is null then raise exception 'Consent does not cover this resource contact. Open Documents and Consent.'; end if;
  end if;

  foreach d in array new.document_ids loop
    if not exists(select 1 from public.social_documents x where x.id=d and x.social_case_id=c.id
      and x.deleted_at is null and x.external_shareable and ('document'=any(allowed) or x.document_type=any(allowed))) then
      raise exception 'A selected document is unrelated, restricted, or not covered by consent';
    end if;
  end loop;
  return new;
end $$;

drop trigger if exists validate_social_resource_communication on public.social_resource_communications;
create trigger validate_social_resource_communication before insert or update
on public.social_resource_communications for each row execute function public.validate_social_resource_communication();

create or replace function public.log_social_resource_communication()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.status is distinct from old.status and new.status in ('sent','delivered','failed','attempted','completed') then
    insert into public.social_activity_events(org_id,social_case_id,actor_id,event_type,entity_type,entity_id,metadata)
    values(new.org_id,new.social_case_id,new.sender_id,'resource_communication_'||new.status,'resource_communication',new.id,
      jsonb_build_object('institution_id',new.institution_id,'referral_id',new.referral_id,'sender',new.sender_id,
        'recipient',new.recipient,'subject',new.subject,'communication_type',new.communication_type,
        'document_ids',new.document_ids,'status',new.status,'sent_at',new.sent_at));
  end if;
  return new;
end $$;
drop trigger if exists log_social_resource_communication on public.social_resource_communications;
create trigger log_social_resource_communication after update on public.social_resource_communications
for each row execute function public.log_social_resource_communication();

comment on table public.social_resource_communications is
  'Case-linked audit record for explicit resource contact; sending is never automatic.';
