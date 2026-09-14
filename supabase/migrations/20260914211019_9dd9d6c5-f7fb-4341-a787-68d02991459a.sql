CREATE OR REPLACE FUNCTION public.list_public_billing_plans()
 RETURNS TABLE(key text, label text, tagline text, features jsonb, price_cents integer, currency text, "interval" text, self_serve boolean, contact_url text, included_seats integer, per_seat_price_cents integer, sort_order integer)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- Marketing fields ONLY. Never returns stripe_price_id, internal notes,
  -- quotas or limits. SECURITY DEFINER so signed-in non-admin users can see
  -- the plan catalogue (table RLS restricts direct reads to admins/anon).
  select p.key, p.label, p.tagline, p.features::jsonb, p.price_cents, p.currency,
         p."interval", p.self_serve, p.contact_url, p.included_seats,
         p.per_seat_price_cents, p.sort_order
  from public.billing_plans p
  where p.active = true
  order by p.sort_order asc
$function$;

REVOKE ALL ON FUNCTION public.list_public_billing_plans() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_public_billing_plans() TO authenticated, service_role;