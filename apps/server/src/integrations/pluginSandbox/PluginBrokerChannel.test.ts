import { expect, it } from "vite-plus/test";
import type { JsonObject } from "@t3tools/shared/pluginSdkContract";
import { PluginBrokerChannel, type PluginBrokerBinding } from "./PluginBrokerChannel.ts";
import { PLUGIN_BROKER_PROTOCOL } from "./PluginBrokerProtocol.ts";

function fixture(effect: "read" | "write" = "write") {
  const binding: PluginBrokerBinding = {
    pluginId: "synthetic-api-key",
    connectionId: "owned-connection",
    connectionGeneration: 2,
    credentialGeneration: 4,
    workerGeneration: 3,
    artifactSha256: "a".repeat(64),
    descriptorSha256: "b".repeat(64),
    policySha256: "c".repeat(64),
    policyId: "synthetic.v1",
    policyVersion: 1,
  };
  const requests: { parameters: JsonObject; binding: PluginBrokerBinding; signal: AbortSignal }[] =
    [];
  const controller = new AbortController();
  const state = {
    current: true,
    terminated: 0,
    admitted: 0,
    failTransport: false,
    admission: Promise.resolve(),
    transport: Promise.resolve(),
  };
  const channel = new PluginBrokerChannel({
    binding,
    reviewedPolicySha256: binding.policySha256,
    operations: [
      {
        id: "synthetic.items.put.v1",
        toolName: "synthetic.items.put",
        effect,
        validate: (input) => {
          if (typeof input.destination !== "string" || typeof input.content !== "string") {
            throw new Error("Synthetic host schema rejected input.");
          }
        },
      },
    ],
    isCurrent: () => state.current,
    execute: async ({ parameters, binding: admittedBinding, signal }) => {
      requests.push({ parameters, binding: admittedBinding, signal });
      await state.transport;
      if (state.failTransport) throw new Error("Synthetic transport outcome unknown.");
      return { changed: true };
    },
    terminate: () => {
      state.terminated++;
    },
  });
  const begin = (input: unknown = { destination: "owned-record", content: "reviewed" }) => {
    channel.beginInvocation("synthetic.items.put", input, {
      signal: controller.signal,
      beginCommit: async () => {
        state.admitted++;
        await state.admission;
        return controller.signal;
      },
    });
  };
  const request = (
    parameters: JsonObject = { destination: "owned-record", content: "reviewed" },
    requestId = 1,
  ) => ({
    protocol: PLUGIN_BROKER_PROTOCOL,
    requestId,
    kind: "operation",
    operationId: "synthetic.items.put.v1",
    parameters,
  });
  return { channel, state, binding, requests, controller, begin, request };
}

it("executes the host snapshot only after commit admission and pins the host channel identity", async () => {
  const f = fixture();
  const input = { destination: "owned-record", content: "reviewed" };
  f.begin(input);
  input.content = "changed after admission";
  expect(await f.channel.operation(f.request())).toEqual({ changed: true });
  expect(f.state.admitted).toBe(1);
  expect(f.requests[0]?.parameters).toEqual({ destination: "owned-record", content: "reviewed" });
  expect(Object.isFrozen(f.requests[0]?.parameters)).toBe(true);
  expect(f.requests[0]?.binding).toEqual(f.binding);
  expect(await f.channel.completeInvocation({ projected: "synthetic result" })).toEqual({
    projected: "synthetic result",
  });
});

it("denies destination, payload, tool and worker-selected connection substitution", async () => {
  for (const mutation of [
    { parameters: { destination: "other-record", content: "reviewed" } },
    { parameters: { destination: "owned-record", content: "hidden changed tail" } },
    { operationId: "synthetic.other.put.v1" },
    { connectionId: "other-connection" },
  ]) {
    const f = fixture();
    f.begin();
    await expect(f.channel.operation({ ...f.request(), ...mutation })).rejects.toThrow();
    expect(f.requests).toEqual([]);
    expect(f.state.admitted).toBe(0);
    expect(f.state.terminated).toBe(1);
  }
});

