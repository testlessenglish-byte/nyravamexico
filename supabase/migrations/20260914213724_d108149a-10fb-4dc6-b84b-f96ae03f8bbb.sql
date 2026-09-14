DROP FUNCTION IF EXISTS public.list_public_billing_plans();

CREATE FUNCTION public.list_public_billing_plans()
RETURNS TABLE(
  key text, label text, tagline text, features jsonb, price_cents integer,
  currency text, "interval" text, self_serve boolean, contact_url text,
  included_seats integer, per_seat_price_cents integer, sort_order integer,
  ai_requests_monthly integer, talk_to_case_monthly integer, case_limit integer,
  storage_gb_limit numeric, team_member_limit integer, byok_allowed boolean
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  -- Marketing fields + published plan allowances ONLY. Never returns
  -- stripe_price_id or internal notes.
  select p.key, p.label, p.tagline, p.features::jsonb, p.price_cents, p.currency,
         p."interval", p.self_serve, p.contact_url, p.included_seats,
         p.per_seat_price_cents, p.sort_order,
         p.ai_requests_monthly, p.talk_to_case_monthly, p.case_limit,
         p.storage_gb_limit::numeric, p.team_member_limit, p.byok_allowed
  from public.billing_plans p
  where p.active = true
  order by p.sort_order asc
$function$;

REVOKE ALL ON FUNCTION public.list_public_billing_plans() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_public_billing_plans() TO authenticated, service_role;