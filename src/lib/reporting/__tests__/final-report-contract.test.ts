import { describe, it, expect, vi } from "vitest";
import { resolveReportGovernance } from "../../intelligence/concluded-case-governance";
import { loadResolvedReportGovernance } from "../../intelligence/concluded-case-governance.server";
import { normalizeCanonicalSources } from "../../intelligence/canonical-source-identity";
import { validateReincidenciaEvidence } from "../../intelligence/reincidencia-evidence";
import { composeFinalReportPayload, releaseFinalReportPayload, validateFinalReportContract } from "../final-report-contract";
import { constitutionalAnalysisNotApplicable } from "../report-language-fallback";
import type { CaseExportData } from "../../export";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const rendered = vi.hoisted(() => ({pdf:null as ArrayBuffer|null}));
vi.mock("jspdf", async (original) => {
  const actual = await original<typeof import("jspdf")>();
  function Pdf(options:any) {
    const pdf = new actual.jsPDF(options);
    pdf.save = (() => { rendered.pdf = pdf.output("arraybuffer"); return pdf; }) as typeof pdf.save;
    return pdf;
  }
  Object.assign(Pdf, actual.jsPDF);
  return {...actual,default:Pdf};
});

/** Synthetic regression based on the reported ADR symptoms, NOT a real case replay. */
export function regressionInput(): CaseExportData {
  const source = normalizeCanonicalSources([{id:"doc-1", filename:"2_314174_7540_firmado.pdf"}]).canonical_sources[0];
  source.source_aliases.push("314174 7540 firmado");
  const quote = "Se desecha el recurso de revisión y queda firme la sentencia recurrida";
  const ref = {document_id:"doc-1", canonical_source_id:source.canonical_source_id, page:1, quote};
  const item = {id:"holding",kind:"COURT_HOLDING",text:quote,speaker_role:"scjn",adoption_status:"adopted",source_refs:[ref]};
  return {
    case:{case_analysis_mode:"concluded_audit",case_type:"penal", name:"Synthetic concluded judgment"},
    documents:[{id:"doc-1",filename:source.original_filename}],analysis:null,agents:[],score:null,
    report:{report_mode:"LIMITED",scores_suppressed:true,motions_suppressed:true, full_report:{
      source_audit:{canonical_sources:[source]},
      mandatory_decision_core:{items:[
        {...item,id:"disposition",kind:"DISPOSITION",text:"Se desecha el recurso de revisión"},
        item,
        {...item,id:"effect",kind:"REMEDY",text:"Queda firme la sentencia recurrida"},
      ]},
    }},
    findings:[
      {id:"recidivism",title:"Reincidencia",category:"reincidencia",severity:"high",description:"Condenado por secuestro exprés agravado",evidence_refs:[{...ref,quote:"Condenado por secuestro exprés agravado"}]},
      {id:"f-holding",mandatory_decision_core_id:"holding",mandatory_decision_kind:"COURT_HOLDING",
        title:quote,description:quote,category:"holding",severity:"low",speaker_role:"tribunal_colegiado",
        adoption_status:"adopted",proposition_type:"holding", evidence_refs:[
          {...ref,filename:"314174 7540 firmado"}, {...ref,filename:"2_314174_7540_firmado.pdf"},
        ]},
    ],
  };
}

