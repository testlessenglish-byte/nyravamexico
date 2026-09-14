import { createFileRoute, Link } from "@tanstack/react-router";
import {
  DocsLayout,
  DocsSection,
  Callout,
  FeatureGrid,
  breadcrumbJsonLd,
  CANONICAL_BASE,
} from "@/components/DocsLayout";
import { PipelineDiagram } from "@/components/docs/PipelineDiagram";
import {
  Lock,
  ShieldCheck,
  Eye,
  FileCheck2,
  Sparkles,
  Scale,
  Database,
  UserCheck,
  Server,
  GitBranch,
  ClipboardCheck,
} from "lucide-react";

export const Route = createFileRoute("/trust")({
  head: () => {
    const url = `${CANONICAL_BASE}/trust`;
    const desc =
      "Arquitectura de seguridad, cifrado, aislamiento de datos por despacho, verificación probatoria e IA responsable para expedientes confidenciales en México.";
    return {
      meta: [
        { title: "Centro de Confianza y Seguridad — Nyrava México" },
        { name: "description", content: desc },
        { property: "og:title", content: "Centro de Confianza — Nyrava México" },
        { property: "og:description", content: desc },
        { property: "og:type", content: "website" },
        { property: "og:url", content: url },
        { name: "twitter:card", content: "summary_large_image" },
        { name: "twitter:title", content: "Centro de Confianza — Nyrava México" },
        { name: "twitter:description", content: desc },
      ],
      links: [{ rel: "canonical", href: url }],
      scripts: [
        {
          type: "application/ld+json",
          children: breadcrumbJsonLd(CANONICAL_BASE, [{ label: "Trust Center", to: "/trust" }]),
        },
      ],
    };
  },
  component: TrustCenter,
});

const PILLARS = [
  {
    to: "/confidentiality",
    label: "Attorney Confidentiality",
    icon: ShieldCheck,
    description: "What Nyrava personnel can and cannot access.",
  },
  {
    to: "/privacy",
    label: "Privacy",
    icon: Lock,
    description: "What we collect, how we use it, and your rights.",
  },
  {
    to: "/security",
    label: "Security Practices",
    icon: ShieldCheck,
    description: "Authentication, authorization, and access controls.",
  },
  {
    to: "/ai-transparency",
    label: "AI Transparency",
    icon: Sparkles,
    description: "How AI is used, and its limitations.",
  },
  {
    to: "/responsible-ai",
    label: "Responsible AI",
    icon: Scale,
    description: "Our principles for evidence-grounded analysis.",
  },
  {
    to: "/data-control",
    label: "Data Control",
    icon: Database,
    description: "Export, delete, and manage your workspace data.",
  },
  {
    to: "/dpa",
    label: "Data Processing Agreement",
    icon: FileCheck2,
    description: "Contractual terms for processing customer data.",
  },
  {
    to: "/acceptable-use",
    label: "Acceptable Use",
    icon: UserCheck,
    description: "How Nyrava may and may not be used.",
  },
  {
    to: "/accessibility",
    label: "Accessibility",
    icon: Eye,
    description: "Our commitment to WCAG-aligned accessibility.",
  },
];

