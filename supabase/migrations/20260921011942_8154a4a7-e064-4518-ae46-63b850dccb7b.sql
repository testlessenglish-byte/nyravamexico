do $$
declare
  r record;
  new_qual text;
  new_check text;
  sql text;
begin
  for r in
    select schemaname, tablename, policyname, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and tablename in ('clients','reports','report_versions','canonical_analysis')
      and (coalesce(qual,'') ilike '%is_admin_tier(auth.uid())%'
        or coalesce(with_check,'') ilike '%is_admin_tier(auth.uid())%')
  loop
    new_qual := case when r.qual is null then null
      else replace(r.qual, 'is_admin_tier(auth.uid())', 'false') end;
    new_check := case when r.with_check is null then null
      else replace(r.with_check, 'is_admin_tier(auth.uid())', 'false') end;

    sql := format('alter policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
    if new_qual is not null then
      sql := sql || format(' using (%s)', new_qual);
    end if;
    if new_check is not null then
      sql := sql || format(' with check (%s)', new_check);
    end if;
    raise notice 'hardening %.% policy %', r.schemaname, r.tablename, r.policyname;
    execute sql;
  end loop;
end
$$;