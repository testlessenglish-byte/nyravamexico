DROP POLICY IF EXISTS plan_ent_read_authenticated ON public.plan_entitlements;
REVOKE ALL ON public.plan_entitlements FROM authenticated;
GRANT ALL ON public.plan_entitlements TO service_role;