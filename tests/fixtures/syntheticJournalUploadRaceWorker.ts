import { writeFileSync, existsSync } from "node:fs";

type WorkerConfig = {
  role: "failing" | "successful";
  sessionId: string;
  briefId: string;
  bytes: string;
  startedPath: string;
  attemptPath: string;
  readyPath: string;
  releasePath: string;
  resultPath: string;
};

async function main(): Promise<void> {
  const config = JSON.parse(process.argv[2] ?? "") as WorkerConfig;
  const { db, initDb } = await import("../../web/lib/db");
  const storage = await import("../../web/lib/journalDocumentStorage");
  const route = await import("../../web/app/api/briefs/[id]/journal/documents/route");

  initDb();
  const transactionState = () => ({
    inTransaction: db().inTransaction,
    databasePath: (db().pragma("database_list") as Array<{ name: string; file: string }>).find((row) => row.name === "main")?.file,
  });
  if (config.role === "failing") {
    db().exec(`CREATE TEMP TRIGGER fail_competing_document_insert
      BEFORE INSERT ON journal_documents
      BEGIN SELECT RAISE(ABORT, 'forced competing document failure'); END;`);
    storage.__setTestUploadHooks({
      beforeDocumentInsert() {
        writeFileSync(config.readyPath, JSON.stringify(transactionState()), { flag: "wx" });
        const wait = new Int32Array(new SharedArrayBuffer(4));
        const deadline = Date.now() + 10_000;
        while (!existsSync(config.releasePath)) {
          if (Date.now() >= deadline) throw new Error("upload race worker barrier timed out");
          Atomics.wait(wait, 0, 0, 10);
        }
      },
    });
  } else {
    storage.__setTestUploadHooks({
      beforeUploadTransaction() {
        writeFileSync(config.startedPath, "ready-to-attempt-immediate", { flag: "wx" });
        const wait = new Int32Array(new SharedArrayBuffer(4));
        const deadline = Date.now() + 10_000;
        while (!existsSync(config.attemptPath)) {
          if (Date.now() >= deadline) throw new Error("upload race worker attempt barrier timed out");
          Atomics.wait(wait, 0, 0, 10);
        }
      },
      afterPersist() {
        writeFileSync(config.readyPath, JSON.stringify(transactionState()), { flag: "wx" });
        const wait = new Int32Array(new SharedArrayBuffer(4));
        const deadline = Date.now() + 10_000;
        while (!existsSync(config.releasePath)) {
          if (Date.now() >= deadline) throw new Error("upload race worker barrier timed out");
          Atomics.wait(wait, 0, 0, 10);
        }
      },
    });
  }

  const form = new FormData();
  form.set("file", new File([config.bytes], `${config.role}.md`, { type: "text/markdown" }));
  const request = {
    cookies: {
      get(name: string) {
        return name === "abb_session" ? { value: config.sessionId } : undefined;
      },
    },
    headers: {
      get(name: string) {
        return name.toLowerCase() === "content-length" ? "1024" : undefined;
      },
    },
    async formData() {
      return form;
    },
  };

  if (config.role === "failing") {
    writeFileSync(config.startedPath, "started", { flag: "wx" });
  }
  const response = await route.POST(request as never, { params: Promise.resolve({ id: config.briefId }) });
  writeFileSync(config.resultPath, JSON.stringify({
    status: response.status,
    body: await response.json(),
  }));
}

main().catch((error) => {
  const config = JSON.parse(process.argv[2] ?? "{}") as Partial<WorkerConfig>;
  if (config.resultPath) {
    writeFileSync(config.resultPath, JSON.stringify({ error: String(error?.stack ?? error) }));
  }
  process.exitCode = 1;
});