describe("seven final report contract regressions", () => {
  it("1 — concluded resolver uses authoritative context and fails closed on database error", async () => {
    for (const context of [{case_analysis_mode:"concluded_audit"}, {procedural_posture:"concluded"}, {procedural_posture:{case_status:"concluded"}}]) {
      expect(resolveReportGovernance(context)).toMatchObject({
        is_concluded:true,governance_mode:"concluded_decision_audit",strategy_output_allowed:false,
        recommendation_policy:"verification_only",decision_core_priority:true,speaker_role_labels_required:true,
        post_judgment_strategy_allowed:false,final_governance_validation_required:true,
      });
    }
    expect(resolveReportGovernance({case_analysis_mode:"post_judgment_options_analysis"}).governance_mode).toBe("post_judgment_options");
    expect(resolveReportGovernance({case_analysis_mode:"concluded_audit", post_judgment_options_analysis:true}).strategy_output_allowed).toBe(true);
    const query:any={select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),maybeSingle:vi.fn().mockResolvedValue({data:null,error:{message:"query failed"}})};
    await expect(loadResolvedReportGovernance({from:()=>query} as any,"case")).rejects.toThrow("CONTEXT_UNAVAILABLE");
    expect(query.select).toHaveBeenCalledWith("case_analysis_mode,analysis_mode,matter_metadata");
    query.maybeSingle.mockResolvedValue({data:{case_analysis_mode:"concluded_audit"},error:null});
    expect((await loadResolvedReportGovernance({from:()=>query} as any,"case")).is_concluded).toBe(true);
  });
  it("2 — LIMITED renders only documentary verification actions", () => {
    const input=regressionInput();
    input.report!.next_actions=[{action:"Interponer recurso"}];
    input.findings![1].canonical_actions=["Promover incidente de nulidad"];
    const payload=releaseFinalReportPayload(input);
    const cards=payload.report_presentation.finding_cards;
    expect(cards.some(c=>c.details.actions.length>0)).toBe(true);
    for (const c of cards) expect(c.details.actions_title).toBe("PASOS DE VERIFICACIÓN DOCUMENTAL");
    expect(JSON.stringify(payload)).not.toContain("PRÓXIMAS ACCIONES RECOMENDADAS");
    expect(JSON.stringify(payload)).not.toContain("Promover incidente");
    expect(Object.isFrozen(payload.report_presentation)).toBe(true);
  });
  it("3 — two citation aliases count as one canonical source everywhere", () => {
    const payload=releaseFinalReportPayload(regressionInput());
    expect(payload.documents).toHaveLength(1);
    expect(payload.report_presentation.unique_source_count).toBe(1);
    const card=payload.report_presentation.finding_cards[0];
    expect(card.source_count).toBe(1);
    expect(card.details.synthesis?.docs).toHaveLength(1);
    expect(card.finding.evidence_refs).toHaveLength(2);
    const bad=structuredClone(payload);
    bad.report_presentation.finding_cards[0].source_count=2;
    expect(validateFinalReportContract(bad).ok).toBe(false);
  });
  it("4 — concluded composition starts with disposition ahead of severity-ranked findings", () => {
    const payload=releaseFinalReportPayload(regressionInput());
    expect(payload.report_presentation.decision_sections.map(s=>s.kind)).toEqual(["DISPOSITION","COURT_HOLDING","REMEDY"]);
    const bad=structuredClone(payload);
    bad.report_presentation.decision_sections.reverse();
    expect(validateFinalReportContract(bad).blocking_errors).toContain("decisionCoreFirst");
  });
  it("4b — accepts the earliest available verified decision-core kind when disposition is absent", () => {
    const input=regressionInput();
    const full=input.report!.full_report as any;
    full.mandatory_decision_core.items=full.mandatory_decision_core.items.filter((item:any)=>item.kind!=="DISPOSITION"&&item.kind!=="REMEDY");
    const payload=composeFinalReportPayload(input);
    expect(payload.report_presentation.decision_sections.map(s=>s.kind)).toEqual(["COURT_HOLDING"]);
    expect(validateFinalReportContract(payload).blocking_errors).not.toContain("decisionCoreFirst");
  });
  it("4c — localizes the non-applicable constitutional fallback before persistence", () => {
    expect(constitutionalAnalysisNotApplicable("es")).not.toMatch(/\bEvidence\b/i);
    expect(constitutionalAnalysisNotApplicable("es")).toContain("evidencia suficiente");
    expect(constitutionalAnalysisNotApplicable("en")).toMatch(/^Insufficient evidence/);
  });
  it("5 — verified SCJN decision core overrides an older merged speaker", () => {
    const payload=releaseFinalReportPayload(regressionInput());
    expect(payload.findings![0].speaker_role).toBe("scjn");
    expect(payload.findings![0].speaker_role_label).toContain("SCJN");
  });
  it("6 — aggravated kidnapping alone never establishes reincidencia", () => {
    const input=regressionInput();
    expect(validateReincidenciaEvidence(input.findings![0])).toMatchObject({category:"unsupported_reincidencia",attorney_review_required:true,report_suppressed:true});
    expect(releaseFinalReportPayload(input).findings).toHaveLength(1);
    const prior="Sentencia condenatoria anterior firme de fecha 1 de enero de 2020";
    const supported:Record<string,any>={...input.findings![0],evidence_refs:[{document_id:"prior",page:1,quote:prior}],
      reincidencia_evidence:{prior_conviction_quote:prior,prior_conviction_id:"prior",applicable_rule:"Rule supplied and verified by counsel",legally_relevant_antecedent_verified:true}};
    expect(validateReincidenciaEvidence(supported).category).toBe("reincidencia");
  });
  it("7 — release gate scans the final nested renderer payload", () => {
    const payload=composeFinalReportPayload(regressionInput());
    payload.report_presentation.finding_cards[0].details.actions_title="PRÓXIMAS ACCIONES RECOMENDADAS";
    expect(validateFinalReportContract(payload).blocking_errors).toContain("prohibitedStrategicHeadingsPresent");
    payload.report_presentation.finding_cards[0].details.actions_title="PASOS DE VERIFICACIÓN DOCUMENTAL";
    payload.report_presentation.finding_cards[0].details.actions.push("Interponer recurso de revisión");
    expect(validateFinalReportContract(payload).blocking_errors).toContain("verificationStepsOnly");
    (payload.report!.full_report as any).late_section={recommended_motions:[{title:"Motion"}],success_probability:0.9,case_strength_score:90};
    expect(validateFinalReportContract(payload).blocking_errors).toEqual(expect.arrayContaining(["scoresPresent","probabilitiesPresent","recommendedMotionsPresent"]));
  });
});

