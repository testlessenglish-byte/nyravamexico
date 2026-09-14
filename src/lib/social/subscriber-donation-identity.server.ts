import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { isOrgOwner } from "./org-membership.server";

export interface SubscriberDonationIdentityData {
  id?: string;
  orgId: string;
  subscriberUserId?: string;
  subscriberType: "individual" | "organization";
  legalName: string;
  razonSocial?: string | null;
  rfc: string;
  fiscalPostalCode: string;
  governmentIdType: "ine" | "passport_mx" | "passport_foreign" | "residence_card_mx";
  governmentIdMasked?: string | null;
  idVerificationStatus: "not_verified" | "pending" | "verified" | "mismatch" | "unable_to_verify";
  idVerificationDate?: string | null;
  idVerificationMethod?: string | null;
  idDocumentStoragePath?: string | null;
  rfcVerificationStatus: "not_verified" | "pending" | "verified" | "mismatch" | "unable_to_verify";
  rfcVerificationMethod?: string | null;
  rfcVerificationDate?: string | null;
  constanciaStoragePath?: string | null;
  externalFundraisingProvider: "gofundme" | "other" | "none";
  externalFundraisingUrl?: string | null;
  directBankEnabled: boolean;
  bankBeneficiaryName?: string | null;
  bankName?: string | null;
  bankClabeMasked?: string | null;
  privacyNoticeVersion: string;
  privacyNoticeAcceptedAt?: string | null;
  privacyNoticeAcceptedBy?: string | null;
  financialDonationsReadiness: "not_ready" | "verified_and_ready";
}

/**
 * Authoritatively verifies if user is the canonical primary subscriber/owner.
 */
export async function verifyPrimarySubscriber(
  supabase: SupabaseClient,
  orgId: string,
  userId: string
): Promise<boolean> {
  if (!orgId || !userId) return false;
  // Fail-closed: lookup errors throw instead of downgrading to "not owner by default".
  return isOrgOwner(supabase as unknown as { from: (t: string) => any }, orgId, userId);
}

/**
 * Masks RFC for presentation: e.g. XXXX••••••123
 */
export function maskRfc(rfc: string): string {
  if (!rfc) return "";
  const clean = rfc.trim().toUpperCase().replace(/[^A-Z0-9&Ñ]/g, "");
  if (clean.length < 4) return "••••";
  const prefix = clean.slice(0, Math.min(4, Math.floor(clean.length / 3)));
  const suffix = clean.slice(-3);
  return `${prefix}••••••${suffix}`;
}

/**
 * Masks Mexican 18-digit CLABE: e.g. •••• •••• •••• ••1234
 */
export function maskClabe(clabe: string): string {
  if (!clabe) return "";
  const clean = clabe.trim().replace(/\D/g, "");
  if (clean.length < 4) return "•••• •••• •••• ••••";
  const suffix = clean.slice(-4);
  return `•••• •••• •••• ••${suffix}`;
}

/**
 * Masks Government ID number: e.g. INE · ••••••7890
 */
export function maskId(idNumber: string, idType: string): string {
  if (!idNumber) return "";
  const clean = idNumber.trim();
  const suffix = clean.slice(-4);
  const typeLabel = idType.toUpperCase();
  return `${typeLabel} · ••••••${suffix}`;
}

/**
 * Evaluates readiness deterministically from canonical verification records.
 */
export function computeDonationReadiness(data: {
  isSubscriber: boolean;
  idVerificationStatus: string;
  rfcVerificationStatus: string;
  externalFundraisingUrl?: string | null;
  directBankEnabled: boolean;
  bankBeneficiaryName?: string | null;
  bankClabeMasked?: string | null;
  privacyNoticeAcceptedAt?: string | null;
}): "not_ready" | "verified_and_ready" {
  if (!data.isSubscriber) return "not_ready";
  if (data.idVerificationStatus !== "verified") return "not_ready";
  if (data.rfcVerificationStatus !== "verified") return "not_ready";
  if (!data.privacyNoticeAcceptedAt) return "not_ready";

  const hasExternalUrl = Boolean(data.externalFundraisingUrl && data.externalFundraisingUrl.trim().startsWith("http"));
  const hasBankDestination = Boolean(data.directBankEnabled && data.bankBeneficiaryName && data.bankClabeMasked);

  if (hasExternalUrl || hasBankDestination) {
    return "verified_and_ready";
  }

  return "not_ready";
}

/**
 * Sanitizes identity row before returning to client (masks sensitive fields).
 */
export function sanitizeSubscriberDonationIdentity(row: any): SubscriberDonationIdentityData {
  if (!row) {
    return {
      orgId: "",
      subscriberType: "organization",
      legalName: "",
      razonSocial: null,
      rfc: "",
      fiscalPostalCode: "",
      governmentIdType: "ine",
      governmentIdMasked: null,
      idVerificationStatus: "not_verified",
      idVerificationDate: null,
      idVerificationMethod: null,
      rfcVerificationStatus: "not_verified",
      rfcVerificationMethod: null,
      rfcVerificationDate: null,
      externalFundraisingProvider: "gofundme",
      externalFundraisingUrl: null,
      directBankEnabled: false,
      bankBeneficiaryName: null,
      bankName: null,
      bankClabeMasked: null,
      privacyNoticeVersion: "v2026.1_mx_arco",
      privacyNoticeAcceptedAt: null,
      financialDonationsReadiness: "not_ready",
    };
  }

  return {
    id: row.id,
    orgId: row.org_id,
    subscriberUserId: row.subscriber_user_id,
    subscriberType: row.subscriber_type || "organization",
    legalName: row.legal_name || "",
    razonSocial: row.razon_social || null,
    rfc: row.rfc ? maskRfc(row.rfc) : "",
    fiscalPostalCode: row.fiscal_postal_code || "",
    governmentIdType: row.government_id_type || "ine",
    governmentIdMasked: row.government_id_masked || null,
    idVerificationStatus: row.id_verification_status || "not_verified",
    idVerificationDate: row.id_verification_date || null,
    idVerificationMethod: row.id_verification_method || null,
    rfcVerificationStatus: row.rfc_verification_status || "not_verified",
    rfcVerificationMethod: row.rfc_verification_method || null,
    rfcVerificationDate: row.rfc_verification_date || null,
    externalFundraisingProvider: row.external_fundraising_provider || "gofundme",
    externalFundraisingUrl: row.external_fundraising_url || null,
    directBankEnabled: Boolean(row.direct_bank_enabled),
    bankBeneficiaryName: row.bank_beneficiary_name || null,
    bankName: row.bank_name || null,
    bankClabeMasked: row.bank_clabe_masked || (row.bank_clabe_encrypted ? "•••• •••• •••• ••••" : null),
    privacyNoticeVersion: row.privacy_notice_version || "v2026.1_mx_arco",
    privacyNoticeAcceptedAt: row.privacy_notice_accepted_at || null,
    financialDonationsReadiness: row.financial_donations_readiness || "not_ready",
  };
}
