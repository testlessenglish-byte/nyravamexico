import {describe,it,expect,vi} from "vitest";
import {readFileSync,writeFileSync,mkdirSync} from "node:fs";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {composeFinalReportPayload,validateFinalReportContract,releaseFinalReportPayload,releaseRenderedReportOutput} from "../final-report-contract";
import {resolveFinalReleaseDecision,refreshProceduralQa} from "../final-release-decision";
import {auditPenalProceduralSemantics} from "../../intelligence/penal-qa-status";
import type {CaseExportData} from "../../export";
const captured = vi.hoisted(()=>({pdf:null as ArrayBuffer|null,saves:0}));
vi.mock("jspdf",async original=>{
  const actual=await original<typeof import("jspdf")>();
  function Pdf(options:any) {
    const pdf=new actual.jsPDF(options);
    pdf.save=(()=>{captured.pdf=pdf.output("arraybuffer");captured.saves++;return pdf;}) as any;
    return pdf;
  }
  Object.assign(Pdf,actual.jsPDF);
  return {...actual,default:Pdf};
});
const source={document_id:"doc-1",canonical_source_id:"source-1",original_filename:"Judgment.pdf",display_name:"Judgment.pdf",source_aliases:[]};
const ref={document_id:"doc-1",canonical_source_id:"source-1",quote:"Se desecha el recurso.",page:1};
function input():CaseExportData {
  return {case:{case_type:"amparo",case_analysis_mode:"concluded_audit",report_language:"es"},
    documents:[{id:"doc-1",filename:"Judgment.pdf"}],analysis:null,agents:[],score:null,findings:[],
    report:{report_mode:"LIMITED",scores_suppressed:true,motions_suppressed:true,generated_language:"es",
      full_report:{case_type:"amparo",source_audit:{canonical_sources:[source]},
        mandatory_decision_core:{items:[{id:"disposition",kind:"DISPOSITION",text:ref.quote,speaker_role:"scjn",source_refs:[ref]}]}}}};
}
const forbidden=["ESTIMACIÓN DE PROBABILIDAD","PROBABILIDAD DE ÉXITO","SUCCESS PROBABILITY","WIN PROBABILITY"];
describe("targeted hardening A–G",()=>{
  it("A suppresses constitutional probability fields and tagged blocks",()=>{
    const raw=input();
    raw.report!.constitutional_issues_struct=[{issue:"Cuestión constitucional",likely_outcome:"El tribunal podría considerar la nulidad.",probability_estimate:"90%"}];
    (raw.report!.full_report as any).appendices=[{content_class:"PROBABILITY",text:"90%"}];
    const payload=releaseFinalReportPayload(raw);
    expect(payload.report!.constitutional_issues_struct).toEqual([{issue:"Cuestión constitucional"}]);
    expect((payload.report!.full_report as any).appendices).toEqual([]);
    expect((raw.report!.constitutional_issues_struct as any)[0].likely_outcome).toBeTruthy();
  });
  it("B rewrites concluded evidence gaps to neutral corpus verification",()=>{
    const raw=input();
    raw.report!.discovery_analysis="future legal actions recommended";
    (raw.report!.full_report as any).prose={missing_evidence_report:"Se recomienda investigar más a fondo la detención."};
    const payload=releaseFinalReportPayload(raw);
    expect(payload.report!.discovery_analysis).toContain("corpus aportado");
    expect(JSON.stringify(payload)).not.toMatch(/future legal actions|investigar más a fondo/);
  });
  it("C permits only explicitly tagged, sourced historical remedies",()=>{
    const raw=input();
    raw.report!.constitutional_issues_struct=[
      {remedy_sought:"Reposición del procedimiento."},
      {content_class:"HISTORICAL_REMEDY",remedy_sought:"Reposición del procedimiento.",source_refs:[ref]},
      {content_class:"HISTORICAL_REMEDY",remedy_sought:"Unsupported"}];
    const payload=releaseFinalReportPayload(raw);
    const rows=payload.report!.constitutional_issues_struct as any[];
    expect(rows[0].remedy_sought).toBeUndefined();
    expect(rows[1].historical_remedy.title).toBe("EFECTO O REMEDIO ANALIZADO EN EL PROCEDIMIENTO");
    expect(rows[2].remedy_sought).toBeUndefined();
    const bad=structuredClone(payload);
    (bad.report!.full_report as any).appendices=[{content_class:"RECOMMENDED_REMEDY",text:"Reposición"}];
    expect(validateFinalReportContract(bad).ok).toBe(false);
  });
  it("D distinguishes corpus absence from verified absence and quotations",()=>{
    const raw=input();
    raw.report!.missing_evidence_struct=[{item:"No obra en el expediente: constancia de notificación."},
      {item:"No existe constancia.",absence_verified:true}];
    const payload=releaseFinalReportPayload(raw);
    expect((payload.report!.missing_evidence_struct as any[])[0].item).toContain("No identificada en el corpus aportado");
    expect((payload.report!.missing_evidence_struct as any[])[1].item).toBe("No existe constancia.");
    const bad=structuredClone(payload);
    (bad.report!.full_report as any).late={text:"No obra en el expediente la notificación."};
    expect(validateFinalReportContract(bad).blocking_errors).toContain("unverifiedAbsencePresent");
  });
  for (const section of ["executive_summary","case_overview","facts","key_findings","finding_actions",
    "constitutional_analysis","missing_evidence","evidence_gaps","procedural_analysis","recommendations",
    "motions","risk_analysis","legal_theories","strategy","appendices","attorney_summary","investigator_summary","prose","unknown_future_section"]) {
    it("E rejects late probability injection into "+section,()=>{
      for(const text of forbidden) {
        const payload=composeFinalReportPayload(input());
        (payload.report!.full_report as any)[section]={nested:[{text}]};
        const contract=validateFinalReportContract(payload);
        expect(contract.ok).toBe(false);
        expect(contract.violation_paths.some(p=>p.path.includes(section))).toBe(true);
        expect(resolveFinalReleaseDecision({report:payload.report!,contract}).released).toBe(false);
      }
    });
  }
  it("E checks template-created output with the existing final validator",()=>{
    const payload=releaseFinalReportPayload(input());
    expect(()=>releaseRenderedReportOutput(payload,"pdf","ESTIMACIÓN DE\nPROBABILIDAD: 90%")).toThrow("REPORT_CONTRACT_BLOCKED");
    expect(releaseRenderedReportOutput(payload,"pdf","Verificar las constancias.").report_presentation.render_output?.format).toBe("pdf");
    expect(Object.isFrozen(payload)).toBe(true);
  });
  it("E blocks a late template label before a PDF can be saved",async()=>{
    const locale=await import("../../report-i18n");
    const original=locale.rt;
    const spy=vi.spyOn(locale,"rt").mockImplementation((text:any)=>
      text === "Índice" ? "WIN PROBABILITY" : original(text));
    const before=captured.saves;
    try {
      const {downloadPdf}=await import("../../export");
      await expect(downloadPdf(input(),"Template injection")).rejects.toThrow("REPORT_CONTRACT_BLOCKED");
      expect(captured.saves).toBe(before);
    } finally { spy.mockRestore(); }
  });
  it("F blocks every blocking FAIL, including unknown future QA layers and quality flags",()=>{
    for(const layer of ["procedural_semantics","classification_fidelity","custom_future_qa"]) {
      const report={full_report:{qa_statuses:[{layer,status:"FAIL",blocking:true,reason:"corruption"}]}};
      const decision=resolveFinalReleaseDecision({report,contract:{ok:true,blocking_errors:[]}});
      expect(decision).toMatchObject({released:false,decision:"BLOCKED",quality_blocked:true});
    }
    expect(resolveFinalReleaseDecision({report:{quality_blocked:true},contract:{ok:true,blocking_errors:[]}}).released).toBe(false);
    expect(resolveFinalReleaseDecision({report:{full_report:{qa_statuses:[{
      layer:"release_readiness",status:"FAIL",blocking:true,reason:"release_gate_mismatch",
    }]}},contract:{ok:true,blocking_errors:[]}}).released).toBe(false);
    const raw=input();
    (raw.report!.full_report as any).qa_statuses=[{layer:"legal_qa",status:"FAIL",blocking:true}];
    expect(()=>releaseFinalReportPayload(raw)).toThrow("REPORT_BLOCKED");
  });
  it("G normalizes informational failures without discarding evidence",()=>{
    const report={full_report:{qa_statuses:[{layer:"release_readiness",status:"FAIL",reason:"release_gate_mismatch",issues:1}]}};
    const decision=resolveFinalReleaseDecision({report,contract:{ok:true,blocking_errors:[]}});
    expect(decision).toMatchObject({released:true,decision:"PASS_WITH_WARNINGS"});
    expect(decision.qa_statuses[0]).toMatchObject({status:"WARN_NON_BLOCKING",blocking:false,issues:1});
  });
  it("does not let a stale nested release verdict re-block a corrected report",()=>{
    const report={quality_blocked:false,full_report:{release_decision:"BLOCKED",final_review:{released:false}}};
    expect(resolveFinalReleaseDecision({report,contract:{ok:true,blocking_errors:[]}})).toMatchObject({
      released:true,
      quality_blocked:false,
    });
  });
  it("preserves the real blocking reasons at the export boundary",()=>{
    const raw=input();
    raw.report!.quality_blocked=true;
    raw.report!.quality_block_reasons=["gate:judge", "gate:rendered_report"];
    expect(()=>releaseFinalReportPayload(raw)).toThrow("REPORT_BLOCKED: gate:judge, gate:rendered_report");
  });
  it("holding is a valid schema alias; adopted party claims remain blocking corruption",()=>{
    const holding:any={speaker_role:"scjn",proposition_type:"holding",adoption_status:"adopted",
      audit_classification:"VERIFIED_COURT_HOLDING",impact_direction:"neutral",evidence_refs:[ref]};
    expect(auditPenalProceduralSemantics([holding])).toBe(0);
    expect(auditPenalProceduralSemantics([{...holding,speaker_role:"quejoso"}])).toBe(1);
    expect(auditPenalProceduralSemantics([{...holding,impact_direction:"strengthens"}])).toBe(1);
  });
});

