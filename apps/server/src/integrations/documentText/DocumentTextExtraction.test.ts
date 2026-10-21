import { describe, expect, it } from "@effect/vitest";

import {
  DOCUMENT_TEXT_MAX_PDF_PAGES,
  extractDocumentTextInProcess,
} from "./DocumentTextExtraction.ts";
import { makeDocx, makePdf, makeZip, wordDocumentXml } from "./DocumentTextFixtures.testkit.ts";

describe("PDF text extraction", () => {
  it("reads every page's text from a valid PDF", async () => {
    const result = await extractDocumentTextInProcess({
      format: "pdf",
      bytes: makePdf(["Quarterly budget summary", "Second page canary 7Q4-PDF"]),
    });
    expect(result).toMatchObject({
      status: "extracted",
      format: "pdf",
      pageCount: 2,
      pagesRead: 2,
    });
    expect(result.status === "extracted" && result.text).toBe(
      "Quarterly budget summary\n\nSecond page canary 7Q4-PDF",
    );
    expect(result.status === "extracted" && result.truncated).toBe(false);
  });

  it("stops at the page limit and reports truncation", async () => {
    const pages = Array.from(
      { length: DOCUMENT_TEXT_MAX_PDF_PAGES + 3 },
      (_, index) => `Page ${index + 1}`,
    );
    const result = await extractDocumentTextInProcess({ format: "pdf", bytes: makePdf(pages) });
    expect(result).toMatchObject({
      status: "extracted",
      pageCount: DOCUMENT_TEXT_MAX_PDF_PAGES + 3,
      pagesRead: DOCUMENT_TEXT_MAX_PDF_PAGES,
      truncated: true,
    });
    expect(result.status === "extracted" && result.text).not.toContain(
      `Page ${DOCUMENT_TEXT_MAX_PDF_PAGES + 1}`,
    );
  });

  it("bounds the characters it returns", async () => {
    const result = await extractDocumentTextInProcess({
      format: "pdf",
      bytes: makePdf(["A".repeat(500)]),
      maxCharacters: 40,
    });
    expect(result).toMatchObject({ status: "extracted", truncated: true });
    expect(result.status === "extracted" && result.text.length).toBe(40);
  });

  it("fails clearly on damaged or mislabeled input", async () => {
    await expect(
      extractDocumentTextInProcess({
        format: "pdf",
        bytes: new TextEncoder().encode("%PDF-1.7\ngarbage"),
      }),
    ).resolves.toMatchObject({ status: "failed", reason: "corrupt" });
    await expect(
      extractDocumentTextInProcess({
        format: "pdf",
        bytes: new Uint8Array([0x4d, 0x5a, 0x90, 0x00]),
      }),
    ).resolves.toMatchObject({
      status: "failed",
      reason: "corrupt",
      message: "The file is not a PDF document.",
    });
  });

  it("reports a PDF without text instead of returning nothing", async () => {
    await expect(
      extractDocumentTextInProcess({ format: "pdf", bytes: makePdf([""]) }),
    ).resolves.toMatchObject({ status: "failed", reason: "no_text" });
  });
});

describe("DOCX text extraction", () => {
  it("reads paragraphs, tabs, and escaped characters from the document body", async () => {
    const result = await extractDocumentTextInProcess({
      format: "docx",
      bytes: makeDocx(["Résumé for A &amp; B", "Name\tRole", "Canary 7Q4-DOCX &#x2713;"]),
    });
    expect(result).toEqual({
      status: "extracted",
      format: "docx",
      text: "Résumé for A & B\nName\tRole\nCanary 7Q4-DOCX ✓",
      truncated: false,
      containsMacros: false,
    });
  });

  it("flags a macro-enabled package", async () => {
    await expect(
      extractDocumentTextInProcess({
        format: "docx",
        bytes: makeDocx(["Hello"], { macros: true }),
      }),
    ).resolves.toMatchObject({ status: "extracted", containsMacros: true });
  });

  it("refuses document type declarations instead of expanding entities", async () => {
    const xml = wordDocumentXml(["&lol;"]).replace(
      "<w:document",
      '<!DOCTYPE w:document [<!ENTITY lol "lololololol">]><w:document',
    );
    await expect(
      extractDocumentTextInProcess({ format: "docx", bytes: makeDocx([], { documentXml: xml }) }),
    ).resolves.toMatchObject({ status: "failed", reason: "corrupt" });
  });

  it("reports truncation honestly at an exact character boundary", async () => {
    await expect(
      extractDocumentTextInProcess({
        format: "docx",
        bytes: makeDocx(["Hello"]),
        maxCharacters: 5,
      }),
    ).resolves.toMatchObject({ status: "extracted", text: "Hello", truncated: false });
    await expect(
      extractDocumentTextInProcess({
        format: "docx",
        bytes: makeDocx(["Hello", "World"]),
        maxCharacters: 5,
      }),
    ).resolves.toMatchObject({ status: "extracted", text: "Hello", truncated: true });
    await expect(
      extractDocumentTextInProcess({
        format: "docx",
        bytes: makeDocx(["Hello", "World"]),
        maxCharacters: 11,
      }),
    ).resolves.toMatchObject({ status: "extracted", text: "Hello\nWorld", truncated: false });
    await expect(
      extractDocumentTextInProcess({
        format: "docx",
        bytes: makeDocx(["Hello", "World"]),
        maxCharacters: 6,
      }),
    ).resolves.toMatchObject({ status: "extracted", text: "Hello", truncated: true });
    await expect(
      extractDocumentTextInProcess({
        format: "docx",
        bytes: makeDocx(["Hello", "World"]),
        maxCharacters: 7,
      }),
    ).resolves.toMatchObject({ status: "extracted", text: "Hello\nW", truncated: true });
  });

  it("reads UTF-16 document bodies with or without a byte order mark", async () => {
    const xml = wordDocumentXml(["Résumé ✓", "Second"]).replace(
      'encoding="UTF-8"',
      'encoding="UTF-16"',
    );
    const utf16le = Buffer.from(xml, "utf16le");
    const utf16be = Buffer.from(utf16le).swap16();
    const bodies = [
      Buffer.concat([Buffer.from([0xff, 0xfe]), utf16le]),
      Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be]),
      utf16le,
      utf16be,
    ];
    for (const body of bodies) {
      await expect(
        extractDocumentTextInProcess({
          format: "docx",
          bytes: makeZip([
            { name: "word/document.xml", data: new Uint8Array(body), deflate: true },
          ]),
        }),
      ).resolves.toMatchObject({
        status: "extracted",
        text: "Résumé ✓\nSecond",
        truncated: false,
      });
    }
    const utf8WithBom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(wordDocumentXml(["Plain"]), "utf8"),
    ]);
    await expect(
      extractDocumentTextInProcess({
        format: "docx",
        bytes: makeZip([{ name: "word/document.xml", data: new Uint8Array(utf8WithBom) }]),
      }),
    ).resolves.toMatchObject({ status: "extracted", text: "Plain" });
  });

  it("refuses unsupported, mismatched, or malformed body encodings", async () => {
    const docx = (body: Uint8Array) =>
      extractDocumentTextInProcess({
        format: "docx",
        bytes: makeZip([{ name: "word/document.xml", data: body }]),
      });
    const latin1 = Buffer.from(
      wordDocumentXml(["caf\u00e9"]).replace('encoding="UTF-8"', 'encoding="ISO-8859-1"'),
      "latin1",
    );
    await expect(docx(new Uint8Array(latin1))).resolves.toMatchObject({
      status: "failed",
      reason: "corrupt",
      message: expect.stringContaining("encoding"),
    });
    const declaredUtf16ButUtf8 = Buffer.from(
      wordDocumentXml(["x"]).replace('encoding="UTF-8"', 'encoding="UTF-16"'),
      "utf8",
    );
    await expect(docx(new Uint8Array(declaredUtf16ButUtf8))).resolves.toMatchObject({
      status: "failed",
      reason: "corrupt",
    });
    const oddUtf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(wordDocumentXml(["x"]), "utf16le"),
      Buffer.from([0x41]),
    ]);
    await expect(docx(new Uint8Array(oddUtf16))).resolves.toMatchObject({
      status: "failed",
      reason: "corrupt",
    });
    const utf32 = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x00]), Buffer.from("<\0\0\0")]);
    await expect(docx(new Uint8Array(utf32))).resolves.toMatchObject({
      status: "failed",
      reason: "corrupt",
    });
    const invalidUtf8 = Buffer.concat([
      Buffer.from(wordDocumentXml(["ok"]).slice(0, -30), "utf8"),
      Buffer.from([0xc3, 0x28]),
    ]);
    await expect(docx(new Uint8Array(invalidUtf8))).resolves.toMatchObject({
      status: "failed",
      reason: "corrupt",
    });
    const utf16Dtd = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(
        wordDocumentXml(["&lol;"])
          .replace('encoding="UTF-8"', 'encoding="UTF-16"')
          .replace("<w:document", '<!DOCTYPE w:document [<!ENTITY lol "lol">]><w:document'),
        "utf16le",
      ),
    ]);
    await expect(docx(new Uint8Array(utf16Dtd))).resolves.toMatchObject({
      status: "failed",
      reason: "corrupt",
      message: expect.stringContaining("document type"),
    });
  });

  it("refuses a body that expands far beyond its stored size", async () => {
    const bomb = makeZip([
      {
        name: "word/document.xml",
        data: `<w:document><w:body><w:p><w:t>${" ".repeat(4 * 1024 * 1024)}</w:t></w:p></w:body></w:document>`,
        deflate: true,
      },
    ]);
    expect(bomb.byteLength).toBeLessThan(64 * 1024);
    await expect(
      extractDocumentTextInProcess({ format: "docx", bytes: bomb }),
    ).resolves.toMatchObject({
      status: "failed",
      reason: "expanding",
    });
  });

  it("refuses a body whose declared size is a lie", async () => {
    const lying = makeZip([
      {
        name: "word/document.xml",
        data: `<w:document><w:body><w:p><w:t>${"x".repeat(2 * 1024 * 1024)}</w:t></w:p></w:body></w:document>`,
        deflate: true,
        declaredSize: 1000,
      },
    ]);
    const result = await extractDocumentTextInProcess({ format: "docx", bytes: lying });
    expect(result.status).toBe("failed");
  });

  it("refuses an oversized body and archives with too many parts", async () => {
    const huge = makeZip([
      {
        name: "word/document.xml",
        data: "<w:document/>",
        deflate: true,
        declaredSize: 32 * 1024 * 1024,
      },
    ]);
    await expect(
      extractDocumentTextInProcess({ format: "docx", bytes: huge }),
    ).resolves.toMatchObject({
      status: "failed",
      reason: "too_large",
    });
    const crowded = makeZip(
      Array.from({ length: 2_001 }, (_, index) => ({ name: `part${index}.xml`, data: "x" })),
    );
    await expect(
      extractDocumentTextInProcess({ format: "docx", bytes: crowded }),
    ).resolves.toMatchObject({
      status: "failed",
      reason: "too_large",
    });
  });

  it("fails clearly for non-Word ZIPs, damaged ZIPs, and other bytes", async () => {
    await expect(
      extractDocumentTextInProcess({
        format: "docx",
        bytes: makeZip([{ name: "a.txt", data: "hi" }]),
      }),
    ).resolves.toMatchObject({ status: "failed", reason: "corrupt" });
    await expect(
      extractDocumentTextInProcess({
        format: "docx",
        bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]),
      }),
    ).resolves.toMatchObject({ status: "failed", reason: "corrupt" });
    await expect(
      extractDocumentTextInProcess({ format: "docx", bytes: makePdf(["not docx"]) }),
    ).resolves.toMatchObject({ status: "failed", reason: "corrupt" });
  });
});
