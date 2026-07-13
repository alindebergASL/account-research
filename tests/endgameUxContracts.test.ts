import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("chat and monitor describe AI Brief changes as review candidates, never applied updates", () => {
  const chat = read("web/components/BriefChat.tsx");
  assert.match(chat, /candidates_queued/);
  assert.match(chat, /queued for human review and manual incorporation/i);
  assert.doesNotMatch(chat, /patches_applied/);
  assert.doesNotMatch(chat, /add it to the canvas/i);
  assert.doesNotMatch(chat, /Updated \{label\}/);

  const monitor = read("web/components/MonitoringPanel.tsx");
  assert.match(monitor, /Review candidate queued/);
  assert.match(monitor, /Legacy monitor result/);
  assert.doesNotMatch(monitor, /Brief updated/);
  assert.doesNotMatch(monitor, /\{run\.patches_applied\} change/);
});

test("affected async panels use fixed permission, overload, and unavailable copy", () => {
  const chat = read("web/components/BriefChat.tsx");
  for (const copy of [
    "Chat is unavailable for your permission level.",
    "Chat is busy right now. Try again shortly.",
    "Chat is temporarily unavailable. Try again later.",
  ]) {
    assert.ok(chat.includes(copy), `missing fixed chat state: ${copy}`);
  }
  assert.match(chat, /\{!readOnly && \([\s\S]{0,500}onClick=\{clearHistory\}/);
  assert.match(chat, /if \(!r\.ok\) \{[\s\S]{0,200}chatErrorMessage\(r\.status\)/);

  const monitor = read("web/components/MonitoringPanel.tsx");
  assert.match(monitor, /Writer access is required to change monitoring or start a check\./);
  for (const copy of [
    "You don’t have permission to change monitoring.",
    "Monitoring is busy right now. Try again shortly.",
    "Monitoring is temporarily unavailable. Try again later.",
  ]) {
    assert.ok(monitor.includes(copy), `missing fixed monitor state: ${copy}`);
  }

  const share = read("web/components/ShareDialog.tsx");
  assert.match(share, /Public-link email is temporarily unavailable\. Copy the link and share it another way\./);
  for (const copy of [
    "You don’t have permission to change sharing.",
    "Sharing is busy right now. Try again shortly.",
    "Sharing is temporarily unavailable. Try again later.",
  ]) {
    assert.ok(share.includes(copy), `missing fixed sharing state: ${copy}`);
  }
  assert.match(share, /\{publicError && \(/);
  assert.match(
    share,
    /async function sendPublicLinkEmail[\s\S]*catch \{[\s\S]*Public-link email is temporarily unavailable/,
  );
  assert.doesNotMatch(share, /SMTP|email_not_configured|email_send_failed/i);
});

test("refresh, export, and public-link copy remain honest and non-diagnostic", () => {
  const canvas = read("web/components/BriefCanvas.tsx");
  assert.match(canvas, />Check for updates</);
  assert.match(canvas, />Research checked \{relativeTimeShort\(lastRefreshedAt\)\}</);
  assert.match(canvas, /Brief export is currently unavailable\./);
  assert.doesNotMatch(canvas, />Refreshed \{relativeTimeShort\(lastRefreshedAt\)\}</);

  const publicPage = read("web/app/s/[token]/page.tsx");
  assert.match(publicPage, /This shared brief is unavailable\. Ask whoever sent it for a new link\./);
  assert.doesNotMatch(publicPage, /expired or been revoked/i);
  assert.doesNotMatch(publicPage, /PublicCommentsSection|\/comments/);
});

test("affected drawers and dialogs stay viewport-safe at 390px", () => {
  const chat = read("web/components/BriefChat.tsx");
  assert.match(chat, /w-full md:w-\[420px\]/);

  const monitor = read("web/components/MonitoringPanel.tsx");
  assert.match(monitor, /w-full max-w-md/);
  assert.match(monitor, /flex-wrap/);

  const share = read("web/components/ShareDialog.tsx");
  assert.match(share, /fixed inset-0[^"]*px-4/);
  assert.match(share, /w-full max-w-md/);

  const tray = read("web/components/ResearchTray.tsx");
  assert.match(tray, /w-\[calc\(100vw-24px\)\] max-w-\[360px\]/);
});
