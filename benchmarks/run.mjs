import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import sharp from "sharp";
import { createServer } from "vite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORK = join(ROOT, "benchmarks", "work");
const REPORT_DIR = join(ROOT, "benchmarks", "results");
const BRIDGE = join(
  ROOT,
  "src-tauri",
  "target",
  "debug",
  process.platform === "win32" ? "stegstr_benchmark_bridge.exe" : "stegstr_benchmark_bridge",
);

const PAYLOAD_SIZES = [32, 128, 512, 1024, 5 * 1024, 10 * 1024];
const ALL_ALGORITHMS = ["rust-dwt", "rust-dot", "typescript-dot", "typescript-qim", "robust-v2"];
const DEFAULT_ALGORITHMS = ALL_ALGORITHMS.filter((algorithm) => algorithm !== "robust-v2");
const QIM_PIXEL_SAFETY_LIMIT = 2048 * 2048;

const CARRIERS = [
  { id: "normal-photograph", type: "normal photograph", width: 1280, height: 720, source: "photo_normal.jpg", format: "jpeg" },
  { id: "high-detail-photograph", type: "high-detail photograph", width: 1920, height: 1080, source: "photo_high_detail.jpg", format: "jpeg" },
  { id: "low-detail-image", type: "low-detail image", width: 640, height: 480, generated: "low-detail", format: "png" },
  { id: "screenshot", type: "screenshot", width: 1280, height: 720, generated: "screenshot", format: "png" },
  { id: "gradient", type: "gradient", width: 2048, height: 2048, generated: "gradient", format: "png" },
  { id: "dark-image", type: "dark image", width: 640, height: 480, generated: "dark", format: "png" },
  { id: "bright-image", type: "bright image", width: 4000, height: 3000, generated: "bright", format: "jpeg" },
];

const TRANSFORMS = [
  { id: "identity", family: "identity" },
  ...[95, 90, 85, 80, 75, 70, 60, 50].map((quality) => ({ id: `jpeg-quality-${quality}`, family: "jpeg-recompression", quality })),
  ...[90, 75, 50].map((percent) => ({ id: `resize-${percent}-percent`, family: "resize", percent })),
  ...[2048, 1600, 1280].map((maxDimension) => ({ id: `max-dimension-${maxDimension}`, family: "max-dimension", maxDimension })),
  { id: "png-to-jpeg-quality-80", family: "conversion", quality: 80 },
  { id: "jpeg-to-jpeg-recompression-quality-80", family: "jpeg-recompression", quality: 80, normalizeJpeg: true },
  { id: "metadata-strip", family: "metadata" },
  { id: "resize-75-percent-then-jpeg-quality-80", family: "combined", percent: 75, quality: 80 },
  { id: "resize-50-percent-then-jpeg-quality-75", family: "combined", percent: 50, quality: 75 },
];

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { quick: false, algorithms: DEFAULT_ALGORITHMS };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--quick") result.quick = true;
    else if (args[i] === "--algorithms") {
      result.algorithms = (args[++i] ?? "").split(",").filter(Boolean);
    } else throw new Error(`unknown argument: ${args[i]}`);
  }
  for (const algorithm of result.algorithms) {
    if (!ALL_ALGORITHMS.includes(algorithm)) throw new Error(`unknown algorithm: ${algorithm}`);
  }
  return result;
}

function payloadBytes(size) {
  const data = new Uint8Array(size);
  let state = (0x9e3779b9 ^ size) >>> 0;
  for (let i = 0; i < size; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    data[i] = state & 0xff;
  }
  return data;
}

