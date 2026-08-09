import { spawnSync } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FIELDS = ["platform", "platform_mode", "test_id", "carrier", "payload_size", "source_width", "source_height", "received_width", "received_height", "source_file_size", "received_file_size", "source_format", "received_format", "decode_success", "exact_match", "pilot_confidence", "decode_time", "error"];

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { image: null, manifest: join(ROOT, "benchmarks/real-world/manifest.json"), cli: join(ROOT, "src-tauri/target/release", process.platform === "win32" ? "stegstr-cli.exe" : "stegstr-cli") };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--platform") result.platform = args[++i];
    else if (arg === "--mode") result.platformMode = args[++i];
    else if (arg === "--test-id") result.testId = args[++i];
    else if (arg === "--manifest") result.manifest = resolve(args[++i]);
    else if (arg === "--cli") result.cli = resolve(args[++i]);
    else if (!arg.startsWith("-") && !result.image) result.image = resolve(arg);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!result.image || !result.platform || !result.platformMode || !result.testId) throw new Error("usage: node verify-and-record.mjs <received-image> --platform <name> --mode <mode> --test-id <id>");
  return result;
}

function csv(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function main() {
  const options = parseArgs();
  const manifest = JSON.parse(await readFile(options.manifest, "utf8"));
  const test = manifest.tests.find((entry) => entry.test_id === options.testId);
  if (!test) throw new Error(`test ID is absent from manifest: ${options.testId}`);
  const verificationProcess = spawnSync(options.cli, ["verify-channel", options.image, "--manifest", options.manifest, "--json"], { encoding: "utf8" });
  if (verificationProcess.status === null || !verificationProcess.stdout.trim()) throw new Error(verificationProcess.stderr.trim() || "verifier produced no result");
  const verification = JSON.parse(verificationProcess.stdout);
  const receivedMetadata = await sharp(options.image).metadata();
  const receivedStats = await stat(options.image);
  const exact = verification.status === "PASS" && verification.recovered_test_id === test.test_id;
  const row = {
    platform: options.platform,
    platform_mode: options.platformMode,
    test_id: test.test_id,
    carrier: test.carrier_id,
    payload_size: test.payload_size_bytes,
    source_width: test.image_width,
    source_height: test.image_height,
    received_width: receivedMetadata.width ?? null,
    received_height: receivedMetadata.height ?? null,
    source_file_size: test.encoded_file_size_bytes,
    received_file_size: receivedStats.size,
    source_format: test.encoded_format,
    received_format: receivedMetadata.format ?? null,
    decode_success: verification.detected_format === "robust-v2",
    exact_match: exact,
    pilot_confidence: verification.pilot_confidence,
    decode_time: verification.decode_duration_ms,
    error: exact ? null : verification.error ?? verification.status,
  };
  const jsonPath = join(ROOT, "benchmarks/results/real-world-platform-results.json");
  const csvPath = join(ROOT, "benchmarks/results/real-world-platform-results.csv");
  const report = JSON.parse(await readFile(jsonPath, "utf8"));
  const duplicate = report.observations.findIndex((entry) => entry.platform === row.platform && entry.platform_mode === row.platform_mode && entry.test_id === row.test_id);
  if (duplicate >= 0) report.observations[duplicate] = row;
  else report.observations.push(row);
  report.updated_at = new Date().toISOString();
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(csvPath, `${FIELDS.join(",")}\n${report.observations.map((entry) => FIELDS.map((field) => csv(entry[field])).join(",")).join("\n")}${report.observations.length ? "\n" : ""}`);
  console.log(`${verification.status}: recorded ${row.platform}/${row.platform_mode}/${row.test_id}`);
}

main().catch((error) => { console.error(error.message ?? error); process.exitCode = 1; });
