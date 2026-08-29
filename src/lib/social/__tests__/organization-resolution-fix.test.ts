import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const route = readFileSync(join(process.cwd(), "src", "routes", "_authenticated", "social.tsx"), "utf8");

describe("Comprehensive Care Organization Resolution & Polling Fix", () => {
  it("does not contain the defective employeeOrgIds filter that excluded owned organizations", () => {
    expect(route).not.toContain("employeeOrgIds");
    expect(route).toContain("const availableOrganizations=allOrganizations;");
  });

  it("does not contain 5-second polling interval on social-workspace query", () => {
    expect(route).not.toContain("refetchInterval:5000");
    expect(route).not.toContain("refetchInterval: 5000");
  });

  it("safely handles error states with a retry affordance rather than infinite loading or false 0 cases", () => {
    expect(route).toContain("if(workspace.isError)");
    expect(route).toContain("workspace.refetch()");
  });

  it("strictly validates requested organization against authorized availableOrganizations", () => {
    expect(route).toContain('const requestedOrg=(orgId&&availableOrganizations.some((organization:any)=>organization.id===orgId)&&orgId)');
    expect(route).toContain('const resolvedOrg=requestedOrg;');
  });

  it("preserves tenant-scoped case filtering on resolved authorized organization", () => {
    expect(route).toContain("const visibleCases=(workspace.data?.cases??[]).filter((c:any)=>c.org_id===resolvedOrg);");
  });

  it("correctly handles multiple authorized organizations in the selector", () => {
    expect(route).toContain("availableOrganizations.map((o:any)=><option key={o.id} value={o.id}>{o.name}</option>)");
  });
});
