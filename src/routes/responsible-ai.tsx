import { createFileRoute } from "@tanstack/react-router";
import { DocsLayout, DocsSection, Callout } from "@/components/DocsLayout";

export const Route = createFileRoute("/responsible-ai")({
  head: () => ({
    meta: [
      { title: "Política de IA Responsable — Nyrava México" },
      { name: "description", content: "Principios de gobernanza e inteligencia artificial responsable en el sistema jurídico mexicano: fundamentación obligatoria, control del abogado y cero alucinaciones." },
      { property: "og:url", content: "https://mexico.nyrava.com/responsible-ai" },
      { name: "twitter:url", content: "https://mexico.nyrava.com/responsible-ai" },
      { property: "og:title", content: "Política de IA Responsable — Nyrava México" },
      { property: "og:description", content: "Principios de gobernanza e inteligencia artificial responsable en el sistema jurídico mexicano." },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://mexico.nyrava.com/responsible-ai" }],
  }),
  component: () => (
    <DocsLayout
      eyebrow="Legal"
      title="Responsible AI Policy"
      description="Principles that govern how Nyrava builds, evaluates, and deploys AI-assisted legal intelligence."
      crumbs={[{ label: "Legal" }, { label: "Responsible AI" }]}
      updated="2026-07-22"
      toc={[
        { id: "principles", label: "Principles" },
        { id: "grounding", label: "Grounding & citations" },
        { id: "limits", label: "Known limitations" },
        { id: "human", label: "Human oversight" },
        { id: "no-training", label: "No content training" },
        { id: "prohibited", label: "Prohibited uses" },
      ]}
    >
      <DocsSection id="principles" heading="Principles">
        <p>Nyrava's use of AI is governed by six commitments:</p>
        <ol className="list-decimal space-y-2 pl-5">
          <li><strong>Attorney in control.</strong> AI proposes. Attorneys decide.</li>
          <li><strong>Evidence first.</strong> Analysis is grounded in your documents, not the model's training data.</li>
          <li><strong>Transparency.</strong> Every engine run and rejection is auditable.</li>
          <li><strong>Verification.</strong> Cited authorities are verified before appearing in drafts.</li>
          <li><strong>Privacy.</strong> Your case content is not used to train general-purpose models.</li>
          <li><strong>No replacement of judgment.</strong> Nyrava does not practice law.</li>
        </ol>
      </DocsSection>

      <DocsSection id="grounding" heading="Grounding & citations">
        <p>
          Every factual claim surfaced by Nyrava is anchored to a specific passage in a document you
          uploaded. The evidence gate suppresses claims that cannot be grounded. Authority citations
          in motion drafts are checked before they reach the editor.
        </p>
      </DocsSection>

      <DocsSection id="limits" heading="Known limitations">
        <ul className="list-disc space-y-2 pl-5">
          <li>AI models can make mistakes, miss context, or produce plausible but incorrect output.</li>
          <li>Automated analysis is a starting point, never a final product.</li>
          <li>Users must independently verify every output against source documents and applicable law before filing or reliance.</li>
          <li>Model behavior can shift when providers update their models. We maintain a router to fall back across providers, but variance is real.</li>
        </ul>
        <Callout variant="warning" title="Not legal advice">
          Nyrava is a tool for licensed professionals. It does not provide legal advice, does not
          form attorney-client relationships, and does not replace the professional judgment of
          counsel.
        </Callout>
      </DocsSection>

      <DocsSection id="human" heading="Human oversight">
        <p>
          Every output produced by Nyrava — timelines, motions, reports, findings — is designed to
          be reviewed by a qualified legal professional before use in an actual matter. The product
          surface makes verification (through inline citations) the default action, not an afterthought.
        </p>
      </DocsSection>

      <DocsSection id="no-training" heading="No content training">
        <p>
          Nyrava does not use your case content to train general-purpose models. When you configure
          your own provider API key, requests originating from your workspace are sent directly to
          that provider under the contractual terms you have with them.
        </p>
      </DocsSection>

      <DocsSection id="prohibited" heading="Prohibited uses">
        <p>See our <a href="/acceptable-use" className="text-primary hover:underline">Acceptable Use Policy</a> for the full list of prohibited uses.</p>
      </DocsSection>
    </DocsLayout>
  ),
});
