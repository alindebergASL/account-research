import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { db, type BriefRow, type ShareLinkRow } from "@/lib/db";
import { Brief } from "@/lib/schema";
import { sanitizeBriefForPublic, isShareLinkLive } from "@/lib/publicBrief";

export const runtime = "nodejs";
export const maxDuration = 120;

const PROJECT_ROOT =
  process.env.BRIEF_PROJECT_ROOT || path.resolve(process.cwd(), "..");
const RENDERER = path.join(PROJECT_ROOT, "scripts", "generate_brief.py");
const PY = process.env.PYTHON_BIN || "python3";

type ExportFormat = "pdf" | "docx";

function slugify(name: string): string {
  return (name
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase() || "account-brief");
}

function runRenderer(briefPath: string, outDir: string, format: ExportFormat) {
  return new Promise<string[]>((resolve, reject) => {
    const proc = spawn(
      PY,
      [RENDERER, briefPath, "--out-dir", outDir, "--formats", format],
      { cwd: PROJECT_ROOT },
    );
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`renderer exited ${code}: ${stderr || stdout}`));
        return;
      }
      const paths = stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.endsWith(`.${format}`));
      if (paths.length === 0) {
        reject(new Error(`renderer produced no .${format} output`));
        return;
      }
      resolve(paths);
    });
  });
}

// Public, no auth. Same token validation as the JSON endpoint;
// renders a sanitized brief through the existing python pipeline.
export async function GET(req: NextRequest, props: { params: Promise<{ token: string }> }) {
  const params = await props.params;
  const url = new URL(req.url);
  const format =
    url.searchParams.get("format") === "docx"
      ? "docx"
      : ("pdf" as ExportFormat);

  const link = db()
    .prepare(`SELECT * FROM brief_share_links WHERE token = ?`)
    .get(params.token) as ShareLinkRow | undefined;
  if (!link || !isShareLinkLive(link)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const briefRow = db()
    .prepare(`SELECT * FROM briefs WHERE id = ?`)
    .get(link.brief_id) as BriefRow | undefined;
  if (!briefRow) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const parsed = Brief.safeParse(JSON.parse(briefRow.brief_json));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Stored brief failed validation" },
      { status: 500 },
    );
  }
  const brief = sanitizeBriefForPublic(parsed.data);

  // Bump counters before doing the slow render so concurrent revokes
  // are reflected immediately on the next read.
  try {
    db()
      .prepare(
        `UPDATE brief_share_links
         SET access_count = access_count + 1,
             last_accessed_at = ?
         WHERE id = ?`,
      )
      .run(Date.now(), link.id);
  } catch {
    // ignore
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "brief-public-"));
  try {
    const briefPath = path.join(tmpDir, "brief.json");
    await fs.writeFile(briefPath, JSON.stringify(brief), "utf8");
    const outFiles = await runRenderer(briefPath, tmpDir, format);
    const buf = await fs.readFile(outFiles[0]);

    const slug = slugify(brief.account_name);
    const filename = `${slug}-${brief.generated_at || "brief"}.${format}`;
    const mime =
      format === "pdf"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

    return new NextResponse(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type": mime,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? String(err) },
      { status: 500 },
    );
  } finally {
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
