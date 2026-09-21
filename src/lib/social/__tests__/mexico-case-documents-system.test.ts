import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MEXICO_TEMPLATES, findTemplateByCode, getTemplatesByCategory,
} from "../templates/mexico-template-definitions";
import {
  extractAuthorizedCaseContext, generateCaseDocumentPdf, prefillTemplate,
} from "../templates/document-engine";

const root = process.cwd();
const migration = readFileSync(join(root, "supabase", "migrations", "20260828200000_mexico_case_documents_and_templates.sql"), "utf8");
const documentCenterSource = readFileSync(join(root, "src", "components", "social", "CaseDocumentCenter.tsx"), "utf8");
const editorModalSource = readFileSync(join(root, "src", "components", "social", "CaseDocumentEditorModal.tsx"), "utf8");
const workspaceSource = readFileSync(join(root, "src", "components", "social", "SocialCaseWorkspace.tsx"), "utf8");
const talkToCareCaseSource = readFileSync(join(root, "src", "components", "social", "TalkToCareCase.tsx"), "utf8");
const functionsSource = readFileSync(join(root, "src", "lib", "social.functions.ts"), "utf8");

describe("Mexico Case Forms & Document System", () => {
  it("defines all required Mexican template categories and templates in the registry", () => {
    expect(MEXICO_TEMPLATES.length).toBeGreaterThanOrEqual(10);
    const categories = new Set(MEXICO_TEMPLATES.map((t) => t.category));
    expect(categories.has("intake")).toBe(true);
    expect(categories.has("consent")).toBe(true);
    expect(categories.has("risk_safety")).toBe(true);
    expect(categories.has("housing")).toBe(true);
    expect(categories.has("psychosocial")).toBe(true);
    expect(categories.has("legal")).toBe(true);
    expect(categories.has("family_children")).toBe(true);
    expect(categories.has("health")).toBe(true);
    expect(categories.has("immigration_refugee")).toBe(true);
    expect(categories.has("general_assistance")).toBe(true);

    expect(findTemplateByCode("mex_ficha_ingreso")).toBeDefined();
    expect(findTemplateByCode("mex_derivacion_vivienda")).toBeDefined();
    expect(findTemplateByCode("mex_derivacion_psicologia")).toBeDefined();
    expect(findTemplateByCode("mex_derivacion_juridica")).toBeDefined();
    expect(findTemplateByCode("mex_derivacion_dif_familia")).toBeDefined();
    expect(findTemplateByCode("mex_derivacion_salud")).toBeDefined();
    expect(findTemplateByCode("mex_derivacion_comar_migracion")).toBeDefined();
    expect(findTemplateByCode("mex_plan_seguridad")).toBeDefined();
    expect(findTemplateByCode("mex_consentimiento_compartir")).toBeDefined();
  });

  it("extracts authorized case context without hallucinating missing facts", () => {
    const context = extractAuthorizedCaseContext({
      caseRecord: { id: "11111111-1111-4111-8111-111111111111", case_number: "EXP-2026-0042", priority: "urgent" },
      person: { id: "22222222-2222-4222-8222-222222222222", legal_name: "María Gómez", phone: "5512345678" },
      householdMembers: [{ name: "Juan Gómez", is_minor: true }],
      riskAssessment: { risk_level: "high", protective_factors: "Red comunitaria activa" },
      carePlan: { presenting_needs: "Vivienda segura y asesoría jurídica" },
      worker: { name: "Lic. Ana Pérez", contact: "Trabajadora Social" },
    });

    expect(context["case.number"]).toBe("EXP-2026-0042");
    expect(context["client.full_name"]).toBe("María Gómez");
    expect(context["client.phone"]).toBe("5512345678");
    expect(context["client.email"]).toBe("No registrado");
    expect(context["risk.current_level"]).toBe("high");
    expect(context["household.composition"]).toContain("1 menor(es) de edad");
    expect(context["case.worker_contact"]).toContain("Lic. Ana Pérez");
  });

  it("pre-fills templates with field-level classification (auto_filled, needs_completion, optional)", () => {
    const template = findTemplateByCode("mex_derivacion_vivienda")!;
    const context = extractAuthorizedCaseContext({
      caseRecord: { id: "11111111-1111-4111-8111-111111111111", case_number: "EXP-2026-0042" },
      person: { id: "22222222-2222-4222-8222-222222222222", legal_name: "María Gómez" },
      worker: { name: "Lic. Ana Pérez" },
    });

    const prefilled = prefillTemplate(template, context, "es");
    expect(prefilled.values.case_number).toBe("EXP-2026-0042");
    expect(prefilled.values.client_name).toBe("María Gómez");
    expect(prefilled.fieldStatus.case_number).toBe("auto_filled");
    expect(prefilled.fieldStatus.housing_situation).toBe("needs_completion");
  });

  it("protects minimum necessary disclosure and separates legal/psychosocial from housing", () => {
    const housingTemplate = findTemplateByCode("mex_derivacion_vivienda")!;
    const psychTemplate = findTemplateByCode("mex_derivacion_psicologia")!;
    const legalTemplate = findTemplateByCode("mex_derivacion_juridica")!;

    const housingKeys = housingTemplate.fields.map((f) => f.key);
    expect(housingKeys).not.toContain("presenting_symptoms");
    expect(housingKeys).not.toContain("summary_of_facts");
    expect(housingKeys).not.toContain("court_or_authority");

    const psychKeys = psychTemplate.fields.map((f) => f.key);
    expect(psychKeys).toContain("presenting_symptoms");
    expect(psychKeys).toContain("urgency_level");

    const legalKeys = legalTemplate.fields.map((f) => f.key);
    expect(legalKeys).toContain("legal_matter_type");
    expect(legalKeys).toContain("summary_of_facts");
  });

  it("defines migration for social_case_templates and enhanced social_documents schema", () => {
    expect(migration).toContain("create table if not exists public.social_case_templates");
    expect(migration).toContain("alter table public.social_case_templates enable row level security");
    expect(migration).toContain("add column if not exists template_id uuid");
    expect(migration).toContain("add column if not exists template_code text");
    expect(migration).toContain("add column if not exists lifecycle_status text");
    expect(migration).toContain("add column if not exists draft_payload jsonb");
    expect(migration).toContain("add column if not exists recipient_info jsonb");
    expect(migration).toContain("add column if not exists disclosure_check jsonb");
    expect(migration).toContain("public.social_document_inventory");
  });

  it("integrates CaseDocumentCenter directly inside Documents tab without new top-level tabs", () => {
    expect(workspaceSource).toContain("<CaseDocumentCenter");
    expect(documentCenterSource).toContain("CaseDocumentCenter");
    expect(documentCenterSource).toContain("MEXICO_TEMPLATES");
    expect(documentCenterSource).toContain("Borradores");
    expect(documentCenterSource).toContain("Enviados");
    expect(documentCenterSource).toContain("Finalizados");
  });

  it("integrates Consent Disclosure Check and controlled Email sending", () => {
    expect(editorModalSource).toContain("Consentimiento de divulgación verificado");
    expect(editorModalSource).toContain("Enviar por Correo");
    expect(functionsSource).toContain("export const sendCaseDocumentEmail");
    expect(functionsSource).toContain("El consentimiento seleccionado no está activo o ha expirado");
  });

  it("integrates CASE DOCUMENTS section and preparation actions into Talk to Care Case", () => {
    expect(talkToCareCaseSource).toContain("DOCUMENTOS Y FORMATOS DEL CASO");
    expect(talkToCareCaseSource).toContain("mex_derivacion_vivienda");
    expect(talkToCareCaseSource).toContain("mex_derivacion_psicologia");
    expect(talkToCareCaseSource).toContain("mex_plan_seguridad");
    expect(talkToCareCaseSource).toContain("Preparar borrador");
  });

  it("generates professional PDF with header, field tables, and minimum necessary disclosure notice", () => {
    const template = findTemplateByCode("mex_derivacion_vivienda")!;
    const pdfBytes = generateCaseDocumentPdf(
      template,
      {
        case_number: "EXP-2026-0042",
        client_name: "María Gómez",
        housing_situation: "Sin vivienda estable",
        specific_housing_need: "emergency_shelter",
        household_members: "1 adulto, 1 menor",
        worker_contact: "Lic. Ana Pérez",
      },
      {
        organization: "Albergue DIF Municipal",
        contact_name: "Lic. Roberto Soto",
        email: "dif@municipio.gob.mx",
      },
      "es"
    );

    expect(pdfBytes).toBeDefined();
    expect(pdfBytes.byteLength).toBeGreaterThan(500);
  });
});
