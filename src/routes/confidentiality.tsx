import { createFileRoute, Link } from "@tanstack/react-router";
import { LegalPage, Section } from "@/components/LegalPage";

export const Route = createFileRoute("/confidentiality")({
  head: () => {
    const url = "https://mexico.nyrava.com/confidentiality";
    const desc =
      "What Nyrava personnel can and cannot access. An honest, technically-grounded statement of our attorney confidentiality posture.";
    return {
      meta: [
        { title: "Attorney Confidentiality Commitment — Nyrava" },
        { name: "description", content: desc },
        { property: "og:title", content: "Attorney Confidentiality Commitment — Nyrava" },
        { property: "og:description", content: desc },
        { property: "og:type", content: "website" },
        { property: "og:url", content: url },
        { name: "twitter:card", content: "summary_large_image" },
      ],
      links: [{ rel: "canonical", href: url }],
    };
  },
  component: ConfidentialityPage,
});

function ConfidentialityPage() {
  return (
    <LegalPage
      eyebrow="Trust"
      title="Attorney Confidentiality Commitment"
      updated="2026-07-23"
      intro={
        <p>
          Attorneys upload their most sensitive material to Nyrava — witness statements, client
          communications, discovery, and work product. This page is a plain-language,
          technically-grounded statement of what Nyrava personnel can access, what they cannot, and
          under what exceptional circumstances access may occur. Every statement here reflects the
          architecture we have built today — not what we hope to build later. Where our architecture
          does not yet support a stronger claim, we say so.
        </p>
      }
    >
      <Section heading="The principle">
        <p>
          Nyrava is designed so that customer case files are not routinely accessible to company
          personnel. Administrative access is tightly restricted, logged, and governed by the
          principle of least privilege. We do not browse attorney work product as part of normal
          operations.
        </p>
        <p>
          We deliberately do not claim that Nyrava employees are technically incapable of accessing
          customer data under any circumstance. That claim requires an architecture (for example,
          customer-managed encryption keys where the platform operator never holds the decryption
          key) that we have not yet built. We would rather be honest today than overstate
          protections.
        </p>
      </Section>

      <Section heading="What Nyrava personnel do NOT do">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            We do not read your case files, motions, witness statements, or reports as part of
            normal operations.
          </li>
          <li>We do not use your case content to train general-purpose AI models.</li>
          <li>We do not share your case content across workspaces or with other customers.</li>
          <li>We do not sell, rent, or market against the contents of your matters.</li>
          <li>
            Firm administrators in one firm cannot see cases belonging to another firm; individual
            accounts cannot see any other account's cases.
          </li>
        </ul>
      </Section>

      <Section heading="What Nyrava personnel CAN technically access">
        <p>Honest disclosure of the technical reality of running a managed SaaS platform:</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong>Database administrators.</strong> A small number of authorized engineers hold
            credentials capable of privileged database operations on the production database.
            Row-level security protects against application-layer bugs, not against a person
            authenticated with database-administrator credentials.
          </li>
          <li>
            <strong>Cloud provider operators.</strong> The underlying managed cloud infrastructure
            (compute, storage, backups) is operated by third-party providers with their own
            operational access under their published security controls.
          </li>
          <li>
            <strong>Storage administrators.</strong> Files uploaded to case storage are stored in a
            private bucket that requires per-user-scoped policies to read. Personnel with storage
            administrator credentials could technically access raw objects if those credentials were
            used.
          </li>
          <li>
            <strong>AI provider processors.</strong> When your workspace uses Nyrava-managed
            inference, request content is sent to model providers (currently including Groq, Google,
            OpenAI-compatible gateways) under their contractual data-handling terms. When you bring
            your own key, requests go directly to the provider you selected under your contract with
            them.
          </li>
          <li>
            <strong>Backups.</strong> The managed database maintains continuous backups and
            point-in-time recovery for disaster recovery. Backups inherit the access controls of the
            underlying infrastructure.
          </li>
          <li>
            <strong>Encrypted secrets.</strong> Your provider API keys are encrypted with
            AES-256-GCM before storage using a server-controlled encryption key. Personnel with
            access to both the ciphertext and the encryption key could technically decrypt them;
            both are held on the server side.
          </li>
        </ul>
      </Section>

      <Section heading="Exceptional circumstances where access may occur">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Debugging a specific customer-reported issue, only with the affected customer's request
            or consent, and only for the minimum necessary scope.
          </li>
          <li>
            Compliance with a valid legal process (subpoena, court order) that we cannot lawfully
            resist. Where lawfully permitted, we will notify the affected customer.
          </li>
          <li>
            Investigation of suspected abuse of the platform (for example, use in violation of the
            Acceptable Use Policy).
          </li>
          <li>
            Emergencies affecting the security or integrity of the platform (for example, incident
            response to an active compromise).
          </li>
        </ul>
        <p>
          Access under any of the above circumstances is limited to the smallest set of personnel
          required, logged, and reviewed.
        </p>
      </Section>

      <Section heading="Controls we have implemented today">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Row-level security enforced at the database layer on every user-data table (cases,
            documents, canonical analysis, findings, API keys, subscriptions).
          </li>
          <li>
            Every application server function is wrapped with authenticated middleware that
            validates the caller's session token on every request.
          </li>
          <li>
            Administrative capabilities require a second server-side role check against a dedicated{" "}
            <code className="text-xs">user_roles</code> table; roles are never trusted from client
            state.
          </li>
          <li>
            Case-file uploads live in a private storage bucket scoped to the uploader's user ID;
            cross-workspace object reads are blocked at the storage policy layer.
          </li>
          <li>
            User-supplied AI provider keys are encrypted at the application layer with AES-256-GCM
            before storage.
          </li>
          <li>
            The Stripe webhook verifies every payload with a signed-signature scheme; the
            background pipeline worker requires a constant-time-compared shared secret.

          </li>
          <li>
            Internal database trigger functions were revoked from anonymous and signed-in execution
            — they are only reachable by the database itself.
          </li>
          <li>Encryption in transit (TLS) and at rest via the managed infrastructure.</li>
          <li>
            Auditable pipeline ledger: every intelligence engine run writes inputs, model, tokens,
            and outcome to a per-user log.
          </li>
          <li>
            Your own{" "}
            <Link to="/security-dashboard" className="text-primary hover:underline">
              Security Dashboard
            </Link>{" "}
            exposes sign-in status, MFA, API keys, and recent activity for the account you control.
          </li>
        </ul>
      </Section>

      <Section heading="Roadmap toward operator-blind design">
        <p>
          We are actively working toward reducing the surface where Nyrava personnel can technically
          access customer content. Prioritized:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Customer-managed encryption keys (CMEK) for case content, so the platform operator
            cannot decrypt objects at rest under normal operation.
          </li>
          <li>
            Field-level encryption for the most sensitive analysis payloads, with keys derived per
            workspace.
          </li>
          <li>
            Independent third-party penetration test before general availability to law firms.
          </li>
          <li>
            SOC 2 Type II readiness, with attested controls covering personnel access to production.
          </li>
          <li>Formal data-residency options for enterprise deployments.</li>
          <li>HIPAA BAA availability for regulated engagements.</li>
          <li>
            Per-access audit trail visible to firm administrators for the small number of
            exceptional-circumstance accesses described above.
          </li>
        </ul>
        <p>We will not claim any of the above until it is implemented and verifiable.</p>
      </Section>

      <Section heading="What you control">
        <ul className="list-disc space-y-1 pl-5">
          <li>Enable multi-factor authentication on your account.</li>
          <li>
            Bring your own AI provider keys so inference runs under your contract with the provider.
          </li>
          <li>
            Export or delete your workspace data at any time — see{" "}
            <Link to="/data-control" className="text-primary hover:underline">
              Data Control
            </Link>
            .
          </li>
          <li>
            Review your account's own activity in the{" "}
            <Link to="/security-dashboard" className="text-primary hover:underline">
              Security Dashboard
            </Link>
            .
          </li>
        </ul>
      </Section>

      <Section heading="Reporting concerns">
        <p>
          If you believe an access has occurred outside the boundaries described above, or you want
          to discuss a specific confidentiality requirement your firm has, please reach us via the{" "}
          <Link to="/contact" className="text-primary hover:underline">
            Contact
          </Link>{" "}
          page. Security researchers can also use that page for responsible disclosure.
        </p>
      </Section>
    </LegalPage>
  );
}
