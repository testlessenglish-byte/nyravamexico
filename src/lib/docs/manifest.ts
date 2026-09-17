// Single source of truth for docs sidebar nav + search index.
// Every docs route registers here so the sidebar, breadcrumbs, and
// Cmd+K search stay in sync.

export type DocEntry = {
  to: string;
  label: string;
  labelEs?: string;
  description?: string;
  descriptionEs?: string;
  keywords?: string[];
};

export type DocGroup = {
  heading: string;
  headingEs?: string;
  entries: DocEntry[];
};

export const DOCS_NAV: DocGroup[] = [
  {
    heading: "Getting Started",
    headingEs: "Para empezar",
    entries: [
      { to: "/help", label: "Help Center", description: "Browse categories and articles.", keywords: ["help", "support", "faq"] },
      { to: "/learning-center", label: "Learning Center", description: "Set up your workspace, add keys, run a case, and train your team.", keywords: ["learning", "training", "onboarding", "academy", "getting started"] },
      { to: "/how-it-works", label: "How Nyrava Works", description: "The end-to-end pipeline, from upload to report.", keywords: ["pipeline", "workflow", "overview"] },
      { to: "/help/first-case", label: "Running your first case", description: "Create a matter, upload the record, run analysis.", keywords: ["quickstart", "onboarding"] },
      { to: "/help/uploading", label: "Uploading documents", description: "Supported file types, OCR, batching.", keywords: ["ocr", "upload", "documents"] },
      { to: "/help/api-keys", label: "API keys & providers", description: "Bring your own OpenAI, Anthropic, Gemini, Groq, OpenRouter keys.", keywords: ["byok", "openai", "groq", "keys", "providers"] },
      { to: "/help/reports", label: "Understanding reports", description: "The 17-section canonical analysis.", keywords: ["report", "canonical", "sections"] },
    ],
  },
  {
    heading: "Product",
    headingEs: "Producto",
    entries: [
      { to: "/product/evidence-intelligence", label: "Evidence Intelligence", description: "Grounded, cited fact extraction from your corpus.", keywords: ["evidence", "extraction", "citations"] },
      { to: "/product/timeline-intelligence", label: "Timeline Intelligence", description: "Automatic chronology with cited events.", keywords: ["timeline", "chronology"] },
      { to: "/product/witness-intelligence", label: "Witness Intelligence", description: "Cluster statements, surface contradictions.", keywords: ["witness", "statements", "contradictions", "impeachment"] },
      { to: "/product/constitutional-intelligence", label: "Constitutional Intelligence", description: "CPEUM and derechos humanos issue spotting.", keywords: ["constitutional", "cpeum", "derechos humanos", "amparo"] },
      { to: "/product/motion-intelligence", label: "Motion Intelligence", description: "First-draft motions grounded in the record.", keywords: ["motion", "drafting", "suppress"] },
      { to: "/product/report-intelligence", label: "Report Intelligence", description: "17-section canonical case analysis, export-ready.", keywords: ["report", "canonical"] },
    ],
  },
  {
    heading: "Practice Areas",
    headingEs: "Áreas de práctica",
    entries: [
      { to: "/product/corporate", label: "Corporate Law Intelligence", description: "Governance, M&A, due diligence — same 17-section report, corporate content.", keywords: ["corporate", "governance", "m&a", "lgsm", "fiduciary", "shareholder", "board", "asamblea"] },
      { to: "/product/commercial", label: "Business & Commercial Law Intelligence", description: "Contract disputes, compraventa mercantil, business torts — same 17-section report, commercial content.", keywords: ["commercial", "business", "contract", "breach", "codigo de comercio", "warranty", "competencia desleal", "trade secret", "arbitration", "non-compete"] },
    ],
  },
  {
    heading: "Trust & Security",
    headingEs: "Confianza y seguridad",
    entries: [
      { to: "/trust", label: "Trust Center", labelEs: "Centro de Confianza", description: "The single hub for Nyrava's trust posture.", descriptionEs: "El centro de la postura de confianza de Nyrava.", keywords: ["trust", "security", "compliance", "confianza", "seguridad"] },
      { to: "/confidentiality", label: "Attorney Confidentiality", description: "What Nyrava personnel can and cannot access.", keywords: ["confidentiality", "personnel", "access", "operator"] },
      { to: "/security", label: "Security Practices", description: "Authentication, authorization, encryption.", keywords: ["security", "encryption", "rls"] },
      { to: "/ai-transparency", label: "AI Transparency", description: "Where AI is used and its limitations.", keywords: ["ai", "transparency", "limitations"] },
      { to: "/responsible-ai", label: "Responsible AI", description: "Our principles for evidence-grounded analysis.", keywords: ["responsible ai", "ethics"] },
      { to: "/data-control", label: "Data Control", description: "Export, delete, and manage your workspace data.", keywords: ["data", "export", "deletion"] },
      { to: "/privacy", label: "Privacy Policy", keywords: ["privacy", "gdpr"] },
    ],
  },
  {
    heading: "Legal",
    headingEs: "Legal",
    entries: [
      { to: "/terms", label: "Terms of Service", keywords: ["terms", "tos"] },
      { to: "/acceptable-use", label: "Acceptable Use Policy", keywords: ["aup", "prohibited"] },
      { to: "/dpa", label: "Data Processing Agreement", keywords: ["dpa", "gdpr"] },
      { to: "/cookies", label: "Cookie Policy", keywords: ["cookies"] },
      { to: "/dmca", label: "DMCA Policy", keywords: ["dmca", "copyright"] },
      { to: "/copyright", label: "Copyright Policy", keywords: ["copyright"] },
      { to: "/accessibility", label: "Accessibility Statement", keywords: ["a11y", "wcag"] },
      { to: "/beta-terms", label: "Beta Program Terms", keywords: ["beta"] },
    ],
  },
  {
    heading: "Company",
    headingEs: "Compañía",
    entries: [
      { to: "/about", label: "About Nyrava", keywords: ["about", "mission"] },
      { to: "/roadmap", label: "Roadmap", keywords: ["roadmap"] },
      { to: "/release-notes", label: "Release Notes", description: "What shipped, what's new, what's next.", keywords: ["changelog", "release"] },
      { to: "/resources", label: "Resources", description: "Redacted sample reports across practice areas.", keywords: ["samples", "case studies"] },
      { to: "/contact", label: "Contact", keywords: ["contact", "support"] },
    ],
  },
];

export const DOCS_VERSION = {
  version: "1.0.0",
  channel: "Beta",
  updated: "2026-07-23",
};

export function findActiveEntry(pathname: string): DocEntry | undefined {
  for (const group of DOCS_NAV) {
    for (const entry of group.entries) {
      if (entry.to === pathname) return entry;
    }
  }
  return undefined;
}

export function allEntries(): (DocEntry & { group: string; groupEs?: string })[] {
  const out: (DocEntry & { group: string })[] = [];
  for (const g of DOCS_NAV) for (const e of g.entries) out.push({ ...e, group: g.heading, groupEs: g.headingEs });
  return out;
}
