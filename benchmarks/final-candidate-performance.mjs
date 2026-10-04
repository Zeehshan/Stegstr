import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORK = join(ROOT, "benchmarks", "work", "final-performance");
const BINARY = join(ROOT, "src-tauri", "target", "release", process.platform === "win32" ? "stegstr_benchmark_bridge.exe" : "stegstr_benchmark_bridge");
const REPEATS = 5;

const cases = [
  { id: "normal-photo", width: 1280, height: 720, input: join(ROOT, "benchmarks", "real-world", "carriers", "normal-photo.jpg") },
  { id: "detailed-photo", width: 1920, height: 1080, input: join(ROOT, "benchmarks", "real-world", "carriers", "detailed-photo.jpg") },
  { id: "gradient", width: 2048, height: 2048, input: join(WORK, "gradient-2048.png"), generated: true },
];

function run(args) {
  const started = performance.now();
  const result = spawnSync(BINARY, args, { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
  const duration = performance.now() - started;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || "benchmark bridge failed").trim());
  return duration;
}

function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    average_ms: values.reduce((sum, value) => sum + value, 0) / values.length,
    median_ms: sorted[Math.floor(sorted.length / 2)],
    minimum_ms: sorted[0],
    maximum_ms: sorted.at(-1),
  };
}

async function generateGradient(path, width, height) {
  const pixels = Buffer.allocUnsafe(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      pixels[offset] = Math.round(x * 255 / (width - 1));
      pixels[offset + 1] = Math.round(y * 255 / (height - 1));
      pixels[offset + 2] = Math.round((x + y) * 255 / (width + height - 2));
    }
  }
  await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toFile(path);
}

async function main() {
  await rm(WORK, { recursive: true, force: true });
  await mkdir(WORK, { recursive: true });
  execFileSync("cargo", ["build", "--release", "--bin", "stegstr_benchmark_bridge"], { cwd: join(ROOT, "src-tauri"), stdio: "inherit" });
  const payload = Buffer.alloc(128);
  for (let index = 0; index < payload.length; index++) payload[index] = (index * 37 + 11) & 0xff;
  const payloadPath = join(WORK, "payload-128.bin");
  await writeFile(payloadPath, payload);

  const measurements = [];
  for (const testCase of cases) {
    if (testCase.generated) await generateGradient(testCase.input, testCase.width, testCase.height);
    const encoded = join(WORK, `${testCase.id}.jpg`);
    const decoded = join(WORK, `${testCase.id}.bin`);
    run(["encode", "robust-v2", testCase.input, payloadPath, encoded]);
    run(["decode", "robust-v2", encoded, decoded]);
    const encodeTimes = [];
    const decodeTimes = [];
    for (let repeat = 0; repeat < REPEATS; repeat++) {
      encodeTimes.push(run(["encode", "robust-v2", testCase.input, payloadPath, encoded]));
      decodeTimes.push(run(["decode", "robust-v2", encoded, decoded]));
      if (!payload.equals(await readFile(decoded))) throw new Error(`${testCase.id} payload mismatch`);
    }
    const encode = summary(encodeTimes);
    const decode = summary(decodeTimes);
    measurements.push({ carrier: testCase.id, width: testCase.width, height: testCase.height, payload_size_bytes: payload.length, repeats: REPEATS, encode, decode, total_average_ms: encode.average_ms + decode.average_ms });
    console.log(`${testCase.width}x${testCase.height}: encode ${encode.average_ms.toFixed(1)} ms, decode ${decode.average_ms.toFixed(1)} ms`);
  }

  const report = { schema_version: 1, generated_at: new Date().toISOString(), measurement: "release bridge wall-clock after warm-up; process startup included", measurements };
  const resultDir = join(ROOT, "benchmarks", "results");
  await writeFile(join(resultDir, "final-contest-performance.json"), `${JSON.stringify(report, null, 2)}\n`);
  const header = "carrier,width,height,payload_size_bytes,repeats,encode_average_ms,decode_average_ms,total_average_ms";
  const rows = measurements.map((entry) => [entry.carrier, entry.width, entry.height, entry.payload_size_bytes, entry.repeats, entry.encode.average_ms, entry.decode.average_ms, entry.total_average_ms].join(","));
  await writeFile(join(resultDir, "final-contest-performance.csv"), `${header}\n${rows.join("\n")}\n`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