function syntheticPixels(kind, width, height) {
  const data = Buffer.allocUnsafe(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      let r;
      let g;
      let b;
      if (kind === "gradient") {
        r = Math.round((x / Math.max(1, width - 1)) * 255);
        g = Math.round((y / Math.max(1, height - 1)) * 255);
        b = Math.round(((x + y) / Math.max(1, width + height - 2)) * 255);
      } else if (kind === "dark") {
        const texture = ((x * 13 + y * 7 + ((x * y) >>> 8)) & 15);
        r = 5 + texture;
        g = 8 + (texture >> 1);
        b = 12 + texture;
      } else if (kind === "bright") {
        const texture = ((x * 5 + y * 11 + ((x ^ y) & 31)) & 15);
        r = 240 + texture;
        g = 238 + (texture >> 1);
        b = 235 + texture;
      } else if (kind === "low-detail") {
        const region = Math.floor(x / Math.max(1, width / 4)) + Math.floor(y / Math.max(1, height / 3));
        r = 74 + region * 9;
        g = 112 + region * 6;
        b = 142 + region * 4;
      } else {
        const panel = x > width * 0.16 && x < width * 0.84 && y > height * 0.12 && y < height * 0.88;
        const header = panel && y < height * 0.23;
        const line = panel && x > width * 0.24 && x < width * 0.76 && ((y + 11) % 54 < 6);
        const button = panel && x > width * 0.62 && x < width * 0.77 && y > height * 0.72 && y < height * 0.79;
        if (!panel) [r, g, b] = [226, 231, 238];
        else if (header) [r, g, b] = [43, 54, 72];
        else if (button) [r, g, b] = [44, 118, 246];
        else if (line) [r, g, b] = [174, 183, 196];
        else [r, g, b] = [250, 251, 253];
      }
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return data;
}

async function createCarriers() {
  const dir = join(WORK, "carriers");
  await mkdir(dir, { recursive: true });
  for (const carrier of CARRIERS) {
    const extension = carrier.format === "jpeg" ? "jpg" : "png";
    carrier.path = join(dir, `${carrier.id}.${extension}`);
    if (carrier.source) {
      const input = join(ROOT, "benchmarks", "corpus", carrier.source);
      let pipeline = sharp(input).rotate().resize(carrier.width, carrier.height, { fit: "cover", position: "centre" });
      pipeline = carrier.format === "jpeg" ? pipeline.jpeg({ quality: 92 }) : pipeline.png();
      await pipeline.toFile(carrier.path);
    } else {
      const pixels = syntheticPixels(carrier.generated, carrier.width, carrier.height);
      let pipeline = sharp(pixels, { raw: { width: carrier.width, height: carrier.height, channels: 4 } });
      pipeline = carrier.format === "jpeg" ? pipeline.jpeg({ quality: 92 }) : pipeline.png();
      await pipeline.toFile(carrier.path);
    }
    const metadata = await sharp(carrier.path).metadata();
    if (metadata.width !== carrier.width || metadata.height !== carrier.height) {
      throw new Error(`carrier dimension mismatch for ${carrier.id}`);
    }
  }
}

class BenchmarkImageData {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

class BenchmarkCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8ClampedArray(width * height * 4);
  }
  getContext(kind) {
    if (kind !== "2d") return null;
    const canvas = this;
    return {
      drawImage(bitmap, x, y) {
        if (x !== 0 || y !== 0 || bitmap.width !== canvas.width || bitmap.height !== canvas.height) {
          throw new Error("benchmark canvas only supports same-size drawImage at 0,0");
        }
        canvas.pixels.set(bitmap.pixels);
      },
      getImageData() {
        return new BenchmarkImageData(new Uint8ClampedArray(canvas.pixels), canvas.width, canvas.height);
      },
      putImageData(imageData) {
        canvas.pixels.set(imageData.data);
      },
    };
  }
  async convertToBlob(options = {}) {
    const quality = Math.max(1, Math.min(100, Math.round((options.quality ?? 0.75) * 100)));
    const encoded = await sharp(Buffer.from(this.pixels.buffer, this.pixels.byteOffset, this.pixels.byteLength), {
      raw: { width: this.width, height: this.height, channels: 4 },
    }).jpeg({ quality }).toBuffer();
    return new Blob([encoded], { type: "image/jpeg" });
  }
}

async function installCanvasPolyfill() {
  globalThis.ImageData = BenchmarkImageData;
  globalThis.OffscreenCanvas = BenchmarkCanvas;
  globalThis.createImageBitmap = async (blob) => {
    const input = Buffer.from(await blob.arrayBuffer());
    const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return {
      width: info.width,
      height: info.height,
      pixels: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
      close() {},
    };
  };
}

async function loadTypeScriptAlgorithms() {
  await installCanvasPolyfill();
  // Giving Vite an existing, non-listening server prevents middleware-mode
  // SSR from opening an HMR socket. The benchmark does not need HMR.
  const hmrServer = createHttpServer();
  const vite = await createServer({
    configFile: false,
    root: ROOT,
    logLevel: "error",
    appType: "custom",
    server: { middlewareMode: true, hmr: { server: hmrServer } },
  });
  const dot = await vite.ssrLoadModule("/src/stego-dot.ts");
  const qim = await vite.ssrLoadModule("/src/stego-qim.ts");
  return { vite, dot, qim };
}

