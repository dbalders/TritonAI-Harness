import * as NodeCrypto from "node:crypto";

const LEGACY_FINGERPRINT_DOMAIN = Buffer.from("T3SECRET-LEGACY\0", "utf8");
const SERVER_SECRET_ENVELOPE_VERSION = 1;
const SERVER_SECRET_NONCE_BYTES = 12;
const SERVER_SECRET_AUTH_TAG_BYTES = 16;

export const SERVER_SECRET_ENVELOPE_MAGIC = Uint8Array.from(new TextEncoder().encode("T3SECRET"));

const SERVER_SECRET_ENVELOPE_HEADER_BYTES =
  SERVER_SECRET_ENVELOPE_MAGIC.byteLength +
  1 +
  SERVER_SECRET_NONCE_BYTES +
  SERVER_SECRET_AUTH_TAG_BYTES;

export const hasServerSecretEnvelopeMagic = (bytes: Uint8Array): boolean =>
  bytes.byteLength >= SERVER_SECRET_ENVELOPE_MAGIC.byteLength &&
  SERVER_SECRET_ENVELOPE_MAGIC.every((byte, index) => bytes[index] === byte);

export interface DecodedServerSecretEnvelope {
  readonly value: Uint8Array;
  readonly keyIndex: number;
}

export const encodeServerSecretEnvelope = (
  name: string,
  value: Uint8Array,
  key: Uint8Array,
): Uint8Array => {
  const nonce = NodeCrypto.randomBytes(SERVER_SECRET_NONCE_BYTES);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(name, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  return Uint8Array.from(
    Buffer.concat([
      SERVER_SECRET_ENVELOPE_MAGIC,
      Buffer.from([SERVER_SECRET_ENVELOPE_VERSION]),
      nonce,
      cipher.getAuthTag(),
      ciphertext,
    ]),
  );
};

export const decodeServerSecretEnvelope = (
  name: string,
  envelope: Uint8Array,
  keys: ReadonlyArray<Uint8Array>,
): DecodedServerSecretEnvelope => {
  if (!hasServerSecretEnvelopeMagic(envelope)) {
    throw new Error("The secret is not an encrypted envelope.");
  }
  if (envelope.byteLength < SERVER_SECRET_ENVELOPE_HEADER_BYTES) {
    throw new Error("The encrypted secret envelope is truncated.");
  }
  if (envelope[SERVER_SECRET_ENVELOPE_MAGIC.byteLength] !== SERVER_SECRET_ENVELOPE_VERSION) {
    throw new Error("The encrypted secret envelope version is unsupported.");
  }

  const nonceStart = SERVER_SECRET_ENVELOPE_MAGIC.byteLength + 1;
  const tagStart = nonceStart + SERVER_SECRET_NONCE_BYTES;
  const ciphertextStart = tagStart + SERVER_SECRET_AUTH_TAG_BYTES;
  const nonce = Buffer.from(envelope.subarray(nonceStart, tagStart));
  const authenticationTag = Buffer.from(envelope.subarray(tagStart, ciphertextStart));
  const ciphertext = Buffer.from(envelope.subarray(ciphertextStart));

  for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
    try {
      const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", keys[keyIndex]!, nonce);
      decipher.setAAD(Buffer.from(name, "utf8"));
      decipher.setAuthTag(authenticationTag);
      return {
        value: Uint8Array.from(Buffer.concat([decipher.update(ciphertext), decipher.final()])),
        keyIndex,
      };
    } catch {
      // Try rotation fallbacks. Callers receive one generic authentication
      // error if none of the configured keys can open the envelope.
    }
  }
  throw new Error("The encrypted secret envelope could not be authenticated.");
};

/**
 * Authenticates the exact bytes that existed before encrypted storage was
 * enabled. The data key keeps the fingerprint from becoming a token oracle.
 */
export const fingerprintLegacyServerSecret = (
  name: string,
  value: Uint8Array,
  key: Uint8Array,
): Uint8Array => {
  const hmac = NodeCrypto.createHmac("sha256", key);
  hmac.update(LEGACY_FINGERPRINT_DOMAIN);
  hmac.update(name, "utf8");
  hmac.update(Uint8Array.of(0));
  hmac.update(value);
  return Uint8Array.from(hmac.digest());
};
