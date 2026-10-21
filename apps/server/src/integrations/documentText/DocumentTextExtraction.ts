import * as Yauzl from "yauzl";

/**
 * Text extraction for untrusted PDF and DOCX bytes. It runs only inside the short-lived
 * `__document-text` process started by IntegrationDocumentText.ts, which owns the memory and
 * wall-clock limits; every limit here bounds work so a hostile file fails with a clear reason.
 */
const DOCUMENT_TEXT_FORMATS = ["pdf", "docx"] as const;
export type DocumentTextFormat = (typeof DOCUMENT_TEXT_FORMATS)[number];

export type DocumentTextFailureReason =
  | "corrupt"
  | "encrypted"
  | "too_large"
  | "expanding"
  | "no_text"
  | "timeout"
  | "resource_limit"
  | "cancelled"
  | "busy"
  | "unavailable";

export type DocumentTextResult =
  | {
      readonly status: "extracted";
      readonly format: DocumentTextFormat;
      readonly text: string;
      /** True when pages or characters past the limits were not read. */
      readonly truncated: boolean;
      /** PDF only. */
      readonly pageCount?: number;
      readonly pagesRead?: number;
      /** DOCX only: the package carries a VBA project, so it is macro-enabled. */
      readonly containsMacros?: boolean;
    }
  | {
      readonly status: "failed";
      readonly format: DocumentTextFormat;
      readonly reason: DocumentTextFailureReason;
      readonly message: string;
    };

export const DOCUMENT_TEXT_MAX_INPUT_BYTES = 8 * 1024 * 1024;
export const DOCUMENT_TEXT_MAX_CHARACTERS = 100_000;
export const DOCUMENT_TEXT_MAX_PDF_PAGES = 50;
const DOCX_MAX_ENTRIES = 2_000;
const DOCX_MAX_DOCUMENT_XML_BYTES = 16 * 1024 * 1024;
// Ordinary WordprocessingML compresses about 5-15x. A larger ratio on a big member is how a
// small ZIP expands into gigabytes, so it is refused before inflating.
const DOCX_MAX_COMPRESSION_RATIO = 100;
const DOCX_RATIO_CHECK_MIN_BYTES = 1024 * 1024;

export function isDocumentTextFormat(value: unknown): value is DocumentTextFormat {
  return (
    typeof value === "string" && (DOCUMENT_TEXT_FORMATS as ReadonlyArray<string>).includes(value)
  );
}

function failed(
  format: DocumentTextFormat,
  reason: DocumentTextFailureReason,
  message: string,
): DocumentTextResult {
  return { status: "failed", format, reason, message };
}

class BoundedText {
  readonly maxCharacters: number;
  #parts: Array<string> = [];
  #length = 0;
  truncated = false;
  constructor(maxCharacters: number) {
    this.maxCharacters = maxCharacters;
  }

  get full(): boolean {
    return this.#length >= this.maxCharacters;
  }

  /**
   * Text past the limit marks the result truncated only when it holds visible characters:
   * whitespace there (a closing paragraph break, for example) is trimmed from the output anyway,
   * so a document that fits exactly is not reported as cut short.
   */
  push(value: string): void {
    if (value.length === 0 || this.truncated) return;
    const remaining = this.maxCharacters - this.#length;
    if (value.length > remaining) {
      if (remaining > 0) this.#parts.push(value.slice(0, remaining));
      this.#length = this.maxCharacters;
      if (/\S/u.test(value.slice(remaining))) this.truncated = true;
      return;
    }
    this.#parts.push(value);
    this.#length += value.length;
  }

  toString(): string {
    return this.#parts
      .join("")
      .replace(/[ \t]+\n/gu, "\n")
      .replace(/\n{3,}/gu, "\n\n")
      .trim();
  }
}

// --- PDF -----------------------------------------------------------------------------------

interface PdfTextItem {
  readonly str?: unknown;
  readonly hasEOL?: unknown;
}

async function extractPdf(bytes: Uint8Array, maxCharacters: number): Promise<DocumentTextResult> {
  if (!startsWith(bytes, "%PDF-")) {
    return failed("pdf", "corrupt", "The file is not a PDF document.");
  }
  const { getDocumentProxy } = await import("unpdf");
  let document;
  try {
    // PDF.js 6 no longer compiles fonts or PDF functions into JavaScript, and the extraction
    // process forbids code generation from strings as well.
    document = await getDocumentProxy(new Uint8Array(bytes), {
      disableFontFace: true,
      useSystemFonts: false,
      // No resource URLs are configured, so PDF.js has nothing to fetch over the network.
      verbosity: 0,
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "PasswordException") {
      return failed("pdf", "encrypted", "The PDF is password-protected.");
    }
    return failed("pdf", "corrupt", "The PDF could not be read; it may be damaged.");
  }
  try {
    const pageCount = document.numPages;
    const pagesToRead = Math.min(pageCount, DOCUMENT_TEXT_MAX_PDF_PAGES);
    const text = new BoundedText(maxCharacters);
    let pagesRead = 0;
    for (let pageNumber = 1; pageNumber <= pagesToRead && !text.full; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      for (const item of content.items as ReadonlyArray<PdfTextItem>) {
        if (typeof item.str === "string") text.push(item.str);
        if (item.hasEOL === true) text.push("\n");
      }
      text.push("\n\n");
      page.cleanup();
      pagesRead = pageNumber;
    }
    const extracted = text.toString();
    if (extracted.length === 0) {
      return failed(
        "pdf",
        "no_text",
        "The PDF has no extractable text. It may contain only scanned images, and text recognition is not available.",
      );
    }
    return {
      status: "extracted",
      format: "pdf",
      text: extracted,
      truncated: text.truncated || pagesRead < pageCount,
      pageCount,
      pagesRead,
    };
  } catch {
    return failed("pdf", "corrupt", "The PDF could not be read; it may be damaged.");
  } finally {
    await document.loadingTask.destroy().catch(() => undefined);
  }
}

// --- DOCX ----------------------------------------------------------------------------------

class DocxLimitError extends Error {
  readonly reason: "corrupt" | "too_large" | "expanding";
  constructor(reason: "corrupt" | "too_large" | "expanding", message: string) {
    super(message);
    this.reason = reason;
  }
}

interface DocxParts {
  readonly documentXml: Buffer;
  readonly containsMacros: boolean;
}

function readDocxParts(bytes: Uint8Array): Promise<DocxParts> {
  return new Promise((resolve, reject) => {
    Yauzl.fromBuffer(
      Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: false, decodeStrings: true },
      (openError, zip) => {
        if (openError || !zip) {
          reject(new DocxLimitError("corrupt", "The DOCX file is not a valid Word package."));
          return;
        }
        if (zip.entryCount > DOCX_MAX_ENTRIES) {
          zip.close();
          reject(new DocxLimitError("too_large", "The DOCX package has too many parts."));
          return;
        }
        let documentEntry: Yauzl.Entry | null = null;
        let containsMacros = false;
        let settled = false;
        const finish = (outcome: () => void) => {
          if (settled) return;
          settled = true;
          zip.close();
          outcome();
        };
        zip.on("error", () =>
          finish(() => reject(new DocxLimitError("corrupt", "The DOCX package is damaged."))),
        );
        zip.on("entry", (entry: Yauzl.Entry) => {
          const name = entry.fileName.replaceAll("\\", "/").toLowerCase();
          if (name.endsWith("vbaproject.bin")) containsMacros = true;
          if (name === "word/document.xml") documentEntry = entry;
          zip.readEntry();
        });
        zip.on("end", () => {
          const entry = documentEntry;
          if (!entry) {
            finish(() =>
              reject(new DocxLimitError("corrupt", "The file is not a Word document (no body).")),
            );
            return;
          }
          if (entry.uncompressedSize > DOCX_MAX_DOCUMENT_XML_BYTES) {
            finish(() =>
              reject(new DocxLimitError("too_large", "The DOCX document body is too large.")),
            );
            return;
          }
          if (
            entry.uncompressedSize > DOCX_RATIO_CHECK_MIN_BYTES &&
            entry.uncompressedSize > Math.max(1, entry.compressedSize) * DOCX_MAX_COMPRESSION_RATIO
          ) {
            finish(() =>
              reject(
                new DocxLimitError(
                  "expanding",
                  "The DOCX document body expands far beyond its stored size.",
                ),
              ),
            );
            return;
          }
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) {
              finish(() => reject(new DocxLimitError("corrupt", "The DOCX body is unreadable.")));
              return;
            }
            const chunks: Array<Buffer> = [];
            let total = 0;
            stream.on("data", (chunk: Buffer) => {
              total += chunk.length;
              if (total > DOCX_MAX_DOCUMENT_XML_BYTES) {
                stream.destroy();
                finish(() =>
                  reject(new DocxLimitError("expanding", "The DOCX document body is too large.")),
                );
                return;
              }
              chunks.push(chunk);
            });
            stream.on("error", () =>
              finish(() => reject(new DocxLimitError("corrupt", "The DOCX body is damaged."))),
            );
            stream.on("end", () =>
              finish(() =>
                resolve({
                  documentXml: Buffer.concat(chunks),
                  containsMacros,
                }),
              ),
            );
          });
        });
        zip.readEntry();
      },
    );
  });
}

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const UTF16LE_DECODER = new TextDecoder("utf-16le", { fatal: true, ignoreBOM: true });
const UTF16BE_DECODER = new TextDecoder("utf-16be", { fatal: true, ignoreBOM: true });

