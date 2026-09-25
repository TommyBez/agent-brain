import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

async function main() {
  const { values } = parseArgs({
    options: {
      data: { type: "string" },
      template: { type: "string" },
      output: { type: "string" },
    },
    strict: true,
  });
  if (!values.data || !values.template)
    throw new Error(
      "Usage: --data visual-data.json --template jev-soglie.html [--output path]",
    );
  const data = JSON.parse(await readFile(resolve(values.data), "utf8"));
  for (const split of ["calibration", "validation"]) {
    if (!Array.isArray(data[split]) || !data[split].length)
      throw new Error(`Missing ${split} observations.`);
    for (const row of data[split])
      for (const arm of data.arms)
        for (const criterion of data.criteria) {
          const risks = row.risks?.[arm]?.[criterion];
          if (
            !Array.isArray(risks) ||
            risks.length !== 3 ||
            risks.some(
              (value: unknown) =>
                value !== null &&
                (typeof value !== "number" ||
                  !Number.isFinite(value) ||
                  value < 0 ||
                  value > 1),
            )
          )
            throw new Error("Malformed observed risk series.");
        }
  }
  const embedded = {
    ready: true,
    selection: data.selection,
    criterionNames: data.criterionNames,
    armNames: data.armNames,
    criteria: data.criteria,
    arms: data.arms,
    calibration: data.calibration,
    validation: data.validation,
  };
  const json = JSON.stringify(embedded).replace(/</g, "\\u003c");
  const source = await readFile(resolve(values.template), "utf8");
  const pattern =
    /(<script type="application\/json" id="jev-threshold-data">)[\s\S]*?(<\/script>)/;
  if (!pattern.test(source))
    throw new Error("Visualization data slot not found.");
  const html = source.replace(
    pattern,
    (_, start, end) => `${start}${json}${end}`,
  );
  if (Buffer.byteLength(html) >= 1_000_000)
    throw new Error("Visualization exceeds 1 MB.");
  const output = resolve(values.output ?? values.template);
  await writeFile(output, html, { mode: 0o600 });
  console.log(
    JSON.stringify({
      output,
      bytes: Buffer.byteLength(html),
      calibration: data.calibration.length,
      validation: data.validation.length,
    }),
  );
}
main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Visual preparation failed.",
  );
  process.exitCode = 1;
});