describe("ADR 3265/2023 saved-artifact replay",()=>{
  it.skipIf(!process.env.NYRAVA_ADR_INPUT)("recomposes the real saved JSON and renders the actual PDF",async()=>{
    const raw=JSON.parse(readFileSync(process.env.NYRAVA_ADR_INPUT!,"utf8")) as CaseExportData;
    const before=validateFinalReportContract(raw as any);
    expect(before.ok).toBe(false);
    let payload=composeFinalReportPayload(raw);
    refreshProceduralQa(payload.report!,payload.findings!);
    const {prepareFinalReportForRelease}=await import("../../export");
    payload=structuredClone(await prepareFinalReportForRelease(payload));
    const contract=validateFinalReportContract(payload);
    expect(contract,JSON.stringify(contract)).toMatchObject({ok:true});
    expect(contract.validation_stage).toBe("after_renderer_transforms");
    expect(payload.report_presentation.render_output?.format).toBe("pdf");
    const release=resolveFinalReleaseDecision({report:payload.report!,contract});
    expect(release.released,JSON.stringify(release)).toBe(true);
    (payload.report!.full_report as any).qa_statuses=release.qa_statuses;
    (payload.report!.full_report as any).release_decision=release.decision;
    (payload.report!.full_report as any).release_gate={ok:release.released,decision:release.decision,errors:release.errors,warnings:release.warnings};
    (payload.report!.full_report as any).final_review={released:release.released,decision:release.decision,status:release.status};
    (payload.report!.full_report as any).final_report_contract_validation=contract;
    (payload.report!.full_report as any).final_governance_validation=contract;
    payload.report!.quality_blocked=release.quality_blocked;
    expect(payload.report_presentation.governance.governance_mode).toBe("concluded_decision_audit");
    expect(payload.report_presentation.capability.mode).toBe("LIMITED");
    expect(payload.report_presentation.unique_source_count).toBe(1);
    const {downloadPdf}=await import("../../export");
    const exactPdfPayload=await downloadPdf(payload,"ADR 3265/2023 — replay");
    const pdfContract=validateFinalReportContract(exactPdfPayload);
    expect(pdfContract).toMatchObject({ok:true,validation_stage:"after_renderer_transforms"});
    const {extractText}=await import("unpdf");
    const result=await extractText(new Uint8Array(captured.pdf!.slice(0)),{mergePages:true});
    expect(result.text).toContain("PASOS DE VERIFICACIÓN DOCUMENTAL");
    expect(result.text.toLowerCase()).not.toMatch(/estimación de probabilidad|remedio solicitado|futuras acciones legales/);
    expect(result.text).toContain("No identificada en el corpus aportado");
    const output=process.env.NYRAVA_REPORT_ARTIFACT_DIR;
    if(output) {
      mkdirSync(output,{recursive:true});
      writeFileSync(join(output,"adr-3265-2023-replay.pdf"),new Uint8Array(captured.pdf!));
      writeFileSync(join(output,"adr-3265-2023-replay.json"),JSON.stringify(exactPdfPayload,null,2));
      writeFileSync(join(output,"adr-replay-evidence.json"),JSON.stringify({before,after:pdfContract,preflight:contract,release,
        pdf_sha256:createHash("sha256").update(new Uint8Array(captured.pdf!)).digest("hex"),
        replay_scope:"Saved JSON through current composer, release resolver and real PDF renderer; no extraction/OCR/AI rerun"},null,2));
      writeFileSync(join(output,"adr-replay-text.txt"),result.text);
    }
  },30000);
});