async function transformBuffer(input, transform) {
  if (transform.id === "identity") return Buffer.from(input);
  let pipeline = sharp(input).rotate();
  if (transform.normalizeJpeg) pipeline = pipeline.jpeg({ quality: 92 });
  if (transform.percent) {
    const metadata = await sharp(input).metadata();
    const width = Math.max(1, Math.round(metadata.width * transform.percent / 100));
    const height = Math.max(1, Math.round(metadata.height * transform.percent / 100));
    pipeline = pipeline.resize(width, height, { kernel: sharp.kernel.lanczos3 });
  } else if (transform.maxDimension) {
    pipeline = pipeline.resize({ width: transform.maxDimension, height: transform.maxDimension, fit: "inside", withoutEnlargement: true, kernel: sharp.kernel.lanczos3 });
  }
  if (transform.family === "metadata") {
    const metadata = await sharp(input).metadata();
    return metadata.format === "jpeg" ? pipeline.jpeg({ quality: 92 }).toBuffer() : pipeline.png().toBuffer();
  }
  if (transform.family === "resize" || transform.family === "max-dimension") {
    const metadata = await sharp(input).metadata();
    return metadata.format === "jpeg" ? pipeline.jpeg({ quality: 92 }).toBuffer() : pipeline.png().toBuffer();
  }
  if (transform.family === "combined" || transform.family === "conversion" || transform.family === "jpeg-recompression") {
    return pipeline.jpeg({ quality: transform.quality ?? 80 }).toBuffer();
  }
  throw new Error(`unhandled transform: ${transform.id}`);
}

async function visualMetrics(reference, candidate) {
  const ref = await sharp(reference).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const got = await sharp(candidate).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (ref.info.width !== got.info.width || ref.info.height !== got.info.height) return null;
  const n = ref.info.width * ref.info.height;
  let sumAbs = 0;
  let maxDiff = 0;
  let squared = 0;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumYY = 0;
  let sumXY = 0;
  for (let p = 0; p < n; p++) {
    const i = p * 3;
    const xr = ref.data[i];
    const xg = ref.data[i + 1];
    const xb = ref.data[i + 2];
    const yr = got.data[i];
    const yg = got.data[i + 1];
    const yb = got.data[i + 2];
    for (let c = 0; c < 3; c++) {
      const diff = Math.abs(ref.data[i + c] - got.data[i + c]);
      sumAbs += diff;
      squared += diff * diff;
      if (diff > maxDiff) maxDiff = diff;
    }
    const x = 0.299 * xr + 0.587 * xg + 0.114 * xb;
    const y = 0.299 * yr + 0.587 * yg + 0.114 * yb;
    sumX += x;
    sumY += y;
    sumXX += x * x;
    sumYY += y * y;
    sumXY += x * y;
  }
  const samples = n * 3;
  const mse = squared / samples;
  const meanX = sumX / n;
  const meanY = sumY / n;
  const denom = Math.max(1, n - 1);
  const varX = (sumXX - n * meanX * meanX) / denom;
  const varY = (sumYY - n * meanY * meanY) / denom;
  const covariance = (sumXY - n * meanX * meanY) / denom;
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  const ssim = ((2 * meanX * meanY + c1) * (2 * covariance + c2)) /
    ((meanX * meanX + meanY * meanY + c1) * (varX + varY + c2));
  return {
    psnr_db: mse === 0 ? null : 10 * Math.log10((255 * 255) / mse),
    ssim,
    average_pixel_difference: sumAbs / samples,
    maximum_pixel_difference: maxDiff,
  };
}

function runBridge(args) {
  const result = spawnSync(BRIDGE, args, { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `bridge exited ${result.status}`).trim());
}

async function encode(algorithm, carrier, payload, outputPath, ts) {
  if (algorithm === "rust-dwt" || algorithm === "rust-dot" || algorithm === "robust-v2") {
    const payloadPath = join(WORK, "payload.bin");
    await writeFile(payloadPath, payload);
    runBridge(["encode", algorithm, carrier.path, payloadPath, outputPath]);
    return readFile(outputPath);
  }
  const input = await readFile(carrier.path);
  if (algorithm === "typescript-dot") {
    const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const encoded = ts.dot.encodeDotIntoRGBA(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), info.width, info.height, payload);
    const bytes = await sharp(Buffer.from(encoded.data.buffer, encoded.data.byteOffset, encoded.data.byteLength), {
      raw: { width: encoded.width, height: encoded.height, channels: 4 },
    }).png().toBuffer();
    await writeFile(outputPath, bytes);
    return bytes;
  }
  const bytes = Buffer.from(await ts.qim.embedQim(new Uint8Array(input), payload));
  await writeFile(outputPath, bytes);
  return bytes;
}

