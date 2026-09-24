CREATE TABLE public.report_chunk_caches (
  case_id uuid PRIMARY KEY REFERENCES public.cases(id) ON DELETE CASCADE,
  execution_id uuid NOT NULL,
  chunks jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.report_chunk_caches TO authenticated;
GRANT ALL ON public.report_chunk_caches TO service_role;

ALTER TABLE public.report_chunk_caches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authorized case users can view report chunk caches"
ON public.report_chunk_caches
FOR SELECT
TO authenticated
USING (public.can_access_case(auth.uid(), case_id));

CREATE POLICY "Authorized case users can create report chunk caches"
ON public.report_chunk_caches
FOR INSERT
TO authenticated
WITH CHECK (public.can_access_case(auth.uid(), case_id));

CREATE POLICY "Authorized case users can update report chunk caches"
ON public.report_chunk_caches
FOR UPDATE
TO authenticated
USING (public.can_access_case(auth.uid(), case_id))
WITH CHECK (public.can_access_case(auth.uid(), case_id));

CREATE POLICY "Authorized case users can delete report chunk caches"
ON public.report_chunk_caches
FOR DELETE
TO authenticated
USING (public.can_access_case(auth.uid(), case_id));

CREATE INDEX report_chunk_caches_execution_id_idx
ON public.report_chunk_caches (execution_id);

CREATE OR REPLACE FUNCTION public.touch_report_chunk_cache_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER touch_report_chunk_caches_updated_at
BEFORE UPDATE ON public.report_chunk_caches
FOR EACH ROW
EXECUTE FUNCTION public.touch_report_chunk_cache_updated_at();