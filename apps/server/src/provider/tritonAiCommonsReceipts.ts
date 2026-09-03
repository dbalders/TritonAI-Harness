import {
  ServerTritonAiCommonsSubmissionReceipt,
  type ServerSubmitProviderSkillToTritonAiCommonsResult,
  type ServerTritonAiCommonsSubmissionReceipt as TritonAiCommonsSubmissionReceipt,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../atomicWrite.ts";

const MAX_RECEIPTS = 200;
const STORE_FILE_NAME = "tritonai-commons-submissions.json";

const TritonAiCommonsReceiptStore = Schema.Struct({
  version: Schema.Literal(1),
  submissions: Schema.Array(ServerTritonAiCommonsSubmissionReceipt),
});

const decodeStore = Schema.decodeUnknownEffect(Schema.fromJsonString(TritonAiCommonsReceiptStore));
const encodeStore = Schema.encodeEffect(Schema.fromJsonString(TritonAiCommonsReceiptStore));
const receiptWriteSemaphore = Semaphore.makeUnsafe(1);

export const listTritonAiCommonsSubmissionReceipts = Effect.fn(
  "listTritonAiCommonsSubmissionReceipts",
)(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.join(stateDir, STORE_FILE_NAME);
  if (!(yield* fs.exists(target))) return [];
  const raw = yield* fs.readFileString(target);
  return (yield* decodeStore(raw)).submissions;
});

const recordTritonAiCommonsSubmissionReceiptUnlocked = Effect.fn(
  "recordTritonAiCommonsSubmissionReceipt",
)(function* (input: {
  readonly stateDir: string;
  readonly skillPath: string;
  readonly result: ServerSubmitProviderSkillToTritonAiCommonsResult;
  readonly submittedAt?: string;
}) {
  const submittedAt = input.submittedAt ?? DateTime.formatIso(yield* DateTime.now);
  const receipt: TritonAiCommonsSubmissionReceipt = {
    ...input.result,
    skillPath: input.skillPath,
    submittedAt,
  };
  const current = yield* listTritonAiCommonsSubmissionReceipts(input.stateDir);
  const submissions = [
    receipt,
    ...current.filter((candidate) => candidate.skillPath !== receipt.skillPath),
  ].slice(0, MAX_RECEIPTS);
  const path = yield* Path.Path;
  const contents = yield* encodeStore({ version: 1, submissions });
  yield* writeFileStringAtomically({
    filePath: path.join(input.stateDir, STORE_FILE_NAME),
    contents: `${contents}\n`,
    mode: 0o600,
  });
  return receipt;
});

export const recordTritonAiCommonsSubmissionReceipt = Effect.fn(
  "recordTritonAiCommonsSubmissionReceiptSerialized",
)((input: Parameters<typeof recordTritonAiCommonsSubmissionReceiptUnlocked>[0]) =>
  receiptWriteSemaphore.withPermits(1)(recordTritonAiCommonsSubmissionReceiptUnlocked(input)),
);
