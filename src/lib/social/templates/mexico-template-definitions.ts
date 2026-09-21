export type TemplateType = "nyrava_template" | "organization_template" | "official_mexican_form";

export type TemplateCategory =
  | "intake"
  | "consent"
  | "risk_safety"
  | "housing"
  | "psychosocial"
  | "legal"
  | "family_children"
  | "health"
  | "immigration_refugee"
  | "general_assistance";

export type DocumentPurpose =
  | "intake"
  | "consent_privacy"
  | "risk_safety"
  | "care_plan"
  | "referral"
  | "housing"
  | "psychosocial"
  | "legal"
  | "medical_health"
  | "child_family"
  | "immigration"
  | "follow_up"
  | "closure";

export interface TemplateFieldDefinition {
  key: string;
  label_es: string;
  label_en: string;
  type: "text" | "textarea" | "select" | "date" | "number" | "boolean";
  options?: Array<{ value: string; label_es: string; label_en: string }>;
  mapping_path?: string;
  required: boolean;
  category_role?: "auto_filled" | "needs_completion" | "optional";
  allowed_classifications?: string[];
  placeholder_es?: string;
  placeholder_en?: string;
}

export interface MexicoTemplateDefinition {
  code: string;
  template_type: TemplateType;
  category: TemplateCategory;
  purpose: DocumentPurpose;
  name_es: string;
  name_en: string;
  description_es: string;
  description_en: string;
  record_type: string;
  version: number;
  official_authority?: string;
  jurisdiction?: "federal" | "estatal" | "municipal";
  source_url?: string;
  last_verified_at?: string;
  effective_date?: string;
  fields: TemplateFieldDefinition[];
  default_sections: Array<{
    title_es: string;
    title_en: string;
    field_keys: string[];
  }>;
}

