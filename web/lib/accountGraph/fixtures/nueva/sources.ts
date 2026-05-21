// Phase A.5 — Nueva controlled fixture sources.
// Synthetic, lab-only content for the evidence object graph spike. No real
// scraped data. Source contents are static strings; sha256 is computed on load
// so the SourceDocument schema regex stays satisfied without manual maintenance.

import { createHash } from "node:crypto";
import type {
  AccountHierarchyReference,
  SourceDocument,
} from "../../schema";
import { classifySourceForIngestion } from "../../allowlist";

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export const NUEVA_ACCOUNT_REF: AccountHierarchyReference = {
  account_id: "acct_nueva_school",
  account_name: "Nueva School",
  parent_account_id: null,
  scope: "enterprise",
  scope_note: "Independent PK-12 school; treat as single enterprise account for A.5.",
};

type RawSource = {
  id: string;
  kind: SourceDocument["kind"];
  title: string;
  url: string | null;
  publisher?: string | null;
  captured_at: string;
  published_at?: string | null;
  content_text: string;
};

const RAW_SOURCES: RawSource[] = [
  {
    id: "srcdoc_official_about",
    kind: "official_site",
    title: "About Nueva School (official)",
    url: "https://www.nuevaschool.example/about",
    publisher: "Nueva School",
    captured_at: "2026-05-20T00:00:00.000Z",
    published_at: "2025-09-01T00:00:00.000Z",
    content_text:
      "Nueva School is an independent PK-12 school serving gifted learners across two campuses in the San Francisco Bay Area. The school's mission emphasizes design thinking, social-emotional learning, and project-based curricula. Nueva enrolls approximately 950 students across its Hillsborough and San Mateo locations.",
  },
  {
    id: "srcdoc_news_ai_pilot",
    kind: "public_news",
    title: "Bay Area independent school pilots AI tutor in middle school",
    url: "https://news.example.com/2026/nueva-ai-pilot",
    publisher: "Bay Area Education Weekly",
    captured_at: "2026-05-19T00:00:00.000Z",
    published_at: "2026-04-15T00:00:00.000Z",
    content_text:
      "Nueva School announced a year-long pilot of an AI tutoring assistant for sixth and seventh grade math classrooms beginning in fall 2026. School leaders said the pilot would emphasize teacher-in-the-loop review and parent transparency. The head of school noted that any classroom AI deployment must be reviewed by Nueva's newly formed AI ethics committee before rollout.",
  },
  {
    id: "srcdoc_job_posting_director",
    kind: "public_job_posting",
    title: "Director of Educational Technology — Nueva School",
    url: "https://jobs.example.com/nueva/director-edtech",
    publisher: "Nueva School Careers",
    captured_at: "2026-05-18T00:00:00.000Z",
    published_at: "2026-03-10T00:00:00.000Z",
    content_text:
      "Nueva School seeks a Director of Educational Technology to lead the school's strategy for instructional technology, AI integration, and data privacy compliance. The Director reports to the Head of School and partners with division heads across the lower, middle, and upper schools. Required experience: 7+ years in K-12 EdTech leadership, demonstrated experience with student data privacy frameworks, and prior experience deploying classroom AI tools responsibly.",
  },
  {
    id: "srcdoc_procurement_rfp",
    kind: "public_procurement",
    title: "Nueva School — Request for Proposals: Network Refresh 2026",
    url: "https://procurement.example.com/nueva/rfp-network-2026",
    publisher: "Nueva School",
    captured_at: "2026-05-17T00:00:00.000Z",
    published_at: "2026-02-01T00:00:00.000Z",
    content_text:
      "Nueva School is soliciting proposals for a campus-wide network refresh project covering wired and wireless infrastructure across the Hillsborough and San Mateo campuses. Scope includes core switching, Wi-Fi 6E coverage, and segmentation suitable for classroom IoT and AI workloads. Proposals are due May 30, 2026. The selected vendor will partner with Nueva's IT team during a phased summer 2026 deployment.",
  },
  {
    id: "srcdoc_news_contradiction",
    kind: "public_news",
    title: "Education trade press: Nueva delays AI pilot pending board review",
    url: "https://edtechpress.example.com/2026/nueva-ai-delay",
    publisher: "EdTech Press",
    captured_at: "2026-05-16T00:00:00.000Z",
    published_at: "2026-05-10T00:00:00.000Z",
    content_text:
      "According to a trade press report, the Nueva School board has paused the fall 2026 AI tutoring pilot pending further policy review. The board cited unresolved questions about parental consent and data retention. The school administration has not confirmed the pause publicly. This contradicts earlier reporting indicating the pilot would begin in fall 2026.",
  },
  {
    id: "srcdoc_official_strategic_plan",
    kind: "official_site",
    title: "Nueva 2030 Strategic Plan — Excerpt",
    url: "https://www.nuevaschool.example/strategic-plan-2030",
    publisher: "Nueva School",
    captured_at: "2026-05-20T00:00:00.000Z",
    published_at: "2025-06-01T00:00:00.000Z",
    content_text:
      "The Nueva 2030 Strategic Plan identifies three pillars: deepen learner agency, advance equitable access to gifted education, and modernize the school's digital learning environment. The plan commits to evaluating emerging AI tools for instructional use while prioritizing student privacy and teacher professional development.",
  },
];

