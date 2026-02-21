import { defineConfig } from "vitest/config";
import type { Reporter } from "vitest/reporters";
import type { Vitest, TaskResultPack, File } from "vitest/node";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

class TddGuardReporter implements Reporter {
  ctx!: Vitest;
  dataDir: string;

  constructor() {
    this.dataDir = join(process.cwd(), ".claude", "tdd-guard", "data");
  }

  onInit(ctx: Vitest) {
    this.ctx = ctx;
  }

  onFinished(files?: File[]) {
    if (!files) return;

    const testModules = files.map((file) => ({
      moduleId: file.filepath,
      tests: this.collectTests(file),
    }));

    const hasFailures = testModules.some((m) =>
      m.tests.some((t) => t.state === "failed")
    );

    const result = {
      testModules,
      reason: hasFailures ? "failed" : "passed",
    };

    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(join(this.dataDir, "test.json"), JSON.stringify(result, null, 2));
  }

  private collectTests(suite: any): any[] {
    const tests: any[] = [];
    if (suite.tasks) {
      for (const task of suite.tasks) {
        if (task.type === "test" || task.type === "custom") {
          tests.push({
            name: task.name,
            fullName: task.name,
            state: task.result?.state === "pass" ? "passed" : task.result?.state === "fail" ? "failed" : "skipped",
            errors: task.result?.errors?.map((e: any) => ({
              message: e.message ?? String(e),
              stack: e.stack,
            })),
          });
        } else if (task.type === "suite") {
          const nested = this.collectTests(task);
          for (const t of nested) {
            tests.push({
              ...t,
              fullName: `${task.name} > ${t.fullName}`,
            });
          }
        }
      }
    }
    return tests;
  }
}

export default defineConfig({
  test: {
    reporters: ["default", new TddGuardReporter()],
  },
});