async function decode(algorithm, encoded, inputPath, ts) {
  if (algorithm === "rust-dwt" || algorithm === "rust-dot" || algorithm === "robust-v2") {
    const decodedPath = join(WORK, "decoded.bin");
    const metadata = await sharp(encoded).metadata();
    const extension = metadata.format === "jpeg" ? "jpg" : metadata.format ?? "png";
    const typedInputPath = `${inputPath}.${extension}`;
    await writeFile(typedInputPath, encoded);
    runBridge(["decode", algorithm, typedInputPath, decodedPath]);
    return new Uint8Array(await readFile(decodedPath));
  }
  if (algorithm === "typescript-dot") {
    const { data, info } = await sharp(encoded).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return ts.dot.decodeDotFromRGBA(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), info.width, info.height);
  }
  return ts.qim.detectQim(new Uint8Array(encoded));
}

function exactMatch(a, b) {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function plannedTransforms(carrier, payloadSize, quick) {
  if (quick) {
    if (carrier.id === "normal-photograph" && payloadSize === 512) {
      return [TRANSFORMS[0], TRANSFORMS.find((x) => x.id === "jpeg-quality-80"), TRANSFORMS.find((x) => x.id === "resize-75-percent")];
    }
    return [TRANSFORMS[0]];
  }
  const representative =
    (carrier.id === "low-detail-image" && payloadSize === 32) ||
    (carrier.id === "normal-photograph" && payloadSize === 512) ||
    (carrier.id === "high-detail-photograph" && payloadSize === 1024);
  return representative ? TRANSFORMS : [TRANSFORMS[0]];
}

function baseRow(algorithm, carrier, payloadSize, transform) {
  return {
    algorithm,
    carrier: carrier.id,
    carrier_type: carrier.type,
    original_width: carrier.width,
    original_height: carrier.height,
    processed_width: null,
    processed_height: null,
    payload_size_bytes: payloadSize,
    transformation: transform.id,
    transformation_family: transform.family,
    executed: true,
    encode_success: false,
    decode_success: false,
    payload_exact_match_success: false,
    processing_time_ms: 0,
    encode_time_ms: 0,
    transform_time_ms: 0,
    decode_time_ms: 0,
    output_file_size_bytes: null,
    psnr_db: null,
    ssim: null,
    average_pixel_difference: null,
    maximum_pixel_difference: null,
    error_message: null,
  };
}

async function runMatrix(options, ts) {
  const observations = [];
  for (const algorithm of options.algorithms) {
    for (const carrier of CARRIERS) {
      for (const payloadSize of PAYLOAD_SIZES) {
        const transforms = plannedTransforms(carrier, payloadSize, options.quick);
        const payload = payloadBytes(payloadSize);
        const outputPath = join(WORK, `${algorithm}-${carrier.id}-${payloadSize}.stego`);
        let encoded = null;
        let encodeError = null;
        let encodeMs = 0;
        if (algorithm === "typescript-qim" && carrier.width * carrier.height > QIM_PIXEL_SAFETY_LIMIT) {
          encodeError = `benchmark safety guard: current QIM coefficient stream exceeds ${QIM_PIXEL_SAFETY_LIMIT} pixels`;
        } else {
          const started = performance.now();
          try {
            encoded = await encode(algorithm, carrier, payload, outputPath, ts);
          } catch (error) {
            encodeError = error instanceof Error ? error.message : String(error);
          }
          encodeMs = performance.now() - started;
        }
        for (const transform of transforms) {
          const row = baseRow(algorithm, carrier, payloadSize, transform);
          row.encode_time_ms = encodeMs;
          if (!encoded) {
            row.executed = !encodeError?.startsWith("benchmark safety guard");
            row.error_message = encodeError;
            row.processing_time_ms = encodeMs;
            observations.push(row);
            continue;
          }
          row.encode_success = true;
          let transformed;
          const transformStarted = performance.now();
          try {
            transformed = await transformBuffer(encoded, transform);
            row.transform_time_ms = performance.now() - transformStarted;
            const metadata = await sharp(transformed).metadata();
            row.processed_width = metadata.width ?? null;
            row.processed_height = metadata.height ?? null;
            row.output_file_size_bytes = transformed.length;
          } catch (error) {
            row.transform_time_ms = performance.now() - transformStarted;
            row.error_message = `transform: ${error instanceof Error ? error.message : String(error)}`;
            row.processing_time_ms = row.encode_time_ms + row.transform_time_ms;
            observations.push(row);
            continue;
          }
          const transformedPath = join(WORK, `${algorithm}-${carrier.id}-${payloadSize}-${transform.id}.img`);
          const decodeStarted = performance.now();
          try {
            const decoded = await decode(algorithm, transformed, transformedPath, ts);
            row.decode_success = decoded !== null;
            row.payload_exact_match_success = exactMatch(decoded, payload);
            if (!row.decode_success) row.error_message = "decoder returned no payload";
            else if (!row.payload_exact_match_success) row.error_message = "decoded payload did not exactly match";
          } catch (error) {
            row.error_message = `decode: ${error instanceof Error ? error.message : String(error)}`;
          }
          row.decode_time_ms = performance.now() - decodeStarted;
          try {
            const reference = await transformBuffer(await readFile(carrier.path), transform);
            Object.assign(row, await visualMetrics(reference, transformed));
          } catch (error) {
            row.error_message ??= `metrics: ${error instanceof Error ? error.message : String(error)}`;
          }
          row.processing_time_ms = row.encode_time_ms + row.transform_time_ms + row.decode_time_ms;
          observations.push(row);
        }
        process.stdout.write(`\r${algorithm}: ${carrier.id} ${payloadSize} bytes (${observations.length} rows)`);
      }
    }
  }
  process.stdout.write("\n");
  return observations;
}

function aggregate(observations, key) {
  const groups = new Map();
  for (const row of observations) {
    const name = row[key];
    const group = groups.get(name) ?? { group: name, rows: 0, executed: 0, encode_successes: 0, decode_successes: 0, exact_match_successes: 0 };
    group.rows++;
    if (row.executed) group.executed++;
    if (row.encode_success) group.encode_successes++;
    if (row.decode_success) group.decode_successes++;
    if (row.payload_exact_match_success) group.exact_match_successes++;
    groups.set(name, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    exact_match_success_rate: group.executed ? group.exact_match_successes / group.executed : 0,
  }));
}

