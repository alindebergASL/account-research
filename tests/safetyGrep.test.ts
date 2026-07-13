import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const repoRoot = path.join(__dirname, "..");
const safetyScript = path.join(repoRoot, ".github", "scripts", "safety-grep.sh");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("safety grep parses fetch calls and blocks them on public-share paths", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "safety-grep-"));
  try {
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    const route = path.join(repo, "web", "app", "s", "demo", "route.ts");
    mkdirSync(path.dirname(route), { recursive: true });
    writeFileSync(route, "export const x = 1;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "base");
    const base = git(repo, "rev-parse", "HEAD");

    writeFileSync(route, 'export async function x() { return fetch("https://example.invalid"); }\n');
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "head");

    const summary = path.join(repo, "summary.md");
    const result = spawnSync("bash", [safetyScript, base, "HEAD"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
    });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /invalid regexp|unmatched/i);
    assert.match(result.stderr, /1 blocking hit/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
