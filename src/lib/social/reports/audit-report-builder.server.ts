import { createHash, randomBytes } from "node:crypto";
import { isOrgOwner } from "../org-membership.server";

export async function verifyPrimarySubscriber(supabase: any, orgId: string, userId: string): Promise<boolean> {
  if (!orgId || !userId) return false;

  // Fail-closed: membership lookup errors throw rather than defaulting to false-positive access.
  return isOrgOwner(supabase, orgId, userId);
}

export function generateReportId(): string {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const rand = randomBytes(4).toString("hex").toUpperCase();
  return `NYR-RPT-${d}-${rand}`;
}

export function computeSha256(content: string | Buffer | object): string {
  const str = typeof content === "string" ? content : Buffer.isBuffer(content) ? content.toString("utf8") : JSON.stringify(content);
  return createHash("sha256").update(str).digest("hex");
}

export function filterByDateRange(records: any[], dateField: string, startDate?: string | null, endDate?: string | null): any[] {
  if (!records || !Array.isArray(records)) return [];
  if (!startDate && !endDate) return records;

  return records.filter((item) => {
    const raw = item[dateField] || item.created_at;
    if (!raw) return true;
    const itemDate = new Date(raw).toISOString().slice(0, 10);
    if (startDate && itemDate < startDate) return false;
    if (endDate && itemDate > endDate) return false;
    return true;
  });
}

export function computeAuditSummary(dataset: any) {
  const cases = dataset.cases || [];
  const interventions = dataset.interventions || [];
  const referrals = dataset.referrals || [];
  const tasks = dataset.tasks || [];
  const campaigns = dataset.campaigns || [];
  const offers = dataset.offers || [];

  const activeCases = cases.filter((c: any) => !["closed", "archived", "transferred"].includes(c.status));
  const closedCases = cases.filter((c: any) => c.status === "closed");
  const highRiskCases = cases.filter((c: any) => c.risk_level === "high" || c.risk_level === "critical");

  const completedReferrals = referrals.filter((r: any) => r.status === "completed");
  const completedTasks = tasks.filter((t: any) => t.status === "done" || t.status === "completed");
  const nowStr = new Date().toISOString().slice(0, 10);
  const overdueTasks = tasks.filter((t: any) => (t.status === "todo" || t.status === "in_progress") && t.due_date && t.due_date < nowStr);

  const goodsOffers = offers.filter((o: any) => o.offer_type === "goods");
  const receivedGoods = goodsOffers.filter((o: any) => o.status === "received");
  const serviceOffers = offers.filter((o: any) => o.offer_type === "service");

  let totalFinancialTarget = 0;
  for (const camp of campaigns) {
    if (camp.financial_target_amount) {
      totalFinancialTarget += Number(camp.financial_target_amount);
    }
  }

  // User activity breakdown
  const userActivityMap: Record<string, { userId: string; assignedCases: number; interventions: number; referrals: number; tasks: number }> = {};
  for (const c of cases) {
    if (c.assigned_case_manager) {
      userActivityMap[c.assigned_case_manager] = userActivityMap[c.assigned_case_manager] || { userId: c.assigned_case_manager, assignedCases: 0, interventions: 0, referrals: 0, tasks: 0 };
      userActivityMap[c.assigned_case_manager].assignedCases++;
    }
  }
  for (const inv of interventions) {
    const uid = inv.social_case_id; // worker or actor
    if (uid) {
      userActivityMap[uid] = userActivityMap[uid] || { userId: uid, assignedCases: 0, interventions: 0, referrals: 0, tasks: 0 };
      userActivityMap[uid].interventions++;
    }
  }
  for (const ref of referrals) {
    const uid = ref.created_by;
    if (uid) {
      userActivityMap[uid] = userActivityMap[uid] || { userId: uid, assignedCases: 0, interventions: 0, referrals: 0, tasks: 0 };
      userActivityMap[uid].referrals++;
    }
  }

  return {
    casesCount: cases.length,
    activeCasesCount: activeCases.length,
    closedCasesCount: closedCases.length,
    highRiskCasesCount: highRiskCases.length,
    interventionsCount: interventions.length,
    referralsCount: referrals.length,
    completedReferralsCount: completedReferrals.length,
    tasksCount: tasks.length,
    completedTasksCount: completedTasks.length,
    overdueTasksCount: overdueTasks.length,
    campaignsCount: campaigns.length,
    totalFinancialTarget,
    goodsPledgedCount: goodsOffers.length,
    goodsReceivedCount: receivedGoods.length,
    serviceOffersCount: serviceOffers.length,
    userActivity: Object.values(userActivityMap),
  };
}
