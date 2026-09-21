do $$
declare
  r record;
  new_qual text;
  new_check text;
  sql text;
  admin_pat text := '(private\.)?has_role\(auth\.uid\(\),\s*''admin''::app_role\)';
begin
  for r in
    select schemaname, tablename, policyname, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and (coalesce(qual,'') ~ admin_pat or coalesce(with_check,'') ~ admin_pat)
      and (
        coalesce(qual,'') || coalesce(with_check,'') ilike '%user_id = auth.uid()%'
        or coalesce(qual,'') || coalesce(with_check,'') ilike '%auth.uid() = user_id%'
        or coalesce(qual,'') || coalesce(with_check,'') ilike '%owns_case%'
        or coalesce(qual,'') || coalesce(with_check,'') ilike '%c.user_id = auth.uid()%'
      )
  loop
    new_qual := case when r.qual is null then null
                     else regexp_replace(r.qual, admin_pat, 'false', 'g') end;
    new_check := case when r.with_check is null then null
                      else regexp_replace(r.with_check, admin_pat, 'false', 'g') end;

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