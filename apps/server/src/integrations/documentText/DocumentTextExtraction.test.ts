import { describe, expect, it } from "@effect/vitest";

import {
  DOCUMENT_TEXT_MAX_PDF_PAGES,
  extractDocumentTextInProcess,
} from "./DocumentTextExtraction.ts";
import { makeDocx, makePdf, makeZip, wordDocumentXml } from "./DocumentTextFixtures.testkit.ts";

describe("PDF text extraction", () => {
  // regression: #417 fix(server): bound attachment text extraction and browser navigation approval
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

  // regression: #417 fix(server): bound attachment text extraction and browser navigation approval
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

  // regression: #417 fix(server): bound attachment text extraction and browser navigation approval
  it("bounds the characters it returns", async () => {
    const result = await extractDocumentTextInProcess({
      format: "pdf",
      bytes: makePdf(["A".repeat(500)]),
      maxCharacters: 40,
    });
    expect(result).toMatchObject({ status: "extracted", truncated: true });
    expect(result.status === "extracted" && result.text.length).toBe(40);
  });

  // regression: #417 fix(server): bound attachment text extraction and browser navigation approval
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

  // regression: #417 fix(server): bound attachment text extraction and browser navigation approval
  it("reports a PDF without text instead of returning nothing", async () => {
    await expect(
      extractDocumentTextInProcess({ format: "pdf", bytes: makePdf([""]) }),
    ).resolves.toMatchObject({ status: "failed", reason: "no_text" });
  });
});

describe("DOCX text extraction", () => {
  // regression: #417 fix(server): bound attachment text extraction and browser navigation approval
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

  // regression: #417 fix(server): bound attachment text extraction and browser navigation approval
  it("flags a macro-enabled package", async () => {
    await expect(
      extractDocumentTextInProcess({
        format: "docx",
        bytes: makeDocx(["Hello"], { macros: true }),
      }),
    ).resolves.toMatchObject({ status: "extracted", containsMacros: true });
  });

  // regression: #417 fix(server): bound attachment text extraction and browser navigation approval
  it("refuses document type declarations instead of expanding entities", async () => {
    const xml = wordDocumentXml(["&lol;"]).replace(
      "<w:document",
      '<!DOCTYPE w:document [<!ENTITY lol "lololololol">]><w:document',
    );
    await expect(
      extractDocumentTextInProcess({ format: "docx", bytes: makeDocx([], { documentXml: xml }) }),
    ).resolves.toMatchObject({ status: "failed", reason: "corrupt" });
  });

  // regression: #417 fix(server): bound attachment text extraction and browser navigation approval
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

  // regression: #417 fix(server): bound attachment text extraction and browser navigation approval
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

  // regression: #417 fix(server): bound attachment text extraction and browser navigation approval
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

  const WORD_MAIN = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const docxBody = (body: string, maxCharacters?: number) =>
    extractDocumentTextInProcess({
      format: "docx",
      bytes: makeDocx([], { documentXml: `<?xml version="1.0" encoding="UTF-8"?>${body}` }),
      ...(maxCharacters === undefined ? {} : { maxCharacters }),
    });

  // regression: #417 fix(server): bound attachment text extraction and browser navigation approval
  it("recognizes WordprocessingML by namespace, not by a literal w: prefix", async () => {
    await expect(
      docxBody(
        `<x:document xmlns:x="${WORD_MAIN}"><x:body><x:p><x:r><x:t>Hello</x:t><x:tab/><x:t>there</x:t></x:r></x:p><x:p><x:r><x:t>Next</x:t></x:r></x:p></x:body></x:document>`,
      ),
    ).resolves.toMatchObject({ status: "extracted", text: "Hello\tthere\nNext" });
    await expect(
      docxBody(
        `<document xmlns="${WORD_MAIN}"><body><p><r><t>Default</t><br/><t>namespace</t></r></p></body></document>`,
      ),
    ).resolves.toMatchObject({ status: "extracted", text: "Default\nnamespace" });
    await expect(
      docxBody(
        `<w:document xmlns:w="${WORD_MAIN}"><w:body><w:p><w:r><w:t>One</w:t></w:r></w:p><a:p xmlns:a="${WORD_MAIN}"><a:r><a:t>Two</a:t></a:r><w:r><w:t>Three</w:t></w:r></a:p></w:body></w:document>`,
      ),
    ).resolves.toMatchObject({ status: "extracted", text: "One\nTwoThree" });
    await expect(
      docxBody(
        `<w:document xmlns:w="http://purl.oclc.org/ooxml/wordprocessingml/main"><w:body><w:p><w:r><w:t>Strict</w:t></w:r></w:p></w:body></w:document>`,
      ),
    ).resolves.toMatchObject({ status: "extracted", text: "Strict" });
  });

  // regression: #417 fix(server): bound attachment text extraction and browser navigation approval
  it("does not count an unrelated namespace bound to w as WordprocessingML", async () => {
    await expect(
      docxBody(
        `<w:document xmlns:w="${WORD_MAIN}"><w:body><w:p><w:r><w:t>Seen</w:t></w:r><w:r xmlns:w="urn:example:other"><w:t>Hidden</w:t><w:tab/></w:r><w:r><w:t>Again</w:t></w:r></w:p></w:body></w:document>`,
      ),
    ).resolves.toMatchObject({ status: "extracted", text: "SeenAgain" });
    await expect(
      docxBody(
        `<w:document xmlns:w="urn:example:other"><w:body><w:p><w:r><w:t>Not Word</w:t></w:r></w:p></w:body></w:document>`,
      ),
    ).resolves.toMatchObject({ status: "failed", reason: "no_text" });
    await expect(
      docxBody(
        `<document xmlns="${WORD_MAIN}"><body><p><r xmlns=""><t>Unqualified</t></r><r><t>Word</t></r></p></body></document>`,
      ),
    ).resolves.toMatchObject({ status: "extracted", text: "Word" });
  });

  // regression: #417 fix(server): bound attachment text extraction and browser navigation approval
  it("accepts only the canonical binding for the reserved xml prefix", async () => {
    const XML_NS = "http://www.w3.org/XML/1998/namespace";
    await expect(
      docxBody(
        `<w:document xmlns:w="${WORD_MAIN}" xmlns:xml="${XML_NS}"><w:body><w:p><w:r><w:t xml:space="preserve">Explicit</w:t></w:r></w:p></w:body></w:document>`,
      ),
    ).resolves.toMatchObject({ status: "extracted", text: "Explicit" });
    await expect(
      docxBody(
        `<w:document xmlns:w="${WORD_MAIN}"><w:body><w:p xmlns:xml="${XML_NS}"><w:r><w:t>Scoped</w:t></w:r></w:p></w:body></w:document>`,
      ),
    ).resolves.toMatchObject({ status: "extracted", text: "Scoped" });
    for (const declaration of [
      'xmlns:xml="urn:example:other"',
      `xmlns:xml="${WORD_MAIN}"`,
      'xmlns:xml=""',
      `xmlns:xmlns="${XML_NS}"`,
      'xmlns:xmlns="http://www.w3.org/2000/xmlns/"',
      `xmlns:other="${XML_NS}"`,
      `xmlns="${XML_NS}"`,
      'xmlns:other="http://www.w3.org/2000/xmlns/"',
    ]) {
      await expect(
        docxBody(
          `<w:document xmlns:w="${WORD_MAIN}" ${declaration}><w:body><w:p><w:r><w:t>Text</w:t></w:r></w:p></w:body></w:document>`,
        ),
      ).resolves.toMatchObject({ status: "failed", reason: "corrupt" });
    }
  });

  // regression: #417 fix(server): bound attachment text extraction and browser navigation approval
  it("emits run tabs but not paragraph tab-stop definitions", async () => {
    const tabStops = (prefix: string) =>
      `<${prefix}:pPr><${prefix}:tabs><${prefix}:tab ${prefix}:val="left" ${prefix}:pos="720"/><${prefix}:tab ${prefix}:val="right" ${prefix}:pos="9360"/></${prefix}:tabs></${prefix}:pPr>`;
    const body = (prefix: string) =>
      `<${prefix}:document xmlns:${prefix}="${WORD_MAIN}"><${prefix}:body><${prefix}:p><${prefix}:r><${prefix}:t>First</${prefix}:t></${prefix}:r></${prefix}:p><${prefix}:p>${tabStops(prefix)}<${prefix}:r><${prefix}:t>Second</${prefix}:t><${prefix}:tab/><${prefix}:t>Value</${prefix}:t></${prefix}:r></${prefix}:p></${prefix}:body></${prefix}:document>`;
    await expect(docxBody(body("w"))).resolves.toMatchObject({
      status: "extracted",
      text: "First\nSecond\tValue",
      truncated: false,
    });
    await expect(docxBody(body("x"))).resolves.toMatchObject({
      status: "extracted",
      text: "First\nSecond\tValue",
    });
    await expect(docxBody(body("w"), 12)).resolves.toMatchObject({
      status: "extracted",
      text: "First\nSecond",
      truncated: true,
    });
    await expect(docxBody(body("w"), 18)).resolves.toMatchObject({
      status: "extracted",
      text: "First\nSecond\tValue",
      truncated: false,
    });
  });

  // regression: #417 fix(server): bound attachment text extraction and browser navigation approval
  it("reads CDATA as literal text and ignores tag-like text in markup", async () => {
    const wrap = (inner: string) =>
      `<w:document xmlns:w="${WORD_MAIN}"><w:body><w:p><w:r>${inner}</w:r></w:p></w:body></w:document>`;
    await expect(docxBody(wrap("<w:t><![CDATA[Hello]]></w:t>"))).resolves.toMatchObject({
      status: "extracted",
      text: "Hello",
    });
    await expect(
      docxBody(wrap("<w:t>x <![CDATA[A < B &amp; C > D]]> &amp; y</w:t>")),
    ).resolves.toMatchObject({ status: "extracted", text: "x A < B &amp; C > D & y" });
    await expect(
      docxBody(
        wrap(
          '<w:t>Real</w:t><!-- <w:t>Forged comment</w:t> --><?pi <w:t>Forged PI</w:t>?><w:t w:note="a > b /> &lt;w:t>">More</w:t><![CDATA[<w:t>Forged CDATA</w:t>]]>',
        ),
      ),
    ).resolves.toMatchObject({ status: "extracted", text: "RealMore" });
    await expect(docxBody(wrap("<w:t><![CDATA[Hello]]></w:t>"), 5)).resolves.toMatchObject({
      status: "extracted",
      text: "Hello",
      truncated: false,
    });
    await expect(docxBody(wrap("<w:t><![CDATA[Hello]]></w:t>"), 3)).resolves.toMatchObject({
      status: "extracted",
      text: "Hel",
      truncated: true,
    });
  });

  // regression: #417 fix(server): bound attachment text extraction and browser navigation approval
  it("refuses malformed markup instead of returning plausible text", async () => {
    const wrap = (inner: string) =>
      `<w:document xmlns:w="${WORD_MAIN}"><w:body><w:p><w:r>${inner}</w:r></w:p></w:body></w:document>`;
    for (const body of [
      wrap("<w:t><![CDATA[Unterminated</w:t>"),
      wrap("<w:t>Text</w:t><!-- unterminated"),
      wrap("<w:t>Mismatched</w:x>"),
      wrap("<w:t>Unclosed"),
      wrap("<q:t>Unbound prefix</q:t>"),
      wrap('<w:t a="unterminated>Text</w:t>'),
      wrap('<w:t a="raw <w:t> in value">Text</w:t>'),
      wrap('<w:t xmlns:w="">Undeclared prefix</w:t>'),
      `<w:document xmlns:w="${WORD_MAIN}"><w:body><w:p><w:r><w:t>Extra</w:t></w:r></w:p></w:body></w:document></w:document>`,
    ]) {
      await expect(docxBody(body)).resolves.toMatchObject({ status: "failed", reason: "corrupt" });
    }
  });

  // regression: #417 fix(server): bound attachment text extraction and browser navigation approval
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

  // regression: #417 fix(server): bound attachment text extraction and browser navigation approval
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

  // regression: #417 fix(server): bound attachment text extraction and browser navigation approval
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

  // regression: #417 fix(server): bound attachment text extraction and browser navigation approval
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
