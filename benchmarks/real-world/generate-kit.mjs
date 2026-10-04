import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const KIT = join(ROOT, "benchmarks", "real-world");
const CARRIERS_DIR = join(KIT, "carriers");
const ENCODED_DIR = join(KIT, "encoded");
const BRIDGE = join(ROOT, "src-tauri", "target", "debug", process.platform === "win32" ? "stegstr_benchmark_bridge.exe" : "stegstr_benchmark_bridge");
const PAYLOAD_SIZES = [32, 128];

const carriers = [
  { id: "normal-photo", name: "Normal photograph", width: 1280, height: 720, source: "photo_normal.jpg", format: "jpeg" },
  { id: "detailed-photo", name: "Detailed photograph", width: 1920, height: 1080, source: "photo_high_detail.jpg", format: "jpeg" },
  { id: "low-detail-photo", name: "Low-detail photograph", width: 1280, height: 720, source: "photo_normal.jpg", effect: "low-detail", format: "jpeg" },
  { id: "dark-photo", name: "Dark photograph", width: 1280, height: 720, source: "photo_normal.jpg", effect: "dark", format: "jpeg" },
  { id: "bright-photo", name: "Bright photograph", width: 1280, height: 720, source: "photo_normal.jpg", effect: "bright", format: "jpeg" },
  { id: "screenshot", name: "Screenshot", width: 1280, height: 720, generated: true, format: "png" },
];

function deterministicPayload(testId, size) {
  const output = Buffer.alloc(size);
  const seed = createHash("sha256").update(`stegstr-real-world-v1:${testId}`).digest();
  let state = seed.readUInt32LE(0);
  for (let i = 0; i < size; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    output[i] = (state ^ seed[i % seed.length]) & 0xff;
  }
  return output;
}

function screenshotSvg(width, height) {
  const rows = Array.from({ length: 8 }, (_, index) => {
    const y = 190 + index * 52;
    const w = 430 + (index % 3) * 95;
    return `<rect x="290" y="${y}" width="${w}" height="11" rx="5" fill="#aab4c4"/>`;
  }).join("");
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#e5eaf1"/>
    <rect x="180" y="70" width="920" height="580" rx="18" fill="#fbfcfe"/>
    <path d="M198 70h884a18 18 0 0 1 18 18v82H180V88a18 18 0 0 1 18-18z" fill="#2b3648"/>
    <circle cx="230" cy="120" r="13" fill="#ff6b6b"/><circle cx="270" cy="120" r="13" fill="#ffd43b"/><circle cx="310" cy="120" r="13" fill="#69db7c"/>
    ${rows}<rect x="790" y="548" width="190" height="56" rx="12" fill="#2c76f6"/>
    <text x="838" y="584" font-family="Arial,sans-serif" font-size="22" fill="white">Continue</text>
  </svg>`);
}

async function createCarrier(carrier) {
  const extension = carrier.format === "jpeg" ? "jpg" : "png";
  const output = join(CARRIERS_DIR, `${carrier.id}.${extension}`);
  let pipeline;
  if (carrier.generated) {
    pipeline = sharp(screenshotSvg(carrier.width, carrier.height));
  } else {
    pipeline = sharp(join(ROOT, "benchmarks", "corpus", carrier.source)).rotate().resize(carrier.width, carrier.height, { fit: "cover", position: "centre" });
    if (carrier.effect === "low-detail") pipeline = pipeline.blur(12).modulate({ saturation: 0.55 });
    if (carrier.effect === "dark") pipeline = pipeline.modulate({ brightness: 0.34, saturation: 0.75 });
    if (carrier.effect === "bright") pipeline = pipeline.modulate({ brightness: 1.65, saturation: 0.65 });
  }
  if (carrier.format === "jpeg") await pipeline.jpeg({ quality: 94, chromaSubsampling: "4:4:4" }).toFile(output);
  else await pipeline.png().toFile(output);
  return output;
}

function bridge(args) {
  return execFileSync(BRIDGE, args, { cwd: ROOT, encoding: "utf8" }).trim();
}

async function main() {
  await mkdir(CARRIERS_DIR, { recursive: true });
  await mkdir(ENCODED_DIR, { recursive: true });
  execFileSync("cargo", ["build", "--quiet", "--bin", "stegstr_benchmark_bridge"], { cwd: join(ROOT, "src-tauri"), stdio: "inherit" });
  const tests = [];
  for (const carrier of carriers) {
    const carrierPath = await createCarrier(carrier);
    const metadata = await sharp(carrierPath).metadata();
    const carrierStats = await stat(carrierPath);
    const suitability = JSON.parse(bridge(["suitability", carrierPath]));
    for (const payloadSize of PAYLOAD_SIZES) {
      const testId = `rw-${carrier.id}-${payloadSize}b`;
      const payload = deterministicPayload(testId, payloadSize);
      const payloadPath = join(KIT, ".payload.bin");
      const encodedFileName = `${testId}.jpg`;
      const encodedPath = join(ENCODED_DIR, encodedFileName);
      await writeFile(payloadPath, payload);
      bridge(["encode", "robust-v2", carrierPath, payloadPath, encodedPath]);
      const encodedMetadata = await sharp(encodedPath).metadata();
      const encodedStats = await stat(encodedPath);
      tests.push({
        test_id: testId,
        carrier: carrier.name,
        carrier_id: carrier.id,
        payload_size_bytes: payloadSize,
        payload_base64: payload.toString("base64"),
        payload_sha256: createHash("sha256").update(payload).digest("hex"),
        image_width: encodedMetadata.width,
        image_height: encodedMetadata.height,
        robustness_profile: "robust",
        carrier_suitability: suitability,
        carrier_file: `carriers/${carrierPath.split("/").at(-1)}`,
        carrier_format: metadata.format,
        carrier_file_size_bytes: carrierStats.size,
        encoded_file: `encoded/${encodedFileName}`,
        encoded_format: encodedMetadata.format,
        encoded_file_size_bytes: encodedStats.size,
      });
    }
  }
  try { await import("node:fs/promises").then(({ unlink }) => unlink(join(KIT, ".payload.bin"))); } catch {}
  const manifest = {
    schema_version: 1,
    generated_by: "benchmarks/real-world/generate-kit.mjs",
    deterministic_payload_scheme: "SHA-256-seeded xorshift32, namespace stegstr-real-world-v1",
    algorithm: "robust-v2",
    tests,
  };
  await writeFile(join(KIT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Generated ${tests.length} deterministic channel tests in ${KIT}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