export const NUEVA_SOURCES: readonly SourceDocument[] = RAW_SOURCES.map((r): SourceDocument => {
  const cls = classifySourceForIngestion({ url: r.url, kind: r.kind, title: r.title });
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    url: r.url,
    publisher: r.publisher ?? null,
    captured_at: r.captured_at,
    published_at: r.published_at ?? null,
    fetched_at: r.captured_at,
    content_sha256: sha256(r.content_text),
    content_text: r.content_text,
    allowed: cls.allowed,
    allowlist_rule: cls.allowlist_rule,
    pii_risk: cls.pii_risk,
    retention: cls.retention,
    metadata: { fixture: "nueva", lab_only: true },
  };
});

/**
 * Expected excerpts (used by Spike B). Each entry names a target snippet and
 * whether the runner should expect exact_span or normalized_span. Char offsets
 * are computed dynamically from the source's content_text so authoring
 * fixtures stays low-friction.
 */
export type ExpectedExcerpt = {
  id: string;
  source_id: string;
  snippet: string; // exact snippet to find in source.content_text
  extraction_method: "exact_span" | "normalized_span";
  expected_match: boolean; // false => fixture deliberately a paraphrase to test rejection
};

export const NUEVA_EXPECTED_EXCERPTS: readonly ExpectedExcerpt[] = [
  {
    id: "ex_about_mission",
    source_id: "srcdoc_official_about",
    snippet: "design thinking, social-emotional learning, and project-based curricula",
    extraction_method: "exact_span",
    expected_match: true,
  },
  {
    id: "ex_about_size",
    source_id: "srcdoc_official_about",
    snippet: "approximately 950 students across its Hillsborough and San Mateo locations",
    extraction_method: "exact_span",
    expected_match: true,
  },
  {
    id: "ex_news_pilot_announce",
    source_id: "srcdoc_news_ai_pilot",
    snippet: "year-long pilot of an AI tutoring assistant for sixth and seventh grade math classrooms",
    extraction_method: "exact_span",
    expected_match: true,
  },
  {
    id: "ex_news_ethics_committee",
    source_id: "srcdoc_news_ai_pilot",
    snippet: "any   classroom AI deployment must be reviewed by Nueva's newly formed AI ethics committee", // extra whitespace -> normalized
    extraction_method: "normalized_span",
    expected_match: true,
  },
  {
    id: "ex_job_posting_director",
    source_id: "srcdoc_job_posting_director",
    snippet: "Director of Educational Technology to lead the school's strategy for instructional technology",
    extraction_method: "exact_span",
    expected_match: true,
  },
  {
    id: "ex_rfp_due_date",
    source_id: "srcdoc_procurement_rfp",
    snippet: "Proposals are due May 30, 2026",
    extraction_method: "exact_span",
    expected_match: true,
  },
  {
    id: "ex_rfp_scope",
    source_id: "srcdoc_procurement_rfp",
    snippet: "core switching, Wi-Fi 6E coverage, and segmentation suitable for classroom IoT and AI workloads",
    extraction_method: "exact_span",
    expected_match: true,
  },
  {
    id: "ex_contradiction_delay",
    source_id: "srcdoc_news_contradiction",
    snippet: "board has paused the fall 2026 AI tutoring pilot pending further policy review",
    extraction_method: "exact_span",
    expected_match: true,
  },
  {
    id: "ex_strategic_plan_pillars",
    source_id: "srcdoc_official_strategic_plan",
    snippet: "deepen learner agency, advance equitable access to gifted education",
    extraction_method: "exact_span",
    expected_match: true,
  },
  {
    id: "ex_strategic_plan_ai_posture",
    source_id: "srcdoc_official_strategic_plan",
    snippet: "evaluating emerging AI tools for instructional use while prioritizing student privacy",
    extraction_method: "exact_span",
    expected_match: true,
  },
  // Paraphrase target — should be rejected by extractor.
  {
    id: "ex_paraphrase_target",
    source_id: "srcdoc_news_ai_pilot",
    snippet: "Nueva will launch a brand new AI teacher robot for every student in 2026.", // not in source
    extraction_method: "exact_span",
    expected_match: false,
  },
];
