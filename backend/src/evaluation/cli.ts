import { readFile } from "node:fs/promises";
import { evaluateDatasetQuality } from "./dataset-quality.js";

try {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0].startsWith("-")) {
    throw new Error("Usage: npm run eval:quality -- <snapshot.json>");
  }
  const input: unknown = JSON.parse(await readFile(args[0], "utf8"));
  const report = evaluateDatasetQuality(input);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.passed ? 0 : 1;
} catch (error) {
  // Do not echo malformed JSON, which may contain private snapshot values.
  const message = error instanceof SyntaxError ? "Input is not valid JSON."
    : error instanceof Error ? error.message : "Unable to evaluate input.";
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exitCode = 2;
}
