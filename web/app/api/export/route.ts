import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { Brief } from "@/lib/schema";

export const runtime = "nodejs";
export const maxDuration = 120;

const PROJECT_ROOT =
  process.env.BRIEF_PROJECT_ROOT || path.resolve(process.cwd(), "..");
const RENDERER = path.join(PROJECT_ROOT, "scripts", "generate_brief.py");
const PY = process.env.PYTHON_BIN || "python3";

type ExportFormat = "pdf" | "docx";

function slugify(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .toLowerCase() || "account-brief"
  );
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

export async function POST(req: NextRequest) {
  let body: { brief?: unknown; format?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const format =
    body.format === "docx" ? "docx" : ("pdf" as ExportFormat);
  const parsed = Brief.safeParse(body.brief);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Brief failed schema validation", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const brief = parsed.data;

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "brief-export-"));
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
