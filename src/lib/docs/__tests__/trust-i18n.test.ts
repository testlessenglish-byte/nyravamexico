import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import es from "@/i18n/locales/es.json";
import en from "@/i18n/locales/en.json";

const root = process.cwd();
const trust = readFileSync(join(root, "src", "routes", "trust.tsx"), "utf8");
const search = readFileSync(join(root, "src", "components", "docs", "DocsSearchDialog.tsx"), "utf8");
const pipeline = readFileSync(join(root, "src", "components", "docs", "PipelineDiagram.tsx"), "utf8");

describe("Trust documentation localization", () => {
  it("keeps Spanish and English dictionaries in parity", () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
  });

  it("renders Trust Center content through the locale dictionary", () => {
    expect(trust).toContain('useI18n');
    expect(trust).toContain('t("trust.title")');
    expect(trust).not.toContain('title="Trust, security, and responsibility at Nyrava"');
  });

  it("localizes the documentation search popup and pipeline diagram", () => {
    expect(search).toContain('t("docsSearch.placeholder")');
    expect(search).toContain('descriptionEs');
    expect(pipeline).toContain('t(`pipelineDiagram.step${index + 1}`)');
    expect(pipeline).toContain('t("pipelineDiagram.caption")');
  });
});