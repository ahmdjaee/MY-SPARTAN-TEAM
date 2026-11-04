import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";

/**
 * Berkas uji dummy untuk alur unggah — dibuat tanpa dependency tambahan.
 * Yang diuji adalah alur unggahnya, bukan isi berkasnya; yang penting berkasnya
 * valid untuk tipenya dan ukurannya bisa diatur (uji batas "maks 2 MB").
 */

export type TestFileKind = "png" | "jpg" | "pdf" | "csv" | "txt" | "json" | "bin";

export const KINDS: TestFileKind[] = ["png", "jpg", "pdf", "csv", "txt", "json", "bin"];

export const MIME: Record<TestFileKind, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  pdf: "application/pdf",
  csv: "text/csv",
  txt: "text/plain",
  json: "application/json",
  bin: "application/octet-stream",
};

export function kindFromName(name: string): TestFileKind | undefined {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "jpeg") return "jpg";
  return KINDS.includes(ext as TestFileKind) ? (ext as TestFileKind) : undefined;
}

export type TestFileSpec = {
  name: string;
  kind: TestFileKind;
  /** Ukuran akhir yang diinginkan; isi dipadatkan dengan padding yang tetap valid untuk tipenya. */
  sizeKb?: number;
  text?: string;
  width?: number;
  height?: number;
  /** JPEG tidak bisa dibuat murni di Node — disediakan oleh pemanggil (screenshot Playwright). */
  jpeg?: Buffer;
};

// ---------- PNG ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** PNG RGB 8-bit: latar biru muda dengan garis diagonal supaya jelas gambar sungguhan, bukan kotak kosong. */
function makePng(width: number, height: number, padBytes: number): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const diagonal = (x + y) % 40 < 4;
      const offset = row + 1 + x * 3;
      raw[offset] = diagonal ? 0x23 : 0xdb;
      raw[offset + 1] = diagonal ? 0x83 : 0xea;
      raw[offset + 2] = diagonal ? 0xe2 : 0xfe;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const chunks = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
  ];
  // Padding: chunk tEXt (keyword "Comment") — tetap PNG yang sah.
  let remaining = padBytes;
  while (remaining > 0) {
    const overhead = 12 + "Comment".length + 1;
    const body = Math.min(Math.max(remaining - overhead, 0), 1 << 20);
    chunks.push(pngChunk("tEXt", Buffer.concat([Buffer.from("Comment\0", "latin1"), Buffer.alloc(body, 0x20)])));
    remaining -= overhead + body;
  }
  chunks.push(pngChunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

// ---------- JPEG padding ----------

/** Sisipkan segmen COM (0xFFFE) tepat setelah SOI supaya ukuran naik tanpa merusak gambar. */
function padJpeg(jpeg: Buffer, padBytes: number): Buffer {
  if (padBytes <= 0 || jpeg.length < 2) return jpeg;
  const segments: Buffer[] = [jpeg.subarray(0, 2)];
  let remaining = padBytes;
  while (remaining > 0) {
    const body = Math.min(Math.max(remaining - 4, 1), 0xfffd);
    const header = Buffer.from([0xff, 0xfe, ((body + 2) >> 8) & 0xff, (body + 2) & 0xff]);
    segments.push(header, Buffer.alloc(body, 0x20));
    remaining -= 4 + body;
  }
  segments.push(jpeg.subarray(2));
  return Buffer.concat(segments);
}

// ---------- PDF ----------

function makePdf(title: string, padBytes: number): Buffer {
  const escaped = title.replace(/[\\()]/g, (char) => `\\${char}`);
  const content = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
  const comment = padBytes > 0 ? Buffer.alloc(padBytes, 0x20) : Buffer.alloc(0);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    // Objek stream "komentar": isinya padding, tidak dirujuk halaman mana pun.
    `<< /Length ${comment.length} >>\nstream\n${comment.toString("latin1")}\nendstream`,
  ];
  let body = "%PDF-1.4\n%âãÏÓ\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

// ---------- teks ----------

const SAMPLE: Record<"csv" | "txt" | "json", string> = {
  csv: "id,nama,email\n1,Ani Wijaya,ani@example.com\n2,Budi Santoso,budi@example.com\n3,Citra Lestari,citra@example.com\n",
  txt: "Berkas uji QA — dibuat otomatis untuk menguji alur unggah.\n",
  json: '{\n  "uji": true,\n  "dibuat": "ai-team qa",\n  "item": [1, 2, 3]\n}\n',
};

function padText(text: string, padBytes: number): string {
  if (padBytes <= 0) return text;
  // Baris spasi di akhir: tetap CSV/teks/JSON yang sah (JSON mengizinkan whitespace di luar nilai).
  return text + " ".repeat(Math.max(padBytes - 1, 0)) + "\n";
}

// ---------- gabungan ----------

/** Buat isi berkas uji. Ukuran akhir ≈ sizeKb × 1024 (dibulatkan ke atas oleh overhead kecil). */
export function makeTestFile(spec: TestFileSpec): { buffer: Buffer; mime: string } {
  const target = spec.sizeKb ? spec.sizeKb * 1024 : 0;
  const mime = MIME[spec.kind];
  switch (spec.kind) {
    case "png": {
      const width = spec.width ?? 320;
      const height = spec.height ?? 240;
      const base = makePng(width, height, 0);
      return { buffer: target > base.length ? makePng(width, height, target - base.length) : base, mime };
    }
    case "jpg": {
      if (!spec.jpeg) throw new Error("JPEG membutuhkan browser untuk dirender");
      return { buffer: padJpeg(spec.jpeg, target - spec.jpeg.length), mime };
    }
    case "pdf": {
      const title = `Berkas uji QA ${spec.name} ${new Date().toISOString().slice(0, 10)}`;
      const base = makePdf(title, 0);
      return { buffer: target > base.length ? makePdf(title, target - base.length) : base, mime };
    }
    case "bin":
      return { buffer: randomBytes(target || 4096), mime };
    default: {
      const text = spec.text ?? SAMPLE[spec.kind];
      const base = Buffer.byteLength(text);
      return { buffer: Buffer.from(padText(text, target - base)), mime };
    }
  }
}
