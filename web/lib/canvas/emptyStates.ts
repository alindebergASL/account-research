// Executive guidance copy for empty widget payloads.
//
// Pure TS, no React. Replaces ad-hoc "Not found" / "—" / "No X captured"
// strings across tiles and details with sales-leader-voiced guidance.
// The em-dash literal `—` used as a divider between metadata fields is a
// separator, not a placeholder — this helper does not address those.

export function emptyStateMessage(sectionKey: string): string {
  switch (sectionKey) {
    case "personas":
      return "Buying committee not yet identified — validate CMIO/CIO/procurement path.";
    case "buying_path":
      return "Buying path not yet mapped.";
    case "clinical_footprint":
      return "Clinical footprint not yet validated.";
    case "governance":
      return "Governance posture not yet validated.";
    case "technical_footprint":
      return "Technical footprint not yet validated.";
    case "programs_procurement":
      return "Programs and procurement not yet captured.";
    case "competitive_signals":
      return "No competitive vendor signal in saved evidence.";
    case "risks":
      return "No material risk found from current brief.";
    case "evidence_board":
    case "recent_signals":
      return "Source coverage missing — add cited evidence before action.";
    case "top_initiatives":
      return "No priority initiatives surfaced — confirm the account's stated bets.";
    case "opportunities":
      return "No opportunity surfaced — validate live pursuits before outreach.";
    case "signal_radar":
      return "No public signal in this quadrant — verify in discovery.";
    case "open_questions":
      return "No open questions yet — capture the next validation step.";
    case "extension":
      return "No content captured — add a citation or note.";
    default:
      return "Not yet captured — validate before action.";
  }
}
