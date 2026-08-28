/**
 * Comprehensive Care — Centralized Localization Helper for Enums and Field Values.
 * Converts raw database values into clean, professional Spanish or English text.
 */
export function localizedEnum(value: string | null | undefined, es: boolean): string {
  if (!value) return "—";
  const key = String(value).trim().toLowerCase();

  const labels: Record<string, [string, string]> = {
    // Risk levels
    unknown: ["Desconocido", "Unknown"],
    low: ["Bajo", "Low"],
    moderate: ["Moderado", "Moderate"],
    high: ["Alto", "High"],
    critical: ["Crítico", "Critical"],

    // Priorities
    normal: ["Normal", "Normal"],
    urgent: ["Urgente", "Urgent"],
    emergency: ["Emergencia", "Emergency"],

    // Case statuses
    intake: ["Recepción / Ingreso", "Intake"],
    assessment: ["Evaluación", "Assessment"],
    active: ["Activo", "Active"],
    monitoring: ["En monitoreo", "Monitoring"],
    pending_referral: ["Canalización pendiente", "Pending referral"],
    transferred: ["Transferido", "Transferred"],
    closed: ["Cerrado", "Closed"],
    reopened: ["Reabierto", "Reopened"],
    archived: ["Archivado", "Archived"],

    // Task & Goal statuses
    todo: ["Por hacer", "To do"],
    in_progress: ["En progreso", "In progress"],
    blocked: ["Bloqueado", "Blocked"],
    done: ["Completado/a", "Done"],
    completed: ["Completado/a", "Completed"],
    cancelled: ["Cancelado/a", "Cancelled"],

    // Roles
    case_manager: ["Gestor del caso", "Case manager"],
    supervisor: ["Supervisor/a", "Supervisor"],
    attorney: ["Abogado/a", "Attorney"],
    psychologist: ["Psicólogo/a", "Psychologist"],
    social_worker: ["Trabajador/a social", "Social worker"],
    organization_owner: ["Titular de la organización", "Organization owner"],
    program_director: ["Director/a de programa", "Program director"],
    case_management_supervisor: ["Supervisor/a de casos", "Case management supervisor"],
    legal_assistant: ["Asistente jurídico", "Legal assistant"],
    medical_professional: ["Profesional médico", "Medical professional"],
    referral_coordinator: ["Coordinador/a de canalizaciones", "Referral coordinator"],
    data_analyst: ["Analista de datos", "Data analyst"],
    auditor: ["Auditor/a", "Auditor"],
    read_only_reviewer: ["Revisor/a de solo lectura", "Read-only reviewer"],
    external_partner: ["Socio externo", "External partner"],

    // Record types & Confidentiality
    general_case_record: ["Expediente general del caso", "General case record"],
    social_work_record: ["Expediente de trabajo social", "Social work record"],
    legal_privileged_record: ["Expediente jurídico privilegiado", "Privileged legal record"],
    psychosocial_restricted_record: ["Expediente psicosocial restringido", "Restricted psychosocial record"],
    medical_restricted_record: ["Expediente médico restringido", "Restricted medical record"],
    child_protection_restricted_record: ["Expediente de protección infantil", "Restricted child-protection record"],
    standard: ["Estándar", "Standard"],
    restricted: ["Restringido", "Restricted"],
    highly_confidential: ["Altamente confidencial", "Highly confidential"],

    // Document lifecycle
    draft: ["Borrador", "Draft"],
    ready_for_review: ["Listo para revisión", "Ready for review"],
    finalized: ["Finalizado", "Finalized"],
    sent: ["Enviado", "Sent"],
    received: ["Recibido", "Received"],
    superseded: ["Sustituido", "Superseded"],

    // Services
    social_work: ["Trabajo social", "Social work"],
    legal_assistance: ["Asistencia jurídica", "Legal assistance"],
    immigration_assistance: ["Asistencia migratoria", "Immigration assistance"],
    psychological_support: ["Apoyo psicológico", "Psychological support"],
    medical_referral: ["Canalización médica", "Medical referral"],
    child_protection: ["Protección infantil", "Child protection"],
    shelter_housing: ["Albergue y vivienda", "Shelter and housing"],
    food_assistance: ["Asistencia alimentaria", "Food assistance"],
    employment: ["Empleo", "Employment"],
    education: ["Educación", "Education"],
    transportation: ["Transporte", "Transportation"],
    documentation: ["Documentación", "Documentation"],
    family_reunification: ["Reunificación familiar", "Family reunification"],

    // Actions & Operations
    insert: ["Creación", "Creation"],
    update: ["Actualización", "Update"],
    delete: ["Eliminación", "Deletion"],
    access: ["Acceso", "Access"],
    preview: ["Vista previa", "Preview"],
    download: ["Descarga", "Download"],
    verified: ["Verificado", "Verified"],
    unverified: ["Sin verificar", "Unverified"],

    // Closure reasons
    services_completed: ["Servicios concluidos", "Services completed"],
    client_withdrew: ["Desistimiento del cliente", "Client withdrew"],
    unable_to_contact: ["Imposible contactar", "Unable to contact"],
    ineligible: ["No elegible", "Ineligible"],
    relocated: ["Reubicado/a", "Relocated"],
    duplicate_case: ["Caso duplicado", "Duplicate case"],
    other: ["Otro", "Other"],
  };

  if (labels[key]) {
    return es ? labels[key][0] : labels[key][1];
  }

  // Fallback: format snake_case nicely
  return key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}
