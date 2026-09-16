GRANT INSERT, UPDATE ON public.case_finding_patches TO authenticated;

DROP POLICY IF EXISTS case_finding_patches_owner_insert ON public.case_finding_patches;
CREATE POLICY case_finding_patches_owner_insert
ON public.case_finding_patches
FOR INSERT
TO authenticated
WITH CHECK (
  user_id = auth.uid()
  AND private.owns_case(case_id)
);

DROP POLICY IF EXISTS case_finding_patches_owner_update ON public.case_finding_patches;
CREATE POLICY case_finding_patches_owner_update
ON public.case_finding_patches
FOR UPDATE
TO authenticated
USING (
  user_id = auth.uid()
  AND private.owns_case(case_id)
)
WITH CHECK (
  user_id = auth.uid()
  AND private.owns_case(case_id)
);

REVOKE ALL ON public.case_finding_patches FROM anon;