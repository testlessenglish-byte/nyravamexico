do $preflight$
begin
  if to_regclass('public.social_cases') is null then
    raise exception 'Required table public.social_cases does not exist';
  end if;
  if to_regprocedure('public.social_can_manage_org(uuid,uuid)') is null then
    raise exception 'Required authorization helper public.social_can_manage_org(uuid,uuid) does not exist';
  end if;
end
$preflight$;
