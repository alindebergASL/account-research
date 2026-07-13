import Anthropic from "@anthropic-ai/sdk";
import { assertProviderCallsEnabled } from "./providerAccess";

export type BriefChatClient = Pick<Anthropic, "messages">;

let testChatClient: BriefChatClient | null = null;

export function __setTestBriefChatClient(client: BriefChatClient | null): void {
  testChatClient = client;
}

export function hasTestBriefChatClient(): boolean {
  return testChatClient !== null;
}

export function briefChatClient(): BriefChatClient {
  assertProviderCallsEnabled();
  return testChatClient ?? new Anthropic({ timeout: 90_000, maxRetries: 1 });
}
