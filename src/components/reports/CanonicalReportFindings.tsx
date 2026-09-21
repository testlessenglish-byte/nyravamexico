import { releaseFinalReportPayload, type FinalReportPayload } from "@/lib/reporting/final-report-contract";

/** HTML consumes the same validated cards and order as PDF and DOCX. */
export function CanonicalReportFindings({payload}: {payload: FinalReportPayload}) {
  const {report_presentation:view} = releaseFinalReportPayload(payload);
  return <section className="space-y-4" aria-label="Canonical report">
    {view.decision_sections.map(section => <section key={section.id} className="rounded border p-4">
      <h2 className="font-semibold">{section.title}</h2>
      <p>{section.text}</p>
      <p className="text-sm text-muted-foreground">{section.speaker_label} · {section.speaker_role}</p>
    </section>)}
    {!!view.procedural_history?.length && <section className="rounded border p-4">
      <h2 className="font-semibold">ANTECEDENTES PROCESALES — NO SON EL RESULTADO ACTUAL</h2>
      {view.procedural_history.map(item => <p key={item.id}>{item.text}</p>)}
    </section>}
    <p>DOCUMENTOS ANALIZADOS = {view.unique_source_count}</p>
    {!view.capability.strategic_recommendations_allowed && <p>RECOMENDACIONES = SUPRIMIDO</p>}
    {view.finding_cards.map(({finding:f,source_count,details:wp}, index) => <section key={String(f.id ?? index)} className="rounded border p-4">
      <h3 className="font-semibold">{f.title}</h3>
      <p className="text-sm text-muted-foreground">{f.speaker_role_label} · {f.speaker_role}</p>
      <p>{f.description}</p>
      <p>Fuentes: {source_count}</p>
      {wp.synthesis && <p>{wp.synthesis.narrative}</p>}
      {!!wp.actions.length && <div><h4>{wp.actions_title}</h4><ul>
        {wp.actions.map(action=><li key={action}>{action}</li>)}
      </ul></div>}
    </section>)}
    {!!view.withheld_findings.length && <p>Hay clasificaciones sin sustento suficiente que requieren revisión del abogado.</p>}
  </section>;
}
