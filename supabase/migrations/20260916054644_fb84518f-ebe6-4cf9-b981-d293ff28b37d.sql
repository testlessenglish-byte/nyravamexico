DROP POLICY IF EXISTS "Public can read opted-in super admin social profile" ON public.user_social_profiles;
REVOKE SELECT ON public.user_social_profiles FROM anon;