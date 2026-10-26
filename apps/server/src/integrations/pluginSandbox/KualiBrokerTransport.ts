// @effect-diagnostics nodeBuiltinImport:off -- The broker pins DNS results and TLS identity without ambient proxy or redirect behavior.
import * as NodeDnsPromises from "node:dns/promises";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";
import { isPublicFaviconHost } from "@t3tools/shared/hostClassification";
import { isRecord, validateJsonValue } from "@t3tools/shared/pluginSdkContract";
import { IntegrationProviderPublicError } from "../IntegrationRegistry.ts";
import type { KualiBrokerTransport } from "./ReviewedPluginBroker.ts";

const HOST = "ucsd.kualibuild.com";

export const kualiBrokerTransport: KualiBrokerTransport = async (input) => {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]);
  signal.throwIfAborted();
  if (
    !input.credential.length ||
    input.credential.length > 8_192 ||
    [...input.credential].some(
      (character) =>
        /\s/u.test(character) ||
        character.codePointAt(0)! <= 31 ||
        character.codePointAt(0) === 127,
    )
  ) {
    throw new Error("The Kuali credential format is invalid.");
  }
  const body = Buffer.from(JSON.stringify({ query: input.document, variables: input.variables }));
  if (body.length > 65_536) throw new Error("The Kuali request exceeds its byte limit.");
  return new Promise((resolve, reject) => {
    let request: ReturnType<typeof NodeHttps.request> | undefined;
    const abort = () => {
      request?.destroy(new Error("The Kuali request was cancelled or timed out."));
      reject(new Error("The Kuali request was cancelled or timed out."));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const finish = () => signal.removeEventListener("abort", abort);
    // Only IPv4 is admitted in this first broker transport. Unavailable IPv4 fails closed.
    void NodeDnsPromises.lookup(HOST, { all: true, family: 4, verbatim: true })
      .then((addresses) => {
        if (signal.aborted) return;
        if (
          !addresses.length ||
          addresses.length > 16 ||
          addresses.some(
            ({ address }) => NodeNet.isIP(address) !== 4 || !isPublicFaviconHost(address),
          )
        ) {
          throw new Error("The Kuali destination did not resolve to a public address.");
        }
        request = NodeHttps.request(
          {
            hostname: HOST,
            servername: HOST,
            port: 443,
            method: "POST",
            path: "/app/api/v0/graphql",
            agent: false,
            rejectUnauthorized: true,
            signal,
            lookup: (_host, options, callback) =>
              options.all ? callback(null, addresses) : callback(null, addresses[0]!.address, 4),
            headers: {
              authorization: `Bearer ${input.credential}`,
              "content-type": "application/json",
              accept: "application/json",
              "content-length": body.length,
              "accept-encoding": "identity",
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            let total = 0;
            response.on("error", reject);
            response.on("aborted", () => reject(new Error("The Kuali response was interrupted.")));
            response.on("data", (chunk: Buffer) => {
              total += chunk.length;
              if (total > 524_288)
                response.destroy(new Error("The Kuali response exceeds its byte limit."));
              else chunks.push(chunk);
            });
            response.on("end", () => {
              try {
                if (response.statusCode === 401 || response.statusCode === 403) {
                  throw new IntegrationProviderPublicError(
                    "Kuali refused this credential or operation.",
                    { unchanged: true },
                  );
                }
                if (
                  response.statusCode !== 200 ||
                  !/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/iu.test(
                    response.headers["content-type"] ?? "",
                  ) ||
                  (response.headers["content-encoding"] &&
                    response.headers["content-encoding"] !== "identity")
                )
                  throw new Error("The Kuali response was not usable.");
                const value = validateJsonValue(
                  JSON.parse(
                    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
                  ),
                  "Kuali response",
                );
                if (
                  !isRecord(value) ||
                  (value.errors !== undefined &&
                    (!Array.isArray(value.errors) || value.errors.length > 0)) ||
                  !isRecord(value.data)
                )
                  throw new Error("Kuali did not return an unambiguous data response.");
                resolve(value.data);
              } catch (cause) {
                reject(cause);
              }
            });
          },
        );
        request.on("error", reject);
        request.on("close", finish);
        request.end(body);
      })
      .catch((cause: unknown) => {
        finish();
        reject(cause);
      });
  });
};