export const MEXICO_TEMPLATES: MexicoTemplateDefinition[] = [
  // 1. INTAKE
  {
    code: "mex_ficha_ingreso",
    template_type: "nyrava_template",
    category: "intake",
    purpose: "intake",
    name_es: "Ficha de ingreso / Client Intake",
    name_en: "Client Intake Sheet",
    description_es: "Registro integral de apertura, antecedentes demográficos y necesidades iniciales identificadas.",
    description_en: "Comprehensive registration of case opening, demographics, and initial presenting needs.",
    record_type: "general_case_record",
    version: 1,
    fields: [
      { key: "case_number", label_es: "Folio del caso", label_en: "Case Number", type: "text", mapping_path: "case.number", required: true, category_role: "auto_filled" },
      { key: "client_name", label_es: "Nombre legal de la persona", label_en: "Client Legal Name", type: "text", mapping_path: "client.full_name", required: true, category_role: "auto_filled" },
      { key: "preferred_name", label_es: "Nombre preferido / Alias", label_en: "Preferred Name / Alias", type: "text", mapping_path: "client.preferred_name", required: false, category_role: "auto_filled" },
      { key: "phone", label_es: "Teléfono de contacto", label_en: "Telephone", type: "text", mapping_path: "client.phone", required: false, category_role: "auto_filled" },
      { key: "email", label_es: "Correo electrónico", label_en: "Email", type: "text", mapping_path: "client.email", required: false, category_role: "auto_filled" },
      { key: "location", label_es: "Municipio y Estado", label_en: "Municipality & State", type: "text", mapping_path: "client.location", required: false, category_role: "auto_filled" },
      { key: "family_composition", label_es: "Composición familiar", label_en: "Household Composition", type: "text", mapping_path: "household.composition", required: false, category_role: "auto_filled" },
      { key: "intake_channel", label_es: "Canal de ingreso", label_en: "Intake Channel", type: "select", options: [{ value: "direct", label_es: "Directo", label_en: "Direct" }, { value: "phone", label_es: "Telefónico", label_en: "Phone" }, { value: "referral", label_es: "Canalización", label_en: "Referral" }, { value: "walk_in", label_es: "Presencial", label_en: "Walk-in" }], required: true, category_role: "needs_completion" },
      { key: "presenting_needs", label_es: "Necesidades manifiestas", label_en: "Presenting Needs", type: "textarea", mapping_path: "care_plan.needs", required: true, category_role: "auto_filled" },
      { key: "initial_observations", label_es: "Observaciones del profesional", label_en: "Worker Observations", type: "textarea", required: false, category_role: "needs_completion" }
    ],
    default_sections: [
      { title_es: "Datos del caso y de la persona", title_en: "Case and Client Demographics", field_keys: ["case_number", "client_name", "preferred_name", "phone", "email", "location", "family_composition"] },
      { title_es: "Evaluación inicial de ingreso", title_en: "Initial Intake Review", field_keys: ["intake_channel", "presenting_needs", "initial_observations"] }
    ]
  },
  {
    code: "mex_evaluacion_necesidades",
    template_type: "nyrava_template",
    category: "intake",
    purpose: "intake",
    name_es: "Evaluación inicial de necesidades",
    name_en: "Initial Needs Assessment",
    description_es: "Mapeo estructurado de necesidades prioritarias en salud, vivienda, legal y subsistencia.",
    description_en: "Structured mapping of priority needs in health, housing, legal, and subsistence.",
    record_type: "general_case_record",
    version: 1,
    fields: [
      { key: "case_number", label_es: "Folio del caso", label_en: "Case Number", type: "text", mapping_path: "case.number", required: true, category_role: "auto_filled" },
      { key: "client_name", label_es: "Nombre de la persona", label_en: "Client Name", type: "text", mapping_path: "client.full_name", required: true, category_role: "auto_filled" },
      { key: "primary_needs", label_es: "Áreas de necesidad identificadas", label_en: "Identified Need Areas", type: "textarea", mapping_path: "care_plan.needs", required: true, category_role: "auto_filled" },
      { key: "vulnerability_factors", label_es: "Factores de vulnerabilidad observados", label_en: "Observed Vulnerability Factors", type: "textarea", required: true, category_role: "needs_completion" },
      { key: "immediate_actions_recommended", label_es: "Acciones inmediatas recomendadas", label_en: "Recommended Immediate Actions", type: "textarea", required: true, category_role: "needs_completion" }
    ],
    default_sections: [
      { title_es: "Identificación", title_en: "Identification", field_keys: ["case_number", "client_name"] },
      { title_es: "Diagnóstico de necesidades", title_en: "Needs Assessment", field_keys: ["primary_needs", "vulnerability_factors", "immediate_actions_recommended"] }
    ]
  },
  // 2. CONSENT
  {
    code: "mex_consentimiento_servicios",
    template_type: "nyrava_template",
    category: "consent",
    purpose: "consent_privacy",
    name_es: "Consentimiento para prestación de servicios",
    name_en: "Consent for Provision of Services",
    description_es: "Autorización informada para la atención integral y acompañamiento multidisciplinario.",
    description_en: "Informed consent for comprehensive care and multidisciplinary support.",
    record_type: "general_case_record",
    version: 1,
    fields: [
      { key: "case_number", label_es: "Folio del caso", label_en: "Case Number", type: "text", mapping_path: "case.number", required: true, category_role: "auto_filled" },
      { key: "client_name", label_es: "Nombre de la persona otorgante", label_en: "Consenting Client Name", type: "text", mapping_path: "client.full_name", required: true, category_role: "auto_filled" },
      { key: "worker_name", label_es: "Profesional responsable", label_en: "Responsible Case Worker", type: "text", mapping_path: "case.worker_name", required: true, category_role: "auto_filled" },
      { key: "scope_of_services", label_es: "Alcance de servicios autorizados", label_en: "Scope of Authorized Services", type: "textarea", required: true, category_role: "needs_completion" },
      { key: "rights_and_revocation", label_es: "Aviso de derechos y revocabilidad", label_en: "Rights & Revocability Notice", type: "textarea", required: true, category_role: "needs_completion" }
    ],
    default_sections: [
      { title_es: "Datos de identificación", title_en: "Identification Details", field_keys: ["case_number", "client_name", "worker_name"] },
      { title_es: "Términos y alcance", title_en: "Terms & Scope", field_keys: ["scope_of_services", "rights_and_revocation"] }
    ]
  },
  {
    code: "mex_consentimiento_compartir",
    template_type: "nyrava_template",
    category: "consent",
    purpose: "consent_privacy",
    name_es: "Consentimiento para compartir información",
    name_en: "Consent to Share Information",
    description_es: "Autorización expresa y delimitada para canalizaciones interinstitucionales.",
    description_en: "Express, limited consent for inter-agency referrals and coordination.",
    record_type: "general_case_record",
    version: 1,
    fields: [
      { key: "case_number", label_es: "Folio del caso", label_en: "Case Number", type: "text", mapping_path: "case.number", required: true, category_role: "auto_filled" },
      { key: "client_name", label_es: "Nombre de la persona", label_en: "Client Name", type: "text", mapping_path: "client.full_name", required: true, category_role: "auto_filled" },
      { key: "authorized_recipients", label_es: "Destinatarios u organismos autorizados", label_en: "Authorized Recipients / Agencies", type: "textarea", required: true, category_role: "needs_completion" },
      { key: "authorized_purposes", label_es: "Propósitos permitidos", label_en: "Authorized Purposes", type: "textarea", required: true, category_role: "needs_completion" },
      { key: "permitted_information", label_es: "Campos o información permitida", label_en: "Permitted Fields / Information", type: "textarea", required: true, category_role: "needs_completion" },
      { key: "validity_period", label_es: "Vigencia del consentimiento", label_en: "Validity Period", type: "text", required: true, category_role: "needs_completion" }
    ],
    default_sections: [
      { title_es: "Identificación de la persona", title_en: "Client Identification", field_keys: ["case_number", "client_name"] },
      { title_es: "Delimitación de divulgación", title_en: "Disclosure Boundaries", field_keys: ["authorized_recipients", "authorized_purposes", "permitted_information", "validity_period"] }
    ]
  },
  // 3. RISK & SAFETY
  {
    code: "mex_plan_seguridad",
    template_type: "nyrava_template",
    category: "risk_safety",
    purpose: "risk_safety",
    name_es: "Plan de seguridad",
    name_en: "Safety Plan",
    description_es: "Medidas preventivas, contactos de emergencia y protocolo ante situaciones de peligro inminente.",
    description_en: "Preventive safety measures, emergency contacts, and imminent risk protocols.",
    record_type: "general_case_record",
    version: 1,
    fields: [
      { key: "case_number", label_es: "Folio del caso", label_en: "Case Number", type: "text", mapping_path: "case.number", required: true, category_role: "auto_filled" },
      { key: "client_name", label_es: "Nombre de la persona", label_en: "Client Name", type: "text", mapping_path: "client.full_name", required: true, category_role: "auto_filled" },
      { key: "current_risk_level", label_es: "Nivel de riesgo vigente", label_en: "Current Risk Level", type: "text", mapping_path: "risk.current_level", required: true, category_role: "auto_filled" },
      { key: "warning_signs", label_es: "Señales de alerta o detonantes", label_en: "Warning Signs / Triggers", type: "textarea", required: true, category_role: "needs_completion" },
      { key: "protective_strategies", label_es: "Estrategias de autoprotección", label_en: "Self-Protection Strategies", type: "textarea", mapping_path: "risk.protective_factors", required: true, category_role: "auto_filled" },
      { key: "emergency_contacts", label_es: "Red de apoyo y contactos de emergencia", label_en: "Support Network & Emergency Contacts", type: "textarea", required: true, category_role: "needs_completion" },
      { key: "safe_locations", label_es: "Lugares seguros identificados", label_en: "Identified Safe Locations", type: "textarea", required: true, category_role: "needs_completion" }
    ],
    default_sections: [
      { title_es: "Información general y nivel de riesgo", title_en: "General Information & Risk Level", field_keys: ["case_number", "client_name", "current_risk_level"] },
      { title_es: "Plan de acción y protección", title_en: "Action & Protection Protocol", field_keys: ["warning_signs", "protective_strategies", "emergency_contacts", "safe_locations"] }
    ]
  },
  // 4. HOUSING REFERRALS
  {
    code: "mex_derivacion_vivienda",
    template_type: "nyrava_template",
    category: "housing",
    purpose: "housing",
    name_es: "Solicitud y derivación de apoyo de vivienda",
    name_en: "Housing Assistance Referral",
    description_es: "Canalización estructurada a albergues, vivienda temporal o programas habitacionales.",
    description_en: "Structured referral for shelter, temporary accommodation, or housing programs.",
    record_type: "general_case_record",
    version: 1,
    fields: [
      { key: "case_number", label_es: "Folio del caso", label_en: "Case Number", type: "text", mapping_path: "case.number", required: true, category_role: "auto_filled" },
      { key: "client_name", label_es: "Nombre de la persona titular", label_en: "Primary Client Name", type: "text", mapping_path: "client.full_name", required: true, category_role: "auto_filled" },
      { key: "phone", label_es: "Teléfono", label_en: "Phone", type: "text", mapping_path: "client.phone", required: false, category_role: "auto_filled" },
      { key: "location", label_es: "Ubicación actual (Municipio/Estado)", label_en: "Current Location", type: "text", mapping_path: "client.location", required: false, category_role: "auto_filled" },
      { key: "household_members", label_es: "Integrantes del núcleo familiar (adultos / NNA)", label_en: "Household Composition (Adults / Children)", type: "text", mapping_path: "household.composition", required: true, category_role: "auto_filled" },
      { key: "housing_situation", label_es: "Situación habitacional actual", label_en: "Current Housing Situation", type: "textarea", required: true, category_role: "needs_completion" },
      { key: "specific_housing_need", label_es: "Servicio habitacional solicitado", label_en: "Requested Housing Service", type: "select", options: [{ value: "emergency_shelter", label_es: "Albergue de emergencia", label_en: "Emergency shelter" }, { value: "temporary_housing", label_es: "Alojamiento temporal", label_en: "Temporary housing" }, { value: "rental_assistance", label_es: "Apoyo para renta", label_en: "Rental assistance" }, { value: "permanent_housing", label_es: "Vivienda permanente", label_en: "Permanent housing" }], required: true, category_role: "needs_completion" },
      { key: "accessibility_safety_requirements", label_es: "Requisitos de accesibilidad o seguridad", label_en: "Accessibility or Safety Requirements", type: "textarea", required: false, category_role: "optional" },
      { key: "worker_contact", label_es: "Contacto del profesional que deriva", label_en: "Referring Worker Contact", type: "text", mapping_path: "case.worker_contact", required: true, category_role: "auto_filled" }
    ],
    default_sections: [
      { title_es: "Datos de contacto y núcleo familiar", title_en: "Client & Household Contact", field_keys: ["case_number", "client_name", "phone", "location", "household_members"] },
      { title_es: "Requerimientos de vivienda", title_en: "Housing Requirements", field_keys: ["housing_situation", "specific_housing_need", "accessibility_safety_requirements", "worker_contact"] }
    ]
  },
  // 5. PSYCHOSOCIAL / PSYCHOLOGY REFERRALS
  {
    code: "mex_derivacion_psicologia",
    template_type: "nyrava_template",
    category: "psychosocial",
    purpose: "psychosocial",
    name_es: "Derivación a atención psicológica / psicosocial",
    name_en: "Psychology & Psychosocial Referral",
    description_es: "Canalización profesional para evaluación psicológica, terapia individual o familiar e intervención en crisis.",
    description_en: "Professional referral for psychological evaluation, therapy, and crisis intervention.",
    record_type: "general_case_record",
    version: 1,
    fields: [
      { key: "case_number", label_es: "Folio del caso", label_en: "Case Number", type: "text", mapping_path: "case.number", required: true, category_role: "auto_filled" },
      { key: "client_name", label_es: "Nombre de la persona", label_en: "Client Name", type: "text", mapping_path: "client.full_name", required: true, category_role: "auto_filled" },
      { key: "preferred_language", label_es: "Idioma / Lengua de preferencia", label_en: "Preferred Language", type: "text", mapping_path: "client.language", required: false, category_role: "auto_filled" },
      { key: "referral_reason", label_es: "Motivo de la derivación", label_en: "Reason for Referral", type: "textarea", required: true, category_role: "needs_completion" },
      { key: "presenting_symptoms", label_es: "Preocupaciones o manifestaciones psicosociales", label_en: "Presenting Concerns / Symptoms", type: "textarea", required: true, category_role: "needs_completion" },
      { key: "safety_considerations", label_es: "Consideraciones relevantes de seguridad", label_en: "Relevant Safety Considerations", type: "textarea", required: false, category_role: "optional" },
      { key: "urgency_level", label_es: "Nivel de urgencia", label_en: "Urgency Level", type: "select", options: [{ value: "standard", label_es: "Estándar", label_en: "Standard" }, { value: "urgent", label_es: "Urgente", label_en: "Urgent" }, { value: "crisis", label_es: "Crisis / Emergencia", label_en: "Crisis / Emergency" }], required: true, category_role: "needs_completion" },
      { key: "worker_contact", label_es: "Profesional que deriva", label_en: "Referring Worker", type: "text", mapping_path: "case.worker_contact", required: true, category_role: "auto_filled" }
    ],
    default_sections: [
      { title_es: "Datos de la persona", title_en: "Client Details", field_keys: ["case_number", "client_name", "preferred_language"] },
      { title_es: "Motivo y valoración psicosocial", title_en: "Referral Reason & Psychosocial Context", field_keys: ["referral_reason", "presenting_symptoms", "safety_considerations", "urgency_level", "worker_contact"] }
    ]
  },
  // 6. LEGAL ASSISTANCE REFERRALS
  {
    code: "mex_derivacion_juridica",
    template_type: "nyrava_template",
    category: "legal",
    purpose: "legal",
    name_es: "Derivación para asistencia jurídica",
    name_en: "Legal Assistance Referral",
    description_es: "Canalización para asesoría jurídica, defensa legal, amparo, atención a víctimas o trámites administrativos.",
    description_en: "Referral for legal representation, victim support, amparo, or administrative procedures.",
    record_type: "general_case_record",
    version: 1,
    fields: [
      { key: "case_number", label_es: "Folio del caso", label_en: "Case Number", type: "text", mapping_path: "case.number", required: true, category_role: "auto_filled" },
      { key: "client_name", label_es: "Nombre de la persona solicitante", label_en: "Client Name", type: "text", mapping_path: "client.full_name", required: true, category_role: "auto_filled" },
      { key: "legal_matter_type", label_es: "Materia jurídica", label_en: "Legal Area", type: "select", options: [{ value: "penal", label_es: "Penal / Atención a víctimas", label_en: "Criminal / Victim Support" }, { value: "familiar", label_es: "Familiar y Alimentos", label_en: "Family & Custody" }, { value: "migratorio", label_es: "Migratorio y Refugio", label_en: "Immigration & Asylum" }, { value: "amparo", label_es: "Amparo / Derechos Humanos", label_en: "Amparo & Human Rights" }, { value: "civil_administrativo", label_es: "Civil / Administrativo", label_en: "Civil / Administrative" }], required: true, category_role: "needs_completion" },
      { key: "summary_of_facts", label_es: "Resumen objetivo de los hechos", label_en: "Objective Summary of Facts", type: "textarea", required: true, category_role: "needs_completion" },
      { key: "existing_case_file_number", label_es: "Número de expediente o carpeta previa (si existe)", label_en: "Existing Proceeding / Case File Number", type: "text", required: false, category_role: "optional" },
      { key: "court_or_authority", label_es: "Autoridad, Juzgado o Fiscalía actuante", label_en: "Relevant Court, Authority, or Prosecutor", type: "text", required: false, category_role: "optional" },
      { key: "critical_deadlines", label_es: "Términos o plazos legales próximos", label_en: "Critical Legal Deadlines", type: "textarea", required: false, category_role: "optional" },
      { key: "worker_contact", label_es: "Profesional de enlace", label_en: "Case Worker Liaison", type: "text", mapping_path: "case.worker_contact", required: true, category_role: "auto_filled" }
    ],
    default_sections: [
      { title_es: "Datos generales", title_en: "General Details", field_keys: ["case_number", "client_name", "legal_matter_type"] },
      { title_es: "Antecedentes y solicitud jurídica", title_en: "Legal Background & Request", field_keys: ["summary_of_facts", "existing_case_file_number", "court_or_authority", "critical_deadlines", "worker_contact"] }
    ]
  },
  // 7. FAMILY & CHILDREN (DIF)
  {
    code: "mex_derivacion_dif_familia",
    template_type: "nyrava_template",
    category: "family_children",
    purpose: "child_family",
    name_es: "Derivación a servicios DIF / Protección de NNA",
    name_en: "DIF / Child & Family Protection Referral",
    description_es: "Canalización a instancias del Sistema DIF o Procuradurías de Protección de Niñas, Niños y Adolescentes.",
    description_en: "Referral to DIF systems and Child Protection Authorities for family and minor support.",
    record_type: "general_case_record",
    version: 1,
    fields: [
      { key: "case_number", label_es: "Folio del caso", label_en: "Case Number", type: "text", mapping_path: "case.number", required: true, category_role: "auto_filled" },
      { key: "client_name", label_es: "Nombre de la madre, padre, tutor o NNA", label_en: "Parent, Guardian, or Child Name", type: "text", mapping_path: "client.full_name", required: true, category_role: "auto_filled" },
      { key: "household_children", label_es: "Niñas, niños y adolescentes en el núcleo familiar", label_en: "Children in Household", type: "textarea", mapping_path: "household.composition", required: true, category_role: "auto_filled" },
      { key: "dif_service_requested", label_es: "Servicio DIF solicitado", label_en: "Requested DIF Service", type: "select", options: [{ value: "child_protection", label_es: "Protección integral de NNA", label_en: "Comprehensive child protection" }, { value: "family_strengthening", label_es: "Fortalecimiento familiar", label_en: "Family strengthening" }, { value: "food_aid", label_es: "Asistencia alimentaria DIF", label_en: "DIF food aid" }, { value: "psychological_care", label_es: "Atención psicológica infantil/familiar", label_en: "Child/family psychological care" }], required: true, category_role: "needs_completion" },
      { key: "protection_concerns_facts", label_es: "Hechos y motivos de atención", label_en: "Factual Background & Concerns", type: "textarea", required: true, category_role: "needs_completion" },
      { key: "urgency", label_es: "Prioridad", label_en: "Priority", type: "select", options: [{ value: "standard", label_es: "Ordinaria", label_en: "Standard" }, { value: "urgent", label_es: "Urgente", label_en: "Urgent" }, { value: "emergency", label_es: "Riesgo inminente", label_en: "Imminent Risk" }], required: true, category_role: "needs_completion" },
      { key: "worker_contact", label_es: "Profesional responsable", label_en: "Responsible Worker", type: "text", mapping_path: "case.worker_contact", required: true, category_role: "auto_filled" }
    ],
    default_sections: [
      { title_es: "Identificación de la familia y NNA", title_en: "Family and Minor Identification", field_keys: ["case_number", "client_name", "household_children"] },
      { title_es: "Servicio solicitado y circunstancias", title_en: "Requested Service & Background", field_keys: ["dif_service_requested", "protection_concerns_facts", "urgency", "worker_contact"] }
    ]
  },
  // 8. HEALTH & MEDICAL
  {
    code: "mex_derivacion_salud",
    template_type: "nyrava_template",
    category: "health",
    purpose: "medical_health",
    name_es: "Derivación a servicios de salud y atención médica",
    name_en: "Health & Medical Services Referral",
    description_es: "Canalización a centros de salud, hospitales comunitarios o servicios médicos especializados.",
    description_en: "Referral to health centers, community hospitals, or specialized medical care.",
    record_type: "general_case_record",
    version: 1,
    fields: [
      { key: "case_number", label_es: "Folio del caso", label_en: "Case Number", type: "text", mapping_path: "case.number", required: true, category_role: "auto_filled" },
      { key: "client_name", label_es: "Nombre de la persona paciente", label_en: "Patient Name", type: "text", mapping_path: "client.full_name", required: true, category_role: "auto_filled" },
      { key: "service_level", label_es: "Nivel de atención médica", label_en: "Medical Care Level", type: "select", options: [{ value: "primary", label_es: "Primer nivel / Consulta general", label_en: "Primary care / General" }, { value: "specialized", label_es: "Segundo nivel / Especialidad", label_en: "Specialized care" }, { value: "urgent", label_es: "Urgencias médicas", label_en: "Medical emergency" }, { value: "medication", label_es: "Suministro de medicamentos", label_en: "Medication supply" }], required: true, category_role: "needs_completion" },
      { key: "medical_reason", label_es: "Motivo manifiesto de atención médica", label_en: "Presenting Medical Reason", type: "textarea", required: true, category_role: "needs_completion" },
      { key: "known_alerts_allergies", label_es: "Alertas conocidas o condiciones médicas de conocimiento público", label_en: "Known Public Conditions / Alerts", type: "textarea", required: false, category_role: "optional" },
      { key: "worker_contact", label_es: "Contacto del profesional", label_en: "Worker Contact", type: "text", mapping_path: "case.worker_contact", required: true, category_role: "auto_filled" }
    ],
    default_sections: [
      { title_es: "Datos de la persona", title_en: "Patient Demographics", field_keys: ["case_number", "client_name"] },
      { title_es: "Requerimiento de salud", title_en: "Health Request", field_keys: ["service_level", "medical_reason", "known_alerts_allergies", "worker_contact"] }
    ]
  },
  // 9. IMMIGRATION / COMAR
  {
    code: "mex_derivacion_comar_migracion",
    template_type: "nyrava_template",
    category: "immigration_refugee",
    purpose: "immigration",
    name_es: "Derivación / Acompañamiento COMAR y Servicios Migratorios",
    name_en: "COMAR & Immigration Services Referral",
    description_es: "Canalización para solicitud de reconocimiento de la condición de refugiado (COMAR) o regularización migratoria (INM).",
    description_en: "Referral for asylum/refugee status recognition (COMAR) or immigration regularization (INM).",
    record_type: "general_case_record",
    version: 1,
    fields: [
      { key: "case_number", label_es: "Folio del caso", label_en: "Case Number", type: "text", mapping_path: "case.number", required: true, category_role: "auto_filled" },
      { key: "client_name", label_es: "Nombre de la persona solicitante", label_en: "Applicant Name", type: "text", mapping_path: "client.full_name", required: true, category_role: "auto_filled" },
      { key: "nationality", label_es: "Nacionalidad / País de origen", label_en: "Nationality / Country of Origin", type: "text", mapping_path: "client.nationality", required: false, category_role: "auto_filled" },
      { key: "preferred_language", label_es: "Idioma o dialecto de preferencia", label_en: "Preferred Language", type: "text", mapping_path: "client.language", required: false, category_role: "auto_filled" },
      { key: "requested_agency", label_es: "Instancia o procedimiento solicitado", label_en: "Requested Procedure / Agency", type: "select", options: [{ value: "comar_asylum", label_es: "COMAR — Condición de Refugiado", label_en: "COMAR — Refugee Status" }, { value: "inm_regularization", label_es: "INM — Regularización / TVRH", label_en: "INM — Regularization / Humanitarian Visa" }, { value: "consular", label_es: "Asistencia Consular / Identidad", label_en: "Consular Assistance / Identity" }, { value: "documentation", label_es: "CURP temporal / Documentación", label_en: "Temporary CURP / Documentation" }], required: true, category_role: "needs_completion" },
      { key: "summary_of_need", label_es: "Síntesis de la necesidad documental o de protección", label_en: "Summary of Document or Protection Need", type: "textarea", required: true, category_role: "needs_completion" },
      { key: "worker_contact", label_es: "Profesional de acompañamiento", label_en: "Accompanying Worker", type: "text", mapping_path: "case.worker_contact", required: true, category_role: "auto_filled" }
    ],
    default_sections: [
      { title_es: "Datos de la persona solicitante", title_en: "Applicant Identification", field_keys: ["case_number", "client_name", "nationality", "preferred_language"] },
      { title_es: "Procedimiento solicitado", title_en: "Requested Procedure", field_keys: ["requested_agency", "summary_of_need", "worker_contact"] }
    ]
  },
  // 10. GENERAL ASSISTANCE
  {
    code: "mex_derivacion_asistencia_general",
    template_type: "nyrava_template",
    category: "general_assistance",
    purpose: "referral",
    name_es: "Canalización de asistencia social general",
    name_en: "General Social Assistance Referral",
    description_es: "Derivación interinstitucional para alimentación, empleo, educación, transporte o documentación básica.",
    description_en: "Inter-agency referral for food assistance, employment, education, transport, or basic documentation.",
    record_type: "general_case_record",
    version: 1,
    fields: [
      { key: "case_number", label_es: "Folio del caso", label_en: "Case Number", type: "text", mapping_path: "case.number", required: true, category_role: "auto_filled" },
      { key: "client_name", label_es: "Nombre de la persona", label_en: "Client Name", type: "text", mapping_path: "client.full_name", required: true, category_role: "auto_filled" },
      { key: "phone", label_es: "Teléfono", label_en: "Phone", type: "text", mapping_path: "client.phone", required: false, category_role: "auto_filled" },
      { key: "assistance_type", label_es: "Tipo de asistencia requerida", label_en: "Type of Assistance Required", type: "select", options: [{ value: "food", label_es: "Alimentación / Despensa", label_en: "Food / Groceries" }, { value: "employment", label_es: "Capacitación y Empleo", label_en: "Job Training & Employment" }, { value: "education", label_es: "Educación y Becas", label_en: "Education & Grants" }, { value: "transport", label_es: "Transporte humanitario", label_en: "Humanitarian transport" }, { value: "documents", label_es: "Apoyo documental / Registro civil", label_en: "Civil Registry / Documents" }], required: true, category_role: "needs_completion" },
      { key: "referral_objective", label_es: "Objetivo y descripción de la solicitud", label_en: "Referral Objective & Description", type: "textarea", required: true, category_role: "needs_completion" },
      { key: "worker_contact", label_es: "Profesional responsable", label_en: "Referring Professional", type: "text", mapping_path: "case.worker_contact", required: true, category_role: "auto_filled" }
    ],
    default_sections: [
      { title_es: "Identificación de la persona", title_en: "Person Identification", field_keys: ["case_number", "client_name", "phone"] },
      { title_es: "Detalle de la asistencia solicitada", title_en: "Assistance Request Details", field_keys: ["assistance_type", "referral_objective", "worker_contact"] }
    ]
  }
];

export function findTemplateByCode(code: string): MexicoTemplateDefinition | undefined {
  return MEXICO_TEMPLATES.find((t) => t.code === code);
}

export function getTemplatesByCategory(category: TemplateCategory): MexicoTemplateDefinition[] {
  return MEXICO_TEMPLATES.filter((t) => t.category === category);
}
