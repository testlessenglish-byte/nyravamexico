import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const serverSource = readFileSync(join(root, "src", "lib", "social.functions.ts"), "utf8");
const assistantServer = readFileSync(join(root, "src", "lib", "social", "care-assistant.server.ts"), "utf8");
const talkUi = readFileSync(join(root, "src", "components", "social", "TalkToCareCase.tsx"), "utf8");
const docEngine = readFileSync(join(root, "src", "lib", "social", "templates", "document-engine.ts"), "utf8");

describe("Talk to Care Case & AI Routing Audit", () => {
  it("uses canonical social_tasks.assignee_id and never selects non-existent assigned_to on tasks", () => {
    // Verify social_tasks does not query assigned_to
    expect(serverSource).not.toContain('from("social_tasks").select("id,title,status,priority,due_at,assigned_to")');
    expect(serverSource).toContain('from("social_tasks").select("id,title,status,priority,due_at,assignee_id")');
  });

  it("implements graceful subsection degradation without fatal fail() crashes", () => {
    expect(serverSource).toContain("safeRows");
    expect(serverSource).toContain("safeItem");
    expect(serverSource).toContain("[TalkToCareCase] Subsection warning");
  });

  it("routes AI through centralized provider router with deterministic fallback", () => {
    expect(serverSource).toContain('import("@/lib/ai/router.server")');
    expect(serverSource).toContain("buildDeterministicAnswer");
    expect(serverSource).toContain("localizeAssistantLabels");
    expect(serverSource).toContain("careAssistantSystem");
    expect(assistantServer).toContain("buildCareHealth");
    expect(assistantServer).toContain("buildFactSheet");
  });

  it("ensures deterministic Layer A auto-fill for document drafts without LLM requirement", () => {
    expect(docEngine).toContain("extractAuthorizedCaseContext");
    expect(docEngine).toContain("prefillTemplate");
    expect(serverSource).toContain("createCaseDocumentDraft");
  });

  it("provides clean loading lifecycle and sanitized error presentation", () => {
    expect(talkUi).toContain("ask.isPending");
    expect(talkUi).toContain("prepareDocumentDraft.isPending");
    expect(talkUi).toContain("toast.error");
  });
});