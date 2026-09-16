import { createFileRoute, Link } from "@tanstack/react-router";
import {
  DocsLayout,
  DocsSection,
  Callout,
  StepList,
  FeatureGrid,
  FAQ,
  breadcrumbJsonLd,
  CANONICAL_BASE,
} from "@/components/DocsLayout";
import {
  Crown,
  ShieldCheck,
  Building2,
  Briefcase,
  User as UserIcon,
} from "lucide-react";

export const Route = createFileRoute("/learning-center")({
  head: () => {
    const url = `${CANONICAL_BASE}/learning-center`;
    const desc =
      "Centro de Aprendizaje de Nyrava México: configure su cuenta, gestione claves de proveedores, procese su primer expediente y capacite a su equipo legal.";
    return {
      meta: [
        { title: "Centro de Aprendizaje — Nyrava México" },
        { name: "description", content: desc },
        { property: "og:title", content: "Centro de Aprendizaje — Nyrava México" },
        { property: "og:description", content: desc },
        { property: "og:type", content: "website" },
        { property: "og:url", content: url },
        { name: "twitter:card", content: "summary_large_image" },
      ],
      links: [{ rel: "canonical", href: url }],
      scripts: [
        {
          type: "application/ld+json",
          children: breadcrumbJsonLd(CANONICAL_BASE, [
            { label: "Centro de aprendizaje", to: "/learning-center" },
          ]),
        },
      ],
    };
  },
  component: LearningCenter,
});

const ROLES = [
  {
    icon: Crown,
    label: "Super Admin",
    desc: "Unrestricted control of the platform — billing, providers, and all users.",
    focus: "Should read: Account setup, API keys, Security.",
  },
  {
    icon: ShieldCheck,
    label: "Admin",
    desc: "Manages cases, users, and AI providers within the firm.",
    focus: "Should read: API keys, User roles, Best practices.",
  },
  {
    icon: Building2,
    label: "Firm Admin",
    desc: "Firm-level access and configuration; typically the first account created.",
    focus: "Should read: Everything in this guide, top to bottom.",
  },
  {
    icon: Briefcase,
    label: "Case Manager",
    desc: "Creates and runs cases day to day — uploading, running the pipeline, exporting reports.",
    focus: "Should read: Running your first case, What to expect, Best practices.",
  },
  {
    icon: UserIcon,
    label: "Standard User",
    desc: "Reviews findings, verifies citations, and uses generated drafts as a starting point.",
    focus: "Should read: What to expect, Reviewing & verifying findings.",
  },
];

function LearningCenter() {
  return (
    <DocsLayout
      eyebrow="Learning Center"
      title="Learn Nyrava, end to end"
      description="A single walkthrough for getting your account set up, connecting AI providers, running your first case, and training your whole team to use it well."
      crumbs={[{ label: "Learning Center", to: "/learning-center" }]}
      toc={[
        { id: "overview", label: "Overview & who this is for" },
        { id: "account", label: "1. Set up your account" },
        { id: "keys", label: "2. Add your AI provider keys" },
        { id: "team", label: "3. Invite your team & assign roles" },
        { id: "first-case", label: "4. Run your first case" },
        { id: "expect", label: "5. What to expect from results" },
        { id: "verify", label: "6. Reviewing & verifying findings" },
        { id: "best-practices", label: "7. Getting the best results" },
        { id: "training", label: "8. Training your team" },
        { id: "faq", label: "FAQ" },
      ]}
      related={[
        { label: "Running your first case", to: "/help/first-case", description: "The deep-dive version of step 4." },
        { label: "API keys & providers", to: "/help/api-keys", description: "Full provider list and failover behavior." },
        { label: "Uploading documents", to: "/help/uploading", description: "File types, OCR, batching." },
        { label: "Understanding reports", to: "/help/reports", description: "The 17 canonical report sections." },
      ]}
    >
      <DocsSection id="overview" heading="Overview & who this is for">
        <p>
          This guide is the fastest path from a brand-new Nyrava account to a firm that runs cases
          confidently and trains new hires without hand-holding. It's written for whoever is
          standing the platform up — usually a Firm Admin or Admin — but every section notes what
          each role on your team actually needs to know.
        </p>
        <FeatureGrid
          items={[
            { title: "~15 minutes", description: "To create your account, add a key, and launch your first case." },
            { title: "No AI expertise required", description: "Nyrava's defaults work out of the box; provider keys are optional tuning." },
            { title: "Built for teams", description: "Role-based access means each person only sees what their job requires." },
          ]}
        />
      </DocsSection>

      <DocsSection id="account" heading="1. Set up your account">
        <StepList
          steps={[
            { title: "Create your account", description: "Go to Sign In → Sign Up using your work email address, not a personal Gmail/Outlook/Yahoo address." },
            { title: "Firm grouping happens automatically", description: "Nyrava recognizes your email domain and groups you with everyone else at your firm who signs up the same way — there's no workspace name to set up." },
            { title: "Accept the Terms of Service & Privacy Policy", description: "Required once per account. Review the Trust Center if your firm needs it for a vendor security review." },
            { title: "Confirm your email and sign in", description: "You'll land on the Command Center dashboard — this is home base for every case." },
          ]}
        />
        <Callout variant="warning" title="Use your firm's email domain">
          Firm grouping is based on the domain in your email address (e.g. everyone @yourfirm.com).
          Personal email providers (Gmail, Outlook, Yahoo, etc.) are excluded from this, so
          signing up with a personal address won't group you with your colleagues.
        </Callout>
      </DocsSection>

      <DocsSection id="keys" heading="2. Add your AI provider keys">
        <p>
          This step is <strong>optional</strong> — Nyrava works out of the box on its built-in
          providers. Add your own keys if your firm has an existing OpenAI, Anthropic, Gemini,
          Groq, or OpenRouter relationship, wants direct billing, or has a compliance requirement
          to use its own vendor account.
        </p>
        <StepList
          steps={[
            { title: "Open Settings → API Keys", description: "Available to Admin and above." },
            { title: "Paste your provider key", description: "Nyrava validates the key immediately and encrypts it at rest with AES-256-GCM before storing it." },
            { title: "Repeat for additional providers (optional)", description: "Configuring more than one lets the router fail over automatically if a provider errors or throttles." },
            { title: "Leave it blank if you're not sure yet", description: "You can add keys later — nothing blocks you from running a case in the meantime." },
          ]}
        />
        <Callout variant="tip" title="Direct billing">
          When you use your own key, that provider bills your firm directly under its own pricing.
          Nyrava's subscription covers the platform, not model tokens. Full detail on the{" "}
          <Link to="/help/api-keys" className="text-primary hover:underline">API keys page</Link>.
        </Callout>
      </DocsSection>

      <DocsSection id="team" heading="3. Invite your team & assign roles">
        <p>
          Go to <strong>Admin → Team &amp; Seats</strong> to invite teammates by email. They don't
          set a password or fill anything out ahead of time — they just sign up normally with that
          same email address, and the moment they do, they land in your firm with the role you
          picked. Everyone starts as a Standard User by default until a role is assigned. Nyrava
          uses five tiers, from broadest to narrowest:
        </p>
        <div className="my-6 grid gap-3 sm:grid-cols-2">
          {ROLES.map(({ icon: Icon, label, desc }) => (
            <div key={label} className="rounded-lg border border-border/60 bg-card/30 p-4">
              <div className="flex items-center gap-2">
                <Icon className="h-4 w-4 text-primary" />
                <div className="text-[13.5px] font-semibold text-foreground">{label}</div>
              </div>
              <div className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">{desc}</div>
            </div>
          ))}
        </div>
        <Callout variant="info" title="Seats are tied to your plan">
          Solo includes 1 seat, Firm includes 10, and Enterprise defaults to 50 (custom counts
          available on request). The invite form shows how many seats you have left and blocks new
          invites once you're at your limit — upgrade from Admin → Team &amp; Seats to add more.
        </Callout>
        <Callout variant="tip" title="Start narrow">
          Invite people as Standard User or Case Manager by default and promote to Firm Admin only
          when they actually need to manage billing, providers, or other people's roles. It's easy
          to widen access later — harder to audit after the fact.
        </Callout>
      </DocsSection>

      <DocsSection id="first-case" heading="4. Run your first case">
        <StepList
          steps={[
            { title: "Click New Case from the dashboard", description: "Name it using an internal-facing label — it's only visible inside your firm's account." },
            { title: "Pick a case type", description: "Criminal, civil, appellate, family, tax, etc. This determines which intelligence engines run." },
            { title: "Upload the full record", description: "Drag in the entire production. Scanned PDFs and photographed exhibits run through OCR automatically." },
            { title: "Click Run Pipeline", description: "Engines execute in sequence — Evidence → Timeline → Witness → Constitutional → Strategy → Motion (if requested) → Report. Progress streams live." },
            { title: "Open the panels as they complete", description: "Evidence, Timeline, Witness, and Constitutional findings appear as each engine finishes — you don't have to wait for the whole run." },
          ]}
        />
        <p>
          Want the fully detailed walkthrough, including prerequisites and export formats? See{" "}
          <Link to="/help/first-case" className="text-primary hover:underline">Running your first case</Link>.
        </p>
      </DocsSection>

      <DocsSection id="expect" heading="5. What to expect from results">
        <p>
          Nyrava produces findings, not verdicts. Here's what a first run typically surfaces and how
          long it takes:
        </p>
        <FeatureGrid
          items={[
            { title: "Cited findings", description: "Every finding links back to the exact source passage — click any citation to see it in context." },
            { title: "A reconstructed timeline", description: "Events pulled from across the record, ordered and cross-referenced automatically." },
            { title: "Contradictions & clusters", description: "Witness statements grouped and checked against each other for inconsistencies." },
            { title: "Draft work product", description: "Motions and reports are first drafts grounded in the record — a starting point, not a filing." },
          ]}
        />
        <Callout variant="warning" title="Larger productions take longer">
          Indexing and analysis scale with corpus size. A few hundred pages typically finishes in
          minutes; very large productions uploaded in batches will keep indexing in the background
          while earlier batches are already searchable.
        </Callout>
      </DocsSection>

      <DocsSection id="verify" heading="6. Reviewing & verifying findings">
        <p>
          Nyrava is built to be checked, not trusted blindly. Before anything leaves your desk:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Click through citations on any finding you plan to rely on — confirm the source says what the summary claims.</li>
          <li>Reject or edit findings that need attorney judgment; Nyrava flags likely issues, it doesn't make legal conclusions.</li>
          <li>Treat generated motions and reports as first drafts — review and revise before filing or sending.</li>
        </ul>
        <p>
          This mirrors Nyrava's own{" "}
          <Link to="/responsible-ai" className="text-primary hover:underline">Responsible AI</Link>{" "}
          principles and{" "}
          <Link to="/ai-transparency" className="text-primary hover:underline">AI Transparency</Link>{" "}
          commitments — worth a read before rolling this out firm-wide.
        </p>
      </DocsSection>

      <DocsSection id="best-practices" heading="7. Getting the best results">
        <ul className="list-disc space-y-1 pl-5">
          <li><strong>Upload the full record, not excerpts.</strong> Contradiction detection, witness clustering, and timeline reconciliation all improve with the complete corpus.</li>
          <li><strong>Use descriptive filenames and bates ranges.</strong> <code>SMITH000123-000145_Dep_Chen.pdf</code> resolves cleaner citations than <code>doc7.pdf</code>.</li>
          <li><strong>Re-run Evidence Intelligence after supplemental productions.</strong> Prior citations stay valid; new findings are appended, not overwritten.</li>
          <li><strong>Configure a second provider key</strong> if uptime matters for your workflow — the router fails over automatically.</li>
          <li><strong>Keep case types accurate.</strong> The case type controls which engines run, so a mismatched type means some analysis simply won't fire.</li>
        </ul>
      </DocsSection>

      <DocsSection id="training" heading="8. Training your team">
        <p>
          For firm-wide rollout, don't hand new hires the whole platform at once. A short,
          role-based path gets people productive fastest:
        </p>
        <StepList
          steps={[
            { title: "Have them read this page first", description: "It's the 15-minute version of everything below." },
            { title: "Shadow one real case", description: "Have a new user watch an experienced Case Manager run a case from upload to export before running their own." },
            { title: "Assign the narrowest role that fits the job", description: "See the role table in step 3 — most new hires start as Standard User or Case Manager." },
            { title: "Point them at the deep-dive docs for their job", description: "Case Managers → Running your first case & Uploading documents. Reviewers → What to expect & Reviewing findings above." },
            { title: "Set a verification norm early", description: "Make citation-checking part of your firm's workflow from day one — it's much harder to retrofit a habit later." },
          ]}
        />
        <Callout variant="success" title="Keep this page bookmarked">
          The Learning Center stays current as the platform evolves — it's a good default landing
          page to send new hires instead of an internal wiki that goes stale.
        </Callout>
      </DocsSection>

      <DocsSection id="faq" heading="FAQ">
        <FAQ
          items={[
            {
              q: "Do we have to add our own API keys to use Nyrava?",
              a: "No. Nyrava works on its built-in providers by default. Bring your own keys only if you want direct billing, a specific model, or already have a provider relationship.",
            },
            {
              q: "How does a new teammate get access?",
              a: "You invite them by email from Admin → Team & Seats. They sign up themselves with that email — no password to hand over — and land in your firm with the role you assigned.",
            },
            {
              q: "How many people can we add?",
              a: "It depends on your plan: Solo includes 1 seat, Firm includes 10, Enterprise defaults to 50 (custom counts available). Seats used = active members plus any pending invites you haven't revoked yet.",
            },
            {
              q: "Can a Standard User upload documents and run a case?",
              a: "Case creation and pipeline runs are available to Case Manager and above. Standard Users typically review findings and use generated drafts rather than run the pipeline themselves — check your firm's role assignments in Admin → Users & Roles.",
            },
            {
              q: "What happens if we upload a supplemental production later?",
              a: "Rerun Evidence Intelligence. Existing citations remain valid and new findings are appended — nothing is overwritten.",
            },
            {
              q: "Is the generated report or motion ready to file?",
              a: "No — treat every generated document as a first draft grounded in the record. Attorney review and verification is required before anything is filed or sent.",
            },
          ]}
        />
      </DocsSection>
    </DocsLayout>
  );
}