function hasPrefix(bytes: Uint8Array, prefix: ReadonlyArray<number>): boolean {
  return bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value);
}

/**
 * Decodes the document body as UTF-8 or UTF-16, the encodings XML processors must support,
 * detected from the byte order mark or the leading `<?` as XML 1.0 Appendix F describes. A
 * declared encoding must agree with the detected one, and malformed sequences are refused, so
 * other encodings fail clearly instead of decoding into plausible but wrong text.
 */
function decodeWordprocessingXml(bytes: Uint8Array): string {
  const unsupported = () =>
    new DocxLimitError("corrupt", "The DOCX body uses an unsupported or invalid text encoding.");
  if (hasPrefix(bytes, [0xff, 0xfe, 0x00, 0x00]) || hasPrefix(bytes, [0x00, 0x00, 0xfe, 0xff])) {
    throw unsupported();
  }
  if (hasPrefix(bytes, [0x3c, 0x00, 0x00, 0x00]) || hasPrefix(bytes, [0x00, 0x00, 0x00, 0x3c])) {
    throw unsupported();
  }
  let family: "utf-8" | "utf-16le" | "utf-16be" = "utf-8";
  let bodyStart = 0;
  if (hasPrefix(bytes, [0xef, 0xbb, 0xbf])) {
    bodyStart = 3;
  } else if (hasPrefix(bytes, [0xff, 0xfe])) {
    family = "utf-16le";
    bodyStart = 2;
  } else if (hasPrefix(bytes, [0xfe, 0xff])) {
    family = "utf-16be";
    bodyStart = 2;
  } else if (hasPrefix(bytes, [0x3c, 0x00, 0x3f, 0x00])) {
    family = "utf-16le";
  } else if (hasPrefix(bytes, [0x00, 0x3c, 0x00, 0x3f])) {
    family = "utf-16be";
  }
  const decoder =
    family === "utf-8" ? UTF8_DECODER : family === "utf-16le" ? UTF16LE_DECODER : UTF16BE_DECODER;
  let xml: string;
  try {
    xml = decoder.decode(bytes.subarray(bodyStart));
  } catch {
    throw unsupported();
  }
  const declared = /^<\?xml\s[^>]*?\bencoding\s*=\s*["']([A-Za-z0-9._-]{1,40})["']/u
    .exec(xml)?.[1]
    ?.toLowerCase();
  const accepted =
    declared === undefined
      ? family === "utf-8" || bodyStart > 0
      : family === "utf-8"
        ? declared === "utf-8" || declared === "utf8"
        : declared === "utf-16" || declared === family;
  if (!accepted) throw unsupported();
  return xml;
}

const XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeXmlText(value: string): string {
  return value.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]+);/giu, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const codePoint =
        entity[1] === "x" || entity[1] === "X"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    }
    return XML_ENTITIES[entity] ?? match;
  });
}

const WORDPROCESSINGML_NAMESPACES: ReadonlySet<string> = new Set([
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
]);
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";

