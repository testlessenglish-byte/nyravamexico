CREATE TABLE IF NOT EXISTS public.admin_notifications (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  title text NOT NULL,
  body text NOT NULL,
  link text,
  is_read boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.admin_notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Super admins can view notifications" ON public.admin_notifications FOR SELECT USING (public.is_super_admin(auth.uid()));
CREATE POLICY "Super admins can update notifications" ON public.admin_notifications FOR UPDATE USING (public.is_super_admin(auth.uid()));
CREATE POLICY "Service role can insert notifications" ON public.admin_notifications FOR INSERT WITH CHECK (true);
