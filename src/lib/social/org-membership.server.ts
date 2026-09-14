/**
 * Canonical organization membership lookup.
 *
 * The legacy code referenced a non-existent `organization_members` table, which
 * made every role check silently return "no row" and then fall back to a
 * hard-coded role. The real membership table is `org_memberships`
 * (org_id, user_id, role_in_org, status, deleted_at).
 *
 * Every helper here is FAIL-CLOSED: a query error throws, and a missing or
 * inactive membership resolves to `null` (no role) rather than a default role.
 */

type AnySupabase = {
  from: (table: string) => any;
};

export class OrgMembershipLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrgMembershipLookupError";
  }
}

/**
 * Returns the caller's active role in the organization, or null when there is
 * no active membership. Throws when the lookup itself fails.
 */
export async function getOrgMembershipRole(
  supabase: AnySupabase,
  orgId: string | null | undefined,
  userId: string | null | undefined,
): Promise<string | null> {
  if (!orgId || !userId) return null;

  const res = await supabase
    .from("org_memberships")
    .select("role_in_org,status,deleted_at")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .eq("status", "active")
    .maybeSingle();

  if (res.error) {
    throw new OrgMembershipLookupError(
      "No se pudo verificar la membresía de la organización / Unable to verify organization membership",
    );
  }

  const role = res.data?.role_in_org;
  return role ? String(role).toLowerCase() : null;
}

/**
 * Returns the caller's single active organization, or null when they belong to
 * none. Throws when the lookup itself fails.
 */
export async function getPrimaryOrgIdForUser(
  supabase: AnySupabase,
  userId: string | null | undefined,
): Promise<string | null> {
  if (!userId) return null;

  const res = await supabase
    .from("org_memberships")
    .select("org_id")
    .eq("user_id", userId)
    .is("deleted_at", null)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (res.error) {
    throw new OrgMembershipLookupError(
      "No se pudo determinar la organización del usuario / Unable to resolve the user's organization",
    );
  }

  return res.data?.org_id ?? null;
}

/**
 * True only when the user is the organization creator or holds an owner-level
 * active membership. Fail-closed on lookup errors.
 */
export async function isOrgOwner(
  supabase: AnySupabase,
  orgId: string | null | undefined,
  userId: string | null | undefined,
): Promise<boolean> {
  if (!orgId || !userId) return false;

  const orgRes = await supabase
    .from("organizations")
    .select("created_by")
    .eq("id", orgId)
    .maybeSingle();

  if (orgRes.error) {
    throw new OrgMembershipLookupError(
      "No se pudo verificar la organización / Unable to verify the organization",
    );
  }

  if (orgRes.data?.created_by === userId) return true;

  const role = await getOrgMembershipRole(supabase, orgId, userId);
  return role === "owner" || role === "organization_owner";
}
