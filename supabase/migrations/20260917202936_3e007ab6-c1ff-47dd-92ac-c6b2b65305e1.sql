create or replace function public.global_legal_search(_query text, _user_id uuid default auth.uid(), _limit integer default 25)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  q text;
  uid uuid := auth.uid();
  cases_result jsonb;
  clients_result jsonb;
  documents_result jsonb;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF _user_id IS NOT NULL AND _user_id <> uid THEN
    RAISE EXCEPTION 'Not authorized to search on behalf of another user';
  END IF;

  q := trim(coalesce(_query, ''));
  IF length(q) < 1 THEN RETURN '{"cases":[],"clients":[],"documents":[]}'::jsonb; END IF;
  _limit := least(greatest(coalesce(_limit, 25), 1), 100);

  SELECT coalesce(jsonb_agg(row_to_json(r)), '[]'::jsonb) INTO cases_result
  FROM (
    SELECT c.id, c.name as title, c.jurisdiction, c.case_type::text as matter_type, c.status::text, c.updated_at
    FROM cases c
    WHERE (
      c.user_id = uid
      OR has_role(uid, 'admin')
      OR (c.firm_id IS NOT NULL AND is_member_of_firm(uid, c.firm_id))
    )
    AND (
      c.name ILIKE '%' || q || '%'
      OR c.jurisdiction ILIKE '%' || q || '%'
      OR c.description ILIKE '%' || q || '%'
    )
    ORDER BY c.updated_at DESC NULLS LAST
    LIMIT _limit
  ) r;

  SELECT coalesce(jsonb_agg(row_to_json(r)), '[]'::jsonb) INTO clients_result
  FROM (
    SELECT cl.id, cl.display_name, cl.client_type, cl.email, cl.status, cl.reference_number,
           (SELECT count(*) FROM cases cs WHERE cs.client_id = cl.id)::int as case_count
    FROM clients cl
    WHERE (
      cl.user_id = uid
      OR (cl.org_id IS NOT NULL AND is_org_member(uid, cl.org_id))
      OR is_admin_tier(uid)
    )
    AND (
      cl.display_name ILIKE '%' || q || '%'
      OR cl.legal_name ILIKE '%' || q || '%'
      OR cl.email ILIKE '%' || q || '%'
      OR cl.reference_number ILIKE '%' || q || '%'
      OR cl.rfc ILIKE '%' || q || '%'
    )
    ORDER BY cl.updated_at DESC NULLS LAST
    LIMIT _limit
  ) r;

  SELECT coalesce(jsonb_agg(row_to_json(r)), '[]'::jsonb) INTO documents_result
  FROM (
    SELECT d.id, d.filename, d.case_id, c.name as case_title
    FROM documents d
    JOIN cases c ON c.id = d.case_id
    WHERE (
      c.user_id = uid
      OR has_role(uid, 'admin')
      OR (c.firm_id IS NOT NULL AND is_member_of_firm(uid, c.firm_id))
    )
    AND d.filename ILIKE '%' || q || '%'
    ORDER BY d.created_at DESC
    LIMIT _limit
  ) r;

  RETURN jsonb_build_object('cases', cases_result, 'clients', clients_result, 'documents', documents_result);
END;
$function$;

revoke all on function public.global_legal_search(text, uuid, integer) from public;
revoke all on function public.global_legal_search(text, uuid, integer) from anon;
grant execute on function public.global_legal_search(text, uuid, integer) to authenticated;
grant execute on function public.global_legal_search(text, uuid, integer) to service_role;