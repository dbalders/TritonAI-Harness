"use strict";
const { createHash } = require("node:crypto");
const { openSync, readSync, closeSync } = require("node:fs");
// Release artifacts can exceed Buffer's size limit. Keep verification memory independent of size.
function fileDigest(file, algorithm, encoding) {
  const hash = createHash(algorithm);
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(file, "r");
  try {
    let length;
    while ((length = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, length));
    }
    return hash.digest(encoding);
  } finally {
    closeSync(descriptor);
  }
}

module.exports = { fileDigest };
