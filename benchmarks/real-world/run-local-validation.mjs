import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const KIT = join(ROOT, "benchmarks", "real-world");
const WORK = join(ROOT, "benchmarks", "work", "real-world-validation");
const RESULTS = join(ROOT, "benchmarks", "results");
const BRIDGE = join(ROOT, "src-tauri", "target", "release", process.platform === "win32" ? "stegstr_benchmark_bridge.exe" : "stegstr_benchmark_bridge");
const reportStemIndex = process.argv.indexOf("--report-stem");
const REPORT_STEM = reportStemIndex >= 0 ? process.argv[reportStemIndex + 1] : "robust-v2-social-validation";
const TRANSFORMS = [
  { id: "identity" },
  ...[95, 90, 85, 80, 75, 70, 60, 50].map((quality) => ({ id: `jpeg-${quality}`, quality })),
  ...[90, 75, 50].map((percent) => ({ id: `resize-${percent}`, percent })),
  { id: "resize-75-jpeg-80", percent: 75, quality: 80 },
  { id: "resize-50-jpeg-75", percent: 50, quality: 75 },
];

async function transform(input, specification) {
  if (specification.id === "identity") return Buffer.from(input);
  let pipeline = sharp(input).rotate();
  if (specification.percent) {
    const metadata = await sharp(input).metadata();
    pipeline = pipeline.resize(Math.max(1, Math.round(metadata.width * specification.percent / 100)), Math.max(1, Math.round(metadata.height * specification.percent / 100)), { kernel: sharp.kernel.lanczos3 });
  }
  if (specification.quality) return pipeline.jpeg({ quality: specification.quality }).toBuffer();
  const metadata = await sharp(input).metadata();
  return metadata.format === "jpeg" ? pipeline.jpeg({ quality: 92 }).toBuffer() : pipeline.png().toBuffer();
}

async function metrics(referencePath, encoded) {
  const reference = await sharp(referencePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const candidate = await sharp(encoded).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let squared = 0, absolute = 0, maximum = 0, sumX = 0, sumY = 0, sumXX = 0, sumYY = 0, sumXY = 0;
  const pixels = reference.info.width * reference.info.height;
  for (let p = 0; p < pixels; p++) {
    const i = p * 3;
    for (let c = 0; c < 3; c++) {
      const difference = Math.abs(reference.data[i + c] - candidate.data[i + c]);
      squared += difference * difference; absolute += difference; maximum = Math.max(maximum, difference);
    }
    const x = .299 * reference.data[i] + .587 * reference.data[i + 1] + .114 * reference.data[i + 2];
    const y = .299 * candidate.data[i] + .587 * candidate.data[i + 1] + .114 * candidate.data[i + 2];
    sumX += x; sumY += y; sumXX += x * x; sumYY += y * y; sumXY += x * y;
  }
  const mse = squared / (pixels * 3), meanX = sumX / pixels, meanY = sumY / pixels, denominator = Math.max(1, pixels - 1);
  const varianceX = (sumXX - pixels * meanX * meanX) / denominator, varianceY = (sumYY - pixels * meanY * meanY) / denominator;
  const covariance = (sumXY - pixels * meanX * meanY) / denominator, c1 = (2.55 ** 2), c2 = (7.65 ** 2);
  return { psnr_db: 10 * Math.log10(65025 / mse), ssim: ((2 * meanX * meanY + c1) * (2 * covariance + c2)) / ((meanX * meanX + meanY * meanY + c1) * (varianceX + varianceY + c2)), average_pixel_difference: absolute / (pixels * 3), maximum_pixel_difference: maximum };
}

function csv(value) { if (value === null || value === undefined) return ""; const text = String(value); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }

async function main() {
  execFileSync("cargo", ["build", "--release", "--quiet", "--bin", "stegstr_benchmark_bridge"], { cwd: join(ROOT, "src-tauri"), stdio: "inherit" });
  await rm(WORK, { recursive: true, force: true }); await mkdir(WORK, { recursive: true }); await mkdir(RESULTS, { recursive: true });
  const manifest = JSON.parse(await readFile(join(KIT, "manifest.json"), "utf8"));
  const observations = [];
  for (const test of manifest.tests) {
    const payload = Buffer.from(test.payload_base64, "base64");
    const encoded = await readFile(join(KIT, test.encoded_file));
    for (const specification of TRANSFORMS) {
      const processed = await transform(encoded, specification);
      const inputPath = join(WORK, `${test.test_id}-${specification.id}.jpg`), outputPath = join(WORK, "decoded.bin");
      await writeFile(inputPath, processed);
      const started = performance.now();
      const result = spawnSync(BRIDGE, ["decode", "robust-v2", inputPath, outputPath], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
      const decodeMs = performance.now() - started;
      let exact = false;
      if (result.status === 0) exact = createHash("sha256").update(await readFile(outputPath)).digest("hex") === test.payload_sha256;
      const metadata = await sharp(processed).metadata();
      const visual = specification.id === "identity" ? await metrics(join(KIT, test.carrier_file), processed) : {};
      observations.push({ test_id: test.test_id, carrier: test.carrier_id, payload_size_bytes: test.payload_size_bytes, transformation: specification.id, processed_width: metadata.width, processed_height: metadata.height, decode_success: result.status === 0, exact_match: exact, decode_time_ms: decodeMs, carrier_suitability_score: test.carrier_suitability.score, carrier_suitability_rating: test.carrier_suitability.rating, ...visual, error: exact ? null : (result.stderr || "payload mismatch").trim() });
    }
    process.stdout.write(`\r${test.test_id}: ${observations.length} observations`);
  }
  process.stdout.write("\n");
  const report = { schema_version: 1, generated_at: new Date().toISOString(), git_commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(), rust_profile: "release", transformations: TRANSFORMS, observations };
  const jsonPath = join(RESULTS, `${REPORT_STEM}.json`), csvPath = join(RESULTS, `${REPORT_STEM}.csv`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  const headers = Object.keys(observations[0]); await writeFile(csvPath, `${headers.join(",")}\n${observations.map((row) => headers.map((header) => csv(row[header])).join(",")).join("\n")}\n`);
  console.log(`Wrote ${jsonPath}\nWrote ${csvPath}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