describe("actual renderer boundary", () => {
  it("PDF prints decision core, one source and verification-only actions", async () => {
    const {downloadPdf} = await import("../../export");
    const input=regressionInput();
    input.case!.report_language="es";
    input.report!.generated_language="es";
    await downloadPdf(input,"Synthetic regression");
    expect(rendered.pdf).not.toBeNull();
    const {extractText}=await import("unpdf");
    const result=await extractText(new Uint8Array(rendered.pdf!.slice(0)),{mergePages:true});
    expect(result.text).toContain("RESULTADO DEL RECURSO");
    expect(result.text).toContain("PASOS DE VERIFICACIÓN DOCUMENTAL");
    expect(result.text).not.toContain("PRÓXIMAS ACCIONES RECOMENDADAS");
    expect(result.text).not.toContain("Reincidencia");
    expect(result.text.indexOf("RESULTADO DEL RECURSO")).toBeLessThan(result.text.indexOf("Hallazgos Clave"));
    const output=process.env.NYRAVA_REPORT_ARTIFACT_DIR;
    if(output) {
      mkdirSync(output,{recursive:true});
      writeFileSync(join(output,"synthetic-concluded-report.pdf"),new Uint8Array(rendered.pdf!));
      writeFileSync(join(output,"synthetic-rendered-text.txt"),result.text);
    }
  },30000);
  it.each(["penal","civil","familiar","laboral","mercantil","fiscal","amparo"])("LIMITED contract is shared by %s", materia => {
    const input=regressionInput(); input.case!.case_type=materia;
    expect(validateFinalReportContract(releaseFinalReportPayload(input)).ok).toBe(true);
  });
});
