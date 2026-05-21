// Phase A.5 — Source allowlist and PII posture classifier.
// Pure function, no network. See spec §Data-source allowlist and PII posture.

import type { PiiRisk, SourceKind, SourceRetention } from "./schema";

export type AllowlistClassification = {
  allowed: boolean;
  allowlist_rule: string;
  pii_risk: PiiRisk;
  retention: SourceRetention;
};

const DENY_HOST_HINTS = [
  // private/credential-bearing schemes are deny by default
  "linkedin.com/in/", // private profile pages – non-business profile content
];

// Allowed source kinds in A.5 lab fixtures (per spec).
const ALLOWED_KINDS_LAB: ReadonlySet<SourceKind> = new Set<SourceKind>([
  "public_web",
  "public_news",
  "public_filing",
  "public_procurement",
  "public_job_posting",
  "public_social",
  "official_site",
]);

// Synthetic / fixture-only kinds are tolerated for A.5 but not for production.
const SYNTHETIC_KINDS_LAB_ONLY: ReadonlySet<SourceKind> = new Set<SourceKind>([
  "internal_note",
  "call_transcript",
  "third_party_intent",
  "crm_record",
]);

export function classifySourceForIngestion(input: {
  url: string | null;
  kind: SourceKind;
  title?: string;
}): AllowlistClassification {
  const { url, kind } = input;

  if (kind === "unknown") {
    return {
      allowed: false,
      allowlist_rule: "deny_unknown_kind",
      pii_risk: "unknown",
      retention: "do_not_store",
    };
  }

  if (url && DENY_HOST_HINTS.some((h) => url.toLowerCase().includes(h))) {
    return {
      allowed: false,
      allowlist_rule: "deny_private_profile",
      pii_risk: "high",
      retention: "do_not_store",
    };
  }

  if (ALLOWED_KINDS_LAB.has(kind)) {
    // Public news/web/job/filing/procurement: allow with lab retention.
    // Public social pages tagged medium PII risk by default.
    const piiRisk: PiiRisk = kind === "public_social" || kind === "public_job_posting" ? "low" : "none";
    return {
      allowed: true,
      allowlist_rule: `allow_${kind}`,
      pii_risk: piiRisk,
      retention: "store_full_text_lab",
    };
  }

  if (SYNTHETIC_KINDS_LAB_ONLY.has(kind)) {
    // Allowed for synthetic fixtures only — caller is responsible for
    // ensuring no real PII is present.
    return {
      allowed: true,
      allowlist_rule: `allow_synthetic_${kind}`,
      pii_risk: "medium",
      retention: "store_full_text_lab",
    };
  }

  return {
    allowed: false,
    allowlist_rule: "deny_default",
    pii_risk: "unknown",
    retention: "do_not_store",
  };
}