function isAllowedNamespaceBinding(prefix: string, value: string): boolean {
  if (prefix === "xmlns" || value === XML_NAMESPACE || value === XMLNS_NAMESPACE) return false;
  return prefix.length === 0 || value.length > 0;
}
const XML_NAME = /[^\s/>=<"'!?]+/uy;
const XML_ATTRIBUTE = /\s+([^\s/>=<"']+)\s*=\s*("[^"<]*"|'[^'<]*')/uy;
const XML_TAG_END = /\s*(\/?)>/uy;
const XML_END_TAG = /([^\s/>=<"'!?]+)\s*>/uy;

interface XmlElement {
  readonly qualifiedName: string;
  readonly word: string | undefined;
  readonly declaredPrefixes: ReadonlyArray<string>;
}

/** In-scope namespace bindings, one stack per prefix, so lookups and scope exits stay cheap. */
class NamespaceScope {
  readonly #bindings = new Map<string, Array<string>>();

  get(prefix: string): string | undefined {
    return this.#bindings.get(prefix)?.at(-1);
  }

  bind(prefix: string, namespace: string): void {
    const stack = this.#bindings.get(prefix);
    if (stack) stack.push(namespace);
    else this.#bindings.set(prefix, [namespace]);
  }

  release(prefixes: ReadonlyArray<string>): void {
    for (const prefix of prefixes) this.#bindings.get(prefix)?.pop();
  }
}

function malformed(): DocxLimitError {
  return new DocxLimitError("corrupt", "The DOCX body is not well-formed XML.");
}

function indexOrThrow(xml: string, token: string, from: number): number {
  const index = xml.indexOf(token, from);
  if (index < 0) throw malformed();
  return index;
}

function matchAt(pattern: RegExp, xml: string, at: number): RegExpExecArray | null {
  pattern.lastIndex = at;
  return pattern.exec(xml);
}

/** The namespace a qualified name resolves to in `scope`; unbound prefixes are malformed. */
function resolveNamespace(
  qualifiedName: string,
  scope: NamespaceScope,
  isAttribute: boolean,
): string | undefined {
  const parts = qualifiedName.split(":");
  if (parts.length > 2 || parts.some((part) => part.length === 0)) throw malformed();
  if (parts.length === 1) return isAttribute ? undefined : scope.get("") || undefined;
  const prefix = parts[0]!;
  if (prefix === "xml") return XML_NAMESPACE;
  const namespace = scope.get(prefix);
  if (!namespace) throw malformed();
  return namespace;
}

/**
 * Reads the visible text runs of WordprocessingML with a single linear scan. Elements count as
 * WordprocessingML by their resolved namespace (transitional or strict), whatever prefix binds
 * it. Comments, processing instructions, and attribute values are skipped whole, CDATA is
 * literal text, and markup that is not well-formed is refused rather than read as plausible
 * text. A tab counts as text only inside a run; a paragraph's tab-stop definitions do not. Only the five predefined entities and numeric character references are decoded; a
 * document type declaration is refused, so entity expansion cannot multiply the output. The scan
 * stops once the character limit is reached, so the rest of a truncated body is not checked.
 */
function wordprocessingText(xml: string, maxCharacters: number) {
  const text = new BoundedText(maxCharacters);
  const stack: Array<XmlElement> = [];
  const scope = new NamespaceScope();
  let sawRoot = false;
  const inTextRun = () => stack.at(-1)?.word === "t";
  let position = 0;
  while (position < xml.length && !text.truncated) {
    const open = xml.indexOf("<", position);
    const textEnd = open < 0 ? xml.length : open;
    if (textEnd > position) {
      const characters = xml.slice(position, textEnd);
      if (stack.length === 0) {
        if (/\S/u.test(characters)) throw malformed();
      } else if (inTextRun()) {
        text.push(decodeXmlText(characters));
      }
      position = textEnd;
      continue;
    }
    if (xml.startsWith("<!--", position)) {
      position = indexOrThrow(xml, "-->", position + 4) + 3;
      continue;
    }
    if (xml.startsWith("<?", position)) {
      position = indexOrThrow(xml, "?>", position + 2) + 2;
      continue;
    }
    if (xml.startsWith("<![CDATA[", position)) {
      if (stack.length === 0) throw malformed();
      const close = indexOrThrow(xml, "]]>", position + 9);
      if (inTextRun()) text.push(xml.slice(position + 9, close));
      position = close + 3;
      continue;
    }
    if (xml.startsWith("<!", position)) {
      throw new DocxLimitError("corrupt", "The DOCX body declares a document type.");
    }
    if (xml.startsWith("</", position)) {
      const end = matchAt(XML_END_TAG, xml, position + 2);
      const element = stack.pop();
      if (!end || !element || end[1] !== element.qualifiedName) throw malformed();
      scope.release(element.declaredPrefixes);
      if (element.word === "p") text.push("\n");
      position = XML_END_TAG.lastIndex;
      continue;
    }
    const name = matchAt(XML_NAME, xml, position + 1);
    if (!name) throw malformed();
    position = XML_NAME.lastIndex;
    const attributes: Array<string> = [];
    const declaredPrefixes: Array<string> = [];
    for (;;) {
      const attribute = matchAt(XML_ATTRIBUTE, xml, position);
      if (!attribute) break;
      position = XML_ATTRIBUTE.lastIndex;
      const attributeName = attribute[1]!;
      const value = decodeXmlText(attribute[2]!.slice(1, -1));
      if (attributeName === "xmlns" || attributeName.startsWith("xmlns:")) {
        const prefix = attributeName === "xmlns" ? "" : attributeName.slice(6);
        if (
          prefix === "xml" ? value !== XML_NAMESPACE : !isAllowedNamespaceBinding(prefix, value)
        ) {
          throw malformed();
        }
        if (declaredPrefixes.includes(prefix)) throw malformed();
        declaredPrefixes.push(prefix);
        scope.bind(prefix, value);
      } else {
        attributes.push(attributeName);
      }
    }
    const tagEnd = matchAt(XML_TAG_END, xml, position);
    if (!tagEnd) throw malformed();
    position = XML_TAG_END.lastIndex;
    for (const attributeName of attributes) resolveNamespace(attributeName, scope, true);
    if (stack.length === 0) {
      if (sawRoot) throw malformed();
      sawRoot = true;
    }
    const qualifiedName = name[0];
    const namespace = resolveNamespace(qualifiedName, scope, false);
    const word =
      namespace !== undefined && WORDPROCESSINGML_NAMESPACES.has(namespace)
        ? qualifiedName.slice(qualifiedName.indexOf(":") + 1)
        : undefined;
    if (word === "tab" && stack.at(-1)?.word === "r") text.push("\t");
    if (word === "br" || word === "cr") text.push("\n");
    if (tagEnd[1] === "/") scope.release(declaredPrefixes);
    else stack.push({ qualifiedName, word, declaredPrefixes });
  }
  if (!text.truncated && (stack.length > 0 || !sawRoot)) throw malformed();
  return { text: text.toString(), truncated: text.truncated };
}

async function extractDocx(bytes: Uint8Array, maxCharacters: number): Promise<DocumentTextResult> {
  if (!startsWith(bytes, "PK\u0003\u0004")) {
    return failed("docx", "corrupt", "The file is not a Word (DOCX) document.");
  }
  try {
    const parts = await readDocxParts(bytes);
    const { text, truncated } = wordprocessingText(
      decodeWordprocessingXml(parts.documentXml),
      maxCharacters,
    );
    if (text.length === 0) {
      return failed("docx", "no_text", "The Word document has no text in its body.");
    }
    return {
      status: "extracted",
      format: "docx",
      text,
      truncated,
      containsMacros: parts.containsMacros,
    };
  } catch (error) {
    if (error instanceof DocxLimitError) return failed("docx", error.reason, error.message);
    return failed("docx", "corrupt", "The Word document could not be read; it may be damaged.");
  }
}

function startsWith(bytes: Uint8Array, signature: string): boolean {
  if (bytes.length < signature.length) return false;
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature.charCodeAt(index)) return false;
  }
  return true;
}

/** Extracts text in the current process. Call it only from the isolated extraction process. */
export async function extractDocumentTextInProcess(input: {
  readonly format: DocumentTextFormat;
  readonly bytes: Uint8Array;
  readonly maxCharacters?: number;
}): Promise<DocumentTextResult> {
  const maxCharacters = Math.max(
    1,
    Math.min(input.maxCharacters ?? DOCUMENT_TEXT_MAX_CHARACTERS, DOCUMENT_TEXT_MAX_CHARACTERS),
  );
  if (input.bytes.byteLength > DOCUMENT_TEXT_MAX_INPUT_BYTES) {
    return failed(input.format, "too_large", "The document is too large to extract.");
  }
  return input.format === "pdf"
    ? extractPdf(input.bytes, maxCharacters)
    : extractDocx(input.bytes, maxCharacters);
}