it("compares the same F05 canonical bytes for nested numeric object keys", async () => {
  const f = fixture();
  const input = {
    destination: "owned-record",
    content: "reviewed",
    data: { "2": "two", "10": "ten", nested: { "12": "twelve", "3": "three" } },
  };
  f.begin(input);
  await expect(f.channel.operation(f.request(JSON.parse(JSON.stringify(input))))).resolves.toEqual({
    changed: true,
  });
  await expect(f.channel.completeInvocation({ success: true })).resolves.toEqual({ success: true });
  expect(f.requests).toHaveLength(1);
});

it("cannot borrow a write operation during a read invocation", async () => {
  const f = fixture();
  f.channel.beginInvocation("synthetic.items.list", {}, { signal: f.controller.signal });
  await expect(f.channel.operation(f.request({}))).rejects.toThrow("admitted invocation");
  expect(f.requests).toEqual([]);
});

it("does not treat a caller boolean or an omitted commit callback as write authority", async () => {
  const f = fixture();
  f.channel.beginInvocation("synthetic.items.put", f.request().parameters, {
    signal: f.controller.signal,
    writeApproved: true,
  });
  await expect(f.channel.operation(f.request())).rejects.toThrow("write was not admitted");
  expect(f.requests).toEqual([]);
});

it("reserves the operation before awaiting commit so concurrent and replayed requests fail closed", async () => {
  const f = fixture();
  const admitted = Promise.withResolvers<void>();
  f.state.admission = admitted.promise;
  f.begin();
  const first = f.channel.operation(f.request());
  await expect(f.channel.operation(f.request(undefined, 2))).rejects.toThrow("admitted invocation");
  admitted.resolve();
  await expect(first).rejects.toThrow("no longer current");
  expect(f.requests).toEqual([]);
  expect(f.state.admitted).toBe(1);
});

it("rejects old request IDs after a new invocation starts", async () => {
  const f = fixture("read");
  f.begin();
  await f.channel.operation(f.request());
  await f.channel.completeInvocation({});
  f.begin();
  await expect(f.channel.operation(f.request())).rejects.toThrow("admitted invocation");
  expect(f.requests).toHaveLength(1);
});

it("checks host generations again after asynchronous write admission", async () => {
  const f = fixture();
  const admitted = Promise.withResolvers<void>();
  f.state.admission = admitted.promise;
  f.begin();
  const operation = f.channel.operation(f.request());
  f.state.current = false;
  admitted.resolve();
  await expect(operation).rejects.toThrow("no longer current");
  expect(f.requests).toEqual([]);
});

it("propagates revocation into an actual pending host transport signal", async () => {
  const f = fixture("read");
  const transport = Promise.withResolvers<void>();
  f.state.transport = transport.promise;
  f.begin();
  const operation = f.channel.operation(f.request());
  expect(f.requests[0]?.signal.aborted).toBe(false);
  f.channel.revoke();
  expect(f.requests[0]?.signal.aborted).toBe(true);
  transport.resolve();
  await expect(operation).rejects.toThrow("no longer current");
  await expect(f.channel.completeInvocation({ success: true })).rejects.toThrow(
    "no longer current",
  );
  expect(f.state.terminated).toBe(1);
});

it("does not let a worker's forged success erase the actual host transport failure", async () => {
  const f = fixture();
  f.state.failTransport = true;
  f.begin();
  await expect(f.channel.operation(f.request())).rejects.toThrow("outcome unknown");
  await expect(f.channel.completeInvocation({ success: true, unchanged: true })).rejects.toThrow(
    "outcome unknown",
  );
  expect(f.requests).toHaveLength(1);
});

it("does not release a worker result after cancellation without a committed host operation", async () => {
  const f = fixture("read");
  f.begin();
  f.controller.abort();
  await expect(f.channel.completeInvocation({ success: true })).rejects.toThrow();
  expect(f.requests).toEqual([]);
});