function csvValue(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function writeReports(observations, options) {
  await mkdir(REPORT_DIR, { recursive: true });
  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    git_commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
    node_version: process.version,
    profile: options.quick ? "quick" : "baseline",
    algorithms: options.algorithms,
    payload_sizes_bytes: PAYLOAD_SIZES,
    carriers: CARRIERS.map(({ path: _path, ...carrier }) => carrier),
    transformations: TRANSFORMS,
    notes: [
      "Results describe the current implementations; no robust-v2 changes are present.",
      "executed=false identifies the documented TypeScript QIM high-resolution memory safety guard.",
      "PSNR null with zero average difference means mathematically infinite PSNR.",
    ],
    summary_by_algorithm: aggregate(observations, "algorithm"),
    summary_by_transformation_family: aggregate(observations, "transformation_family"),
    observations,
  };
  const includesV2 = options.algorithms.includes("robust-v2");
  const stem = includesV2 ? "robust-v2-results" : "current-baseline";
  const jsonPath = join(REPORT_DIR, `${stem}.json`);
  const csvPath = join(REPORT_DIR, `${stem}.csv`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  const headers = Object.keys(observations[0] ?? baseRow("", CARRIERS[0], 0, TRANSFORMS[0]));
  const csv = [headers.join(","), ...observations.map((row) => headers.map((header) => csvValue(row[header])).join(","))].join("\n");
  await writeFile(csvPath, `${csv}\n`);
  const digest = createHash("sha256").update(JSON.stringify(observations)).digest("hex");
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${csvPath}`);
  console.log(`Observation digest: ${digest}`);
}

async function main() {
  const options = parseArgs();
  await rm(WORK, { recursive: true, force: true });
  await mkdir(WORK, { recursive: true });
  if (options.algorithms.some((algorithm) => algorithm.startsWith("rust-"))) {
    console.log("Building Rust production bridge...");
    execFileSync("cargo", ["build", "--quiet", "--bin", "stegstr_benchmark_bridge"], { cwd: join(ROOT, "src-tauri"), stdio: "inherit" });
    if (!existsSync(BRIDGE)) throw new Error(`bridge was not built: ${BRIDGE}`);
  }
  console.log("Preparing deterministic carrier corpus...");
  await createCarriers();
  const ts = options.algorithms.some((algorithm) => algorithm.startsWith("typescript-"))
    ? await loadTypeScriptAlgorithms()
    : { vite: { close: async () => {} } };
  try {
    const observations = await runMatrix(options, ts);
    await writeReports(observations, options);
  } finally {
    await ts.vite.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
