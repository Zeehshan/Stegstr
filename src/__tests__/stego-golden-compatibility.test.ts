import { Blob as NodeBlob } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { decodeDotFromRGBA } from "../stego-dot";
import { detectQim } from "../stego-qim";

const PAYLOAD = Uint8Array.from([
  0x7b, 0x98, 0x92, 0x09, 0x4d, 0xae, 0xad, 0x70,
  0x72, 0x51, 0x5e, 0x35, 0x7a, 0xaa, 0xea, 0xc7,
  0x11, 0x90, 0xa2, 0x3d, 0xc9, 0x36, 0x2b, 0x72,
  0xb5, 0x87, 0xe4, 0x59, 0x41, 0x35, 0xbc, 0xd2,
]);

const goldenPath = (name: string): string => resolve(process.cwd(), "benchmarks", "golden", name);

class GoldenImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;

  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

class GoldenCanvas {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8ClampedArray(width * height * 4);
  }

  getContext(kind: string) {
    if (kind !== "2d") return null;
    return {
      drawImage: (bitmap: { pixels: Uint8ClampedArray }) => this.pixels.set(bitmap.pixels),
      getImageData: () => new GoldenImageData(new Uint8ClampedArray(this.pixels), this.width, this.height),
      putImageData: (imageData: GoldenImageData) => this.pixels.set(imageData.data),
    };
  }
}

async function installDecodeCanvas(): Promise<void> {
  Object.assign(globalThis, {
    Blob: NodeBlob,
    ImageData: GoldenImageData,
    OffscreenCanvas: GoldenCanvas,
    createImageBitmap: async (blob: NodeBlob) => {
      const input = Buffer.from(await blob.arrayBuffer());
      const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return {
        width: info.width,
        height: info.height,
        pixels: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
        close() {},
      };
    },
  });
}

function expectHash(bytes: Buffer, expected: string): void {
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(expected);
}

describe("golden steganography compatibility vectors", () => {
  it("decodes the TypeScript dot vector exactly", async () => {
    const bytes = readFileSync(goldenPath("typescript-dot.png"));
    expectHash(bytes, "daf1302dd1bfd30da03b68100a17ab236d5bc05e50d8f03eae44cbdb1e6ac07a");
    const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const decoded = decodeDotFromRGBA(
      new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
      info.width,
      info.height,
    );
    expect(decoded).toEqual(PAYLOAD);
  });

  it("decodes the TypeScript QIM vector exactly", async () => {
    await installDecodeCanvas();
    const bytes = readFileSync(goldenPath("typescript-qim.jpg"));
    expectHash(bytes, "e834f759c8148ea100d7126ab3797040d537de0d7a7beeecd7db30d58b8cf693");
    const decoded = await detectQim(new Uint8Array(bytes));
    expect(decoded).toEqual(PAYLOAD);
  });

  it("documents Rust dot as incompatible with the TypeScript dot decoder", async () => {
    const bytes = readFileSync(goldenPath("rust-dot.png"));
    const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const decoded = decodeDotFromRGBA(
      new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
      info.width,
      info.height,
    );
    expect(decoded).toBeNull();
  });
});
