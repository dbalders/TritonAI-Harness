import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Multipart from "effect/unstable/http/Multipart";

import { EnvironmentOrchestrationAttachmentUpload } from "./environmentHttp.ts";

const decodeAttachmentUpload = Schema.decodeUnknownSync(EnvironmentOrchestrationAttachmentUpload);

it("decodes the named file field produced by the multipart parser", () => {
  const persistedFile = {
    [Multipart.TypeId]: Multipart.TypeId,
    _tag: "PersistedFile",
    key: "file",
    name: "sales.csv",
    contentType: "text/csv",
    path: "/tmp/sales.csv",
  } as Multipart.PersistedFile;

  const decoded = decodeAttachmentUpload({
    uploadId: "00000000-0000-4000-8000-000000000005",
    file: [persistedFile],
  });

  assert.strictEqual(decoded.uploadId, "00000000-0000-4000-8000-000000000005");
  assert.strictEqual(decoded.file, persistedFile);
});
