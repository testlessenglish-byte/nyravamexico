CREATE TABLE public.user_social_profiles (
  user_id uuid PRIMARY KEY,
  linkedin_url text,
  discord_url text,
  twitter_url text,
  facebook_url text,
  public_visible boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_social_profiles TO authenticated;
GRANT SELECT ON public.user_social_profiles TO anon;
GRANT ALL ON public.user_social_profiles TO service_role;

ALTER TABLE public.user_social_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read their own social profile"
ON public.user_social_profiles
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own social profile"
ON public.user_social_profiles
FOR INSERT
TO authenticated
WITH CHECK (
  auth.uid() = user_id
  AND (
    public_visible = false
    OR public.has_role(auth.uid(), 'super_admin'::public.app_role)
  )
);

CREATE POLICY "Users can update their own social profile"
ON public.user_social_profiles
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (
  auth.uid() = user_id
  AND (
    public_visible = false
    OR public.has_role(auth.uid(), 'super_admin'::public.app_role)
  )
);

CREATE POLICY "Users can delete their own social profile"
ON public.user_social_profiles
FOR DELETE
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Public can read opted-in super admin social profile"
ON public.user_social_profiles
FOR SELECT
TO anon
USING (
  public_visible = true
  AND public.has_role(user_id, 'super_admin'::public.app_role)
);

CREATE OR REPLACE FUNCTION public.set_user_social_profiles_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER set_user_social_profiles_updated_at
BEFORE UPDATE ON public.user_social_profiles
FOR EACH ROW
EXECUTE FUNCTION public.set_user_social_profiles_updated_at();