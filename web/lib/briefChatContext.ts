import { BRIEF_CHAT_SYSTEM_PROMPT } from "@/lib/prompt";
import type { Brief as BriefT } from "@/lib/schema";
import {
  formatDocumentContextForPrompt,
  type JournalDocumentRow,
} from "@/lib/journalDocuments";

export function buildBriefChatDocumentContext(args: {
  documents: JournalDocumentRow[];
  canWrite: boolean;
}): string {
  const writeInstruction = args.canWrite
    ? "When the user's current message asks to apply document-derived findings, and an uploaded document is relevant to the account brief, use update_brief to apply concise, cited changes to the brief. Always append a source entry that names the uploaded document."
    : "Use uploaded documents only to answer questions. Do not update the brief for read-only users.";

  return `UPLOADED JOURNAL DOCUMENTS
${formatDocumentContextForPrompt(args.documents)}
- ${writeInstruction}`;
}

export function buildBriefChatSystemPrompt(args: {
  brief: BriefT | unknown;
  documents?: JournalDocumentRow[];
  canWrite: boolean;
}): string {
  const base = BRIEF_CHAT_SYSTEM_PROMPT.replace(
    "{{BRIEF_JSON}}",
    JSON.stringify(args.brief, null, 2),
  );
  const documents = args.documents ?? [];
  if (documents.length === 0) return base;

  return `${base}

---
${buildBriefChatDocumentContext({ documents, canWrite: args.canWrite })}`;
}
