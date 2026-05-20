/**
 * Deterministic Canvas proposal fixtures for the lab review UX.
 *
 * Phase B safety:
 * - No provider/network calls.
 * - All actions are normal CanvasAction values that flow through the existing
 *   `ingestCanvasResponse` rails (schema validation, canSourcePropose, reducer).
 * - The capability proposal carries a non-executable text source that is only
 *   displayed in the inert capability viewer.
 */

import { ingestCanvasResponse, type CanvasGatewayContext } from "./canvasGenerativeGateway";

const SEED_REQUEST_PREFIX = "lab-seed-review-ux";

export function seedReviewProposals(ctx: CanvasGatewayContext): { proposal_ids: string[]; capability_proposal_ids: string[] } {
  // Stable per-brief request id so repeated clicks are idempotent (no spam).
  const requestId = `${SEED_REQUEST_PREFIX}:${ctx.briefId}`;
  const response = {
    reply: "",
    patches_applied: [],
    patch_errors: [],
    canvas_actions: [
      // Layer C action, Low confidence -> queued (not auto-applied) -> approvable.
      {
        kind: "primitive_surface.create",
        payload: {
          node_id: "seed-review-surface-1",
          title: "Seed: review-ready stakeholder note",
          confidence: "Low",
          rationale: "Deterministic lab seed proposal; review-ready, no provider call.",
          surface_spec: {
            root: {
              p: "text",
              text: "This primitive surface was created by the deterministic lab seed for review QA.",
            },
          },
          evidence: [
            { source: "lab-seed", text: "Deterministic fake evidence #1" },
            { source: "lab-seed", text: "Deterministic fake evidence #2" },
          ],
        },
      },
      // Capability proposal: routed through capability.propose. Inert source only.
      {
        kind: "capability.propose",
        payload: {
          id: `seed-cap-${ctx.briefId}`,
          proposed_widget_kind: "lab_seed_capability",
          rationale: "Deterministic lab seed capability proposal; renderer source is displayed as inert text only and is never executed.",
          data_schema: {
            type: "object",
            properties: { label: { type: "string" } },
            required: ["label"],
          },
          // NOTE: this is text only. It is never imported, evaluated, or rendered as code.
          ts_renderer_source: [
            "// Lab seed capability renderer source — displayed for review only.",
            "// This source is never executed by lab or production runtimes.",
            "export function LabSeedCapability(props: { label: string }) {",
            "  return null;",
            "}",
          ].join("\n"),
          example_data: { label: "Seed example" },
          primitive_fallback: {
            root: { p: "text", text: "Lab seed capability fallback (inert)." },
          },
          evidence: [{ source: "lab-seed", text: "Deterministic fake capability evidence" }],
          proposed_at: new Date(0).toISOString(),
          proposed_by: { kind: "hermes" },
        },
      },
    ],
  } as Parameters<typeof ingestCanvasResponse>[1];

  return ingestCanvasResponse({ ...ctx, requestId }, response);
}
