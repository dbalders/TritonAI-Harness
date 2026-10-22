// @effect-diagnostics nodeBuiltinImport:off - synthetic document fixtures for extractor tests.
import * as NodeZlib from "node:zlib";

const encoder = new TextEncoder();

/** A minimal valid PDF with one Helvetica text line per page. */
export function makePdf(pages: ReadonlyArray<string>): Uint8Array {
  const objects: Array<string> = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add("");
  const pagesObject = add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const kids: Array<number> = [];
  for (const text of pages) {
    const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
    const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesObject} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObject} 0 R >>`;
  objects[pagesObject - 1] =
    `<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let output = "%PDF-1.4\n";
  const offsets: Array<number> = [];
  objects.forEach((body, index) => {
    offsets.push(output.length);
    output += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = output.length;
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  output += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encoder.encode(output);
}

export interface ZipEntryFixture {
  readonly name: string;
  readonly data: Uint8Array | string;
  /** Deflate the member (method 8); stored (method 0) otherwise. */
  readonly deflate?: boolean;
  /** Overrides the uncompressed size written to the headers. */
  readonly declaredSize?: number;
}

/** A small ZIP writer for fixtures; it supports stored and deflated members only. */
export function makeZip(entries: ReadonlyArray<ZipEntryFixture>): Uint8Array {
  const locals: Array<Buffer> = [];
  const centrals: Array<Buffer> = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.from(
      typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data,
    );
    const stored = entry.deflate ? NodeZlib.deflateRawSync(raw) : raw;
    const crc = NodeZlib.crc32(raw);
    const size = entry.declaredSize ?? raw.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(entry.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, stored);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(entry.deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + stored.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, centralBytes, end]));
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';

export function wordDocumentXml(paragraphs: ReadonlyArray<string>): string {
  const body = paragraphs
    .map((paragraph) => {
      const runs = paragraph
        .split("\t")
        .map((part) => `<w:r><w:t xml:space="preserve">${part}</w:t></w:r>`)
        .join("<w:r><w:tab/></w:r>");
      return `<w:p>${runs}</w:p>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
}

/** A DOCX whose paragraphs are already XML-escaped WordprocessingML text. */
export function makeDocx(
  paragraphs: ReadonlyArray<string>,
  options: { readonly macros?: boolean; readonly documentXml?: string } = {},
): Uint8Array {
  return makeZip([
    { name: "[Content_Types].xml", data: CONTENT_TYPES },
    {
      name: "word/document.xml",
      data: options.documentXml ?? wordDocumentXml(paragraphs),
      deflate: true,
    },
    ...(options.macros
      ? [{ name: "word/vbaProject.bin", data: new Uint8Array([0xd0, 0xcf]) }]
      : []),
  ]);
}
