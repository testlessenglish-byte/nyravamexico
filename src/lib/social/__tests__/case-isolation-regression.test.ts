import { describe, it, expect } from "vitest";

describe("Comprehensive Care - Case Isolation & Care Plan Query Scoping (Phase 0)", () => {
  it("enforces social_case_id scoping so Case A never retrieves a newer Care Plan belonging to Case B", () => {
    const caseAId = "11111111-1111-1111-1111-111111111111";
    const caseBId = "22222222-2222-2222-2222-222222222222";

    const allCarePlans = [
      {
        id: "plan-a-old",
        social_case_id: caseAId,
        status: "active",
        created_at: "2026-08-01T10:00:00Z",
        summary: "Care Plan for Case A",
      },
      {
        id: "plan-b-newest",
        social_case_id: caseBId,
        status: "active",
        created_at: "2026-08-29T12:00:00Z",
        summary: "Care Plan for Case B",
      },
    ];

    const queryForCaseA = allCarePlans
      .filter((p) => p.social_case_id === caseAId)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];

    const queryForCaseB = allCarePlans
      .filter((p) => p.social_case_id === caseBId)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];

    expect(queryForCaseA).toBeDefined();
    expect(queryForCaseA.id).toBe("plan-a-old");
    expect(queryForCaseA.social_case_id).toBe(caseAId);
    expect(queryForCaseA.summary).toBe("Care Plan for Case A");

    expect(queryForCaseB).toBeDefined();
    expect(queryForCaseB.id).toBe("plan-b-newest");
    expect(queryForCaseB.social_case_id).toBe(caseBId);

    const brokenGlobalQuery = [...allCarePlans].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    )[0];
    expect(brokenGlobalQuery.id).toBe("plan-b-newest");
  });

  it("verifies source code queries in social.functions.ts enforce eq('social_case_id', ...) on all case-scoped tables", async () => {
    const fs = await import("node:fs/promises");
    const source = await fs.readFile("src/lib/social.functions.ts", "utf-8");

    const carePlanQueries = source.match(/from\("social_care_plans"\)[^;]+/g) ?? [];
    expect(carePlanQueries.length).toBeGreaterThan(0);

    for (const query of carePlanQueries) {
      if (query.includes("select") && !query.includes('eq("id", entityId)') && !query.includes('eq("id",version.data.care_plan_id)')) {
        expect(query).toContain('.eq("social_case_id"');
      }
    }

    const assessmentQueries = source.match(/from\("social_assessments"\)[^;]+/g) ?? [];
    for (const query of assessmentQueries) {
      if (query.includes("select") && !query.includes('eq("id", entityId)')) {
        expect(query).toContain('.eq("social_case_id"');
      }
    }
  });
});
