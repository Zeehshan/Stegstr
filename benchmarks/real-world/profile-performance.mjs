import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORK = join(ROOT, "benchmarks", "work", "performance");
const MANIFEST = join(ROOT, "benchmarks", "real-world", "manifest.json");
const REPEATS = 3;

function run(binary, args) {
  const started = performance.now();
  const result = spawnSync(binary, args, { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
  const duration = performance.now() - started;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout).trim());
  return duration;
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { average_ms: values.reduce((sum, value) => sum + value, 0) / values.length, median_ms: sorted[Math.floor(sorted.length / 2)], minimum_ms: sorted[0], maximum_ms: sorted.at(-1) };
}

async function main() {
  await rm(WORK, { recursive: true, force: true }); await mkdir(WORK, { recursive: true });
  const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
  const cases = manifest.tests.filter((entry) => entry.payload_size_bytes === 128 && ["normal-photo", "detailed-photo"].includes(entry.carrier_id));
  const profiles = [];
  for (const profile of ["debug", "release"]) {
    const cargoArgs = ["build", "--quiet", "--bin", "stegstr_benchmark_bridge"];
    if (profile === "release") cargoArgs.splice(1, 0, "--release");
    execFileSync("cargo", cargoArgs, { cwd: join(ROOT, "src-tauri"), stdio: "inherit" });
    const binary = join(ROOT, "src-tauri", "target", profile, process.platform === "win32" ? "stegstr_benchmark_bridge.exe" : "stegstr_benchmark_bridge");
    for (const test of cases) {
      const carrier = join(ROOT, "benchmarks", "real-world", test.carrier_file), payload = join(WORK, `${test.test_id}.bin`), encoded = join(WORK, `${profile}-${test.test_id}.jpg`), decoded = join(WORK, `${profile}-${test.test_id}-decoded.bin`);
      await writeFile(payload, Buffer.from(test.payload_base64, "base64"));
      const encode = [], decode = [];
      // Warm image codecs and filesystem caches; only the following repeats
      // are included in the report.
      run(binary, ["encode", "robust-v2", carrier, payload, encoded]);
      run(binary, ["decode", "robust-v2", encoded, decoded]);
      for (let repeat = 0; repeat < REPEATS; repeat++) {
        encode.push(run(binary, ["encode", "robust-v2", carrier, payload, encoded]));
        decode.push(run(binary, ["decode", "robust-v2", encoded, decoded]));
      }
      profiles.push({ rust_profile: profile, carrier: test.carrier_id, width: test.image_width, height: test.image_height, payload_size_bytes: test.payload_size_bytes, repeats: REPEATS, encode: summarize(encode), decode: summarize(decode), total_average_ms: summarize(encode).average_ms + summarize(decode).average_ms });
      console.log(`${profile} ${test.carrier_id}: encode ${summarize(encode).average_ms.toFixed(1)} ms, decode ${summarize(decode).average_ms.toFixed(1)} ms`);
    }
  }
  const output = { schema_version: 1, generated_at: new Date().toISOString(), measurement: "wall-clock production bridge process, three repeats", profiles };
  await writeFile(join(ROOT, "benchmarks", "results", "robust-v2-performance.json"), `${JSON.stringify(output, null, 2)}\n`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
