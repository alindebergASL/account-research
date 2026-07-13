import Anthropic from "@anthropic-ai/sdk";
import { assertProviderCallsEnabled } from "./providerAccess";

export type BriefChatClient = Pick<Anthropic, "messages">;

let testChatClient: BriefChatClient | null = null;
let testBeforeProviderCall: (() => void) | null = null;

export function __setTestBriefChatClient(client: BriefChatClient | null): void {
  testChatClient = client;
}

export function __setTestBriefChatBeforeProviderCall(callback: (() => void) | null): void {
  testBeforeProviderCall = callback;
}

export function runBriefChatBeforeProviderCall(): void {
  testBeforeProviderCall?.();
}

export function hasTestBriefChatClient(): boolean {
  return testChatClient !== null;
}

export function briefChatClient(): BriefChatClient {
  assertProviderCallsEnabled();
  // Route-level authority is checked before each explicit invocation. Keep SDK
  // retries disabled so it cannot create an opaque second provider invocation
  // after authority changes.
  return testChatClient ?? new Anthropic({ timeout: 90_000, maxRetries: 0 });
}
