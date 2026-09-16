import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

// Generate against a disposable copy of Drizzle's snapshots. If the schema is
// ahead of the committed snapshots, drizzle-kit emits a new SQL file there and
// CI fails without dirtying the checkout.
// drizzle-kit 0.31 mis-resolves absolute --out paths by prefixing `./`, so pass
// the system temporary directory as a path relative to the checkout.
const temporaryOut = mkdtempSync(join(tmpdir(), "agent-brain-drizzle-check-"));
const temporaryOutArgument = relative(process.cwd(), temporaryOut);

try {
  cpSync(resolve("drizzle/meta"), join(temporaryOut, "meta"), {
    recursive: true,
  });

  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "drizzle-kit",
      "generate",
      "--dialect",
      "postgresql",
      "--schema",
      "./lib/db/schema.ts",
      "--out",
      temporaryOutArgument,
      "--name",
      "schema-drift-check",
    ],
    { encoding: "utf8" },
  );

  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  } else {
    const generatedSql = readdirSync(temporaryOut).filter((file) =>
      file.endsWith(".sql"),
    );

    if (generatedSql.length > 0) {
      console.error(
        "lib/db/schema.ts is ahead of the committed Drizzle migrations. Run `pnpm db:generate --name <description>` and commit the result.",
      );
      process.exitCode = 1;
    } else if (
      result.stderr?.trim() ||
      !result.stdout?.includes("No schema changes, nothing to migrate")
    ) {
      // Drizzle Kit 0.31 can report generation errors with exit code 0.
      console.error(
        "Drizzle did not confirm that the schema is unchanged. Resolve the generation error or run `pnpm db:generate` interactively, then retry.",
      );
      process.exitCode = 1;
    } else {
      console.log("Drizzle schema and migration snapshots are aligned.");
    }
  }
} finally {
  rmSync(temporaryOut, { recursive: true, force: true });
}