function TrustCenter() {
  return (
    <DocsLayout
      eyebrow="Trust Center"
      title="Trust, security, and responsibility at Nyrava"
      description="Attorneys upload their most sensitive material to Nyrava — witness statements, client communications, discovery, and work product. This page is the single hub for how we handle that trust."
      crumbs={[{ label: "Trust Center", to: "/trust" }]}
      toc={[
        { id: "principles", label: "Core principles" },
        { id: "architecture", label: "Security architecture" },
        { id: "pipeline", label: "The pipeline" },
        { id: "pillars", label: "Trust pillars" },
        { id: "attorney", label: "Attorney control" },
        { id: "evidence", label: "Evidence verification" },
        { id: "data", label: "Data ownership & isolation" },
        { id: "encryption", label: "Encryption" },
        { id: "availability", label: "System availability" },
        { id: "limits", label: "AI limitations & human verification" },
        { id: "compliance", label: "Compliance roadmap" },
        { id: "faq", label: "Security FAQ" },
        { id: "contact", label: "Contact & disclosure" },
      ]}
    >
      <DocsSection id="principles" heading="Core principles">
        <p>
          Nyrava exists to help legal professionals analyze complex matters faster without giving up
          the judgment, verification, and confidentiality that legal work demands. Every product
          decision is measured against six principles.
        </p>
        <FeatureGrid
          items={[
            {
              icon: <UserCheck className="h-4 w-4" />,
              title: "Attorney in control",
              description:
                "AI proposes, attorneys decide. Nothing leaves your workspace unless you send it.",
            },
            {
              icon: <FileCheck2 className="h-4 w-4" />,
              title: "Evidence first",
              description:
                "Every finding is anchored to a source document. Ungrounded output is suppressed.",
            },
            {
              icon: <Eye className="h-4 w-4" />,
              title: "Transparency",
              description: "Every engine run, model call, and rejection is logged and auditable.",
            },
            {
              icon: <Lock className="h-4 w-4" />,
              title: "Privacy by default",
              description:
                "Data is scoped to your workspace by row-level security enforced in the database.",
            },
            {
              icon: <ShieldCheck className="h-4 w-4" />,
              title: "Responsible AI",
              description:
                "We disclose limitations. We do not claim replacement of professional judgment.",
            },
            {
              icon: <Sparkles className="h-4 w-4" />,
              title: "No content training",
              description: "Nyrava does not use your case content to train general-purpose models, and enforces workspace isolation at the database layer.",
            },
          ]}
        />
      </DocsSection>

      <DocsSection id="architecture" heading="Security architecture">
        <p>
          Nyrava is a multi-tenant SaaS application designed around workspace isolation. Every
          request in the app is scoped to the authenticated user's workspace, and the underlying
          database enforces that scoping with row-level security policies. Application code cannot
          bypass those policies — a bug in a query layer cannot cause one workspace to read
          another's rows.
        </p>
        <FeatureGrid
          items={[
            {
              icon: <Server className="h-4 w-4" />,
              title: "Managed infrastructure",
              description:
                "Hosted on managed cloud infrastructure with automated database backups provided by the platform.",

            },
            {
              icon: <ShieldCheck className="h-4 w-4" />,
              title: "Row-level isolation",
              description:
                "Every table enforces workspace scoping at the database layer, not just in application code.",
            },
            {
              icon: <GitBranch className="h-4 w-4" />,
              title: "Auditable pipeline",
              description:
                "Every intelligence engine run writes a ledger row: inputs, model, tokens, outcome.",
            },
            {
              icon: <ClipboardCheck className="h-4 w-4" />,
              title: "Separated roles",
              description:
                "Administrative capabilities are gated by a server-side role table, never inferred from client state.",
            },
          ]}
        />
      </DocsSection>

      <DocsSection id="pipeline" heading="The pipeline, end-to-end">
        <p>
          Every case flows through a fixed sequence of engines. Each engine writes into a canonical
          analysis object rather than free-form prose, so the final report is a projection of
          grounded data rather than a re-summarization.
        </p>
        <PipelineDiagram />
      </DocsSection>

      <DocsSection id="pillars" heading="Trust pillars">
        <p>Each pillar has its own dedicated document.</p>
        <div className="my-4 grid gap-3 sm:grid-cols-2">
          {PILLARS.map(({ to, label, icon: Icon, description }) => (
            <Link
              key={to}
              to={to}
              className="group flex gap-3 rounded-lg border border-border/60 bg-card/30 p-4 hover:border-primary/40 hover:bg-card/60"
            >
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-border bg-card/70 text-primary">
                <Icon className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="text-[13.5px] font-semibold text-foreground">{label}</div>
                <div className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
                  {description}
                </div>
              </div>
            </Link>
          ))}
        </div>
      </DocsSection>

      <DocsSection id="attorney" heading="Attorney control">
        <p>
          Nyrava is a tool, not a decision-maker. Every generated output — evidence findings,
          timelines, motion drafts, reports — is designed to be reviewed before use. Citations are
          the primary UI affordance so verification is one click, not an audit.
        </p>
        <p>
          Attorneys remain the drafter of record on any filing produced with Nyrava's assistance. We
          do not provide legal advice, do not enter into attorney-client relationships with your
          clients, and do not review the contents of your matters.
        </p>
      </DocsSection>

      <DocsSection id="evidence" heading="Evidence verification & hallucination prevention">
        <p>
          Every finding surfaced by Nyrava is grounded to a specific passage in a source document
          and cited back to it. The pipeline includes an evidence gate that suppresses findings that
          cannot be traced to the corpus. When the model produces a plausible but unsupported
          statement, it is rejected before reaching a report.
        </p>
        <p>
          The verification layer runs on every engine — evidence intelligence, witness intelligence,
          contradiction detection, motion drafting, and report synthesis. Rejections are recorded in
          the pipeline ledger so reviewers can see what the model tried to assert and why it was
          suppressed.
        </p>
        <Callout variant="success" title="Authority verification">
          Case-law citations in motion drafts are checked against a legal-research provider before
          they appear in the editor. Fabricated citations are rejected.
        </Callout>
      </DocsSection>

      <DocsSection id="data" heading="Data ownership & isolation">
        <p>
          You own the content you upload. Nyrava's license to that content is strictly limited to
          providing the service to you. Your case content is not used to train general-purpose
          models, and it is not shared with other workspaces.
        </p>
        <p>
          When you configure your own AI provider keys (OpenAI, Anthropic, Gemini, Groq,
          OpenRouter), requests originating from your workspace are sent directly to the provider
          you selected under the contract you have with them.
        </p>
        <Callout variant="info" title="What our personnel can and cannot access">
          For an honest, technically-grounded breakdown of what Nyrava personnel can access, what
          they cannot, and under what exceptional circumstances access may occur, see the{" "}
          <Link to="/confidentiality" className="text-primary hover:underline">
            Attorney Confidentiality Commitment
          </Link>
          . We deliberately do not claim personnel are technically incapable of accessing customer
          data today — that claim requires customer-managed encryption keys, which are on our
          roadmap.
        </Callout>
      </DocsSection>

      <DocsSection id="encryption" heading="Encryption">
        <ul className="list-disc space-y-1 pl-5">
          <li>Data is encrypted in transit (TLS) between your browser and the platform.</li>
          <li>Data at rest is protected by the underlying managed infrastructure.</li>
          <li>
            Provider API keys and workspace secrets are encrypted before storage using AES-256-GCM.
          </li>
          <li>
            Access to production data is restricted to a small number of authorized engineers.
          </li>
        </ul>
      </DocsSection>

      <DocsSection id="availability" heading="System availability and incident handling">
        <p>
          Nyrava runs on managed cloud infrastructure with a stateless application tier and a
          managed database tier that takes automated backups. We have not yet performed a
          documented disaster-recovery restore drill, so we do not publish a recovery-time
          objective. Planned maintenance and material incidents are communicated to workspace
          administrators by email.
        </p>
        <p>
          We maintain an internal security incident response runbook covering detection, triage,
          containment, evidence preservation, scope determination, and notification assessment
          under Mexican personal-data rules, and every incident is recorded in an internal
          administrator-only incident register. We do not operate a 24/7 on-call rotation, an
          automated intrusion-detection system, or a public status page today.
        </p>
        <p>
          Enterprise deployments requiring formal service-level commitments should contact us before
          signing.
        </p>
      </DocsSection>


      <DocsSection id="limits" heading="AI limitations & human verification">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            AI models can make mistakes, miss context, or produce plausible-sounding but incorrect
            statements.
          </li>
          <li>Automated analysis is a starting point, never a final product.</li>
          <li>
            Attorneys must independently verify every output against source documents and applicable
            law before filing.
          </li>
          <li>
            Model behavior can shift when providers update their models; our router falls back
            across providers, but variance is real.
          </li>
        </ul>
        <Callout variant="warning" title="Not legal advice">
          Nyrava is a tool for licensed professionals. It does not provide legal advice, does not
          form attorney-client relationships, and does not replace the professional judgment of
          counsel.
        </Callout>
      </DocsSection>

      <DocsSection id="compliance" heading="Compliance roadmap & audit posture">
        <p>We do not claim certifications we have not earned. What is verified today:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Row-level security (RLS) enforced at the database layer on every user-data table (cases,
            documents, reports, canonical analysis, findings, subscriptions, provider keys).
          </li>
          <li>
            Every application server function is wrapped with authenticated middleware that
            validates the caller's session token against the auth service on every request.
          </li>
          <li>
            Administrative server functions perform a second server-side role check against a
            dedicated <code className="text-xs">user_roles</code> table (roles are never trusted
            from client state).
          </li>
          <li>
            User-supplied AI provider keys are encrypted at the application layer with AES-256-GCM
            before storage; a workspace admin cannot read another workspace's keys.
          </li>
          <li>
            The Stripe webhook endpoint verifies every payload with a signed-signature scheme; the
            background pipeline worker requires a constant-time-compared shared secret.

          </li>
          <li>
            Case-file uploads live in a private storage bucket scoped to the uploader's user ID;
            cross-tenant object reads are blocked at the storage policy layer.
          </li>
          <li>
            Internal database trigger functions were revoked from anonymous and signed-in execution
            — they are only reachable by the database itself.
          </li>
          <li>Encryption in transit (TLS) and at rest via managed infrastructure.</li>
        </ul>
        <p>
          On the roadmap (see{" "}
          <Link to="/roadmap" className="text-primary hover:underline">
            Roadmap
          </Link>
          ):
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Independent third-party penetration test before general availability to law firms.
          </li>
          <li>SOC 2 Type II readiness.</li>
          <li>Formal data-residency options for enterprise deployments.</li>
          <li>HIPAA BAA availability for regulated engagements.</li>
        </ul>
        <p>
          If your firm requires a specific certification today, contact us before onboarding and we
          will tell you honestly what stage that certification is at.
        </p>
      </DocsSection>

      <DocsSection id="faq" heading="Security FAQ">
        <div className="my-4 grid gap-3 sm:grid-cols-2">
          {[
            {
              q: "Is my case content used to train models?",
              a: "No. Nyrava does not use your case content to train general-purpose models.",
            },
            {
              q: "Can Nyrava staff read my case data?",
              a: "Access to production data is restricted to a small number of authorized engineers for maintenance and support, and every administrative action is audit-logged.",
            },
            {
              q: "What happens when I delete a case?",
              a: "The case and its documents are removed from your workspace. Backups age out on the managed infrastructure's retention schedule.",
            },
            {
              q: "Can I use my own AI provider keys?",
              a: "Yes. Add your OpenAI, Anthropic, Gemini, Groq, or OpenRouter key in Settings; requests for your workspace route directly to that provider.",
            },
            {
              q: "Is the data encrypted?",
              a: "Yes — TLS in transit, and at rest by the managed infrastructure. Provider API keys are additionally encrypted at the application layer.",
            },
            {
              q: "Are you certified?",
              a: "We are transparent about certifications. See the Compliance Roadmap above.",
            },
          ].map((f) => (
            <div key={f.q} className="rounded-lg border border-border/60 bg-card/30 p-4">
              <div className="text-[13.5px] font-semibold text-foreground">{f.q}</div>
              <div className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">{f.a}</div>
            </div>
          ))}
        </div>
      </DocsSection>

      <DocsSection id="contact" heading="Contact & responsible disclosure">
        <p>
          Security researchers and customers can report suspected vulnerabilities through the{" "}
          <Link to="/contact" className="text-primary hover:underline">
            Contact
          </Link>{" "}
          page. We appreciate responsible disclosure and will respond promptly. Do not attempt to
          access data that is not yours; we will treat good-faith research as such and coordinate on
          remediation.
        </p>
      </DocsSection>
    </DocsLayout>
  );
}
