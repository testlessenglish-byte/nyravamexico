-- Migration: Supabase Security Advisor Remediation
-- 1. Fix Critical Issue: Restrict internal knowledge-base storage bucket (social-knowledge-files) to authorized organization members and admins.
-- 2. Fix Warning: Revoke PUBLIC/anon EXECUTE access on SECURITY DEFINER functions in schema public.

BEGIN;

-- 1. Remediate Critical Storage Policy: social-knowledge-files
DROP POLICY IF EXISTS social_knowledge_files_read ON storage.objects;

CREATE POLICY social_knowledge_files_read ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'social-knowledge-files'
    AND EXISTS (
      SELECT 1 FROM public.resource_knowledge_records k
      WHERE k.document_path = name
        AND (
          k.org_id IS NULL
          OR public.is_org_member(auth.uid(), k.org_id)
          OR public.has_role(auth.uid(), 'admin')
          OR public.social_is_platform_admin(auth.uid())
        )
    )
  );

-- 2. Remediate Warning: Revoke PUBLIC / anon EXECUTE on SECURITY DEFINER functions
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon;

-- Grant EXECUTE strictly to authenticated & service_role on application functions
GRANT EXECUTE ON FUNCTION public.can_access_client(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_access_case(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.global_legal_search(text, uuid, int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated, service_role;

COMMIT;
