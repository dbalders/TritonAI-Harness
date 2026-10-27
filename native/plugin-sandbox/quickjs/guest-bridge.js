(() => {
  "use strict";
  const parse = JSON.parse;
  const encode = JSON.stringify;
  const freeze = Object.freeze;
  const define = Object.defineProperty;
  const resolve = Promise.resolve.bind(Promise);
  const PromiseType = Promise;
  const ErrorType = Error;
  const states = new WeakMap();
  class GuestAbortSignal {
    constructor() {
      states.set(this, false);
      freeze(this);
    }
    get aborted() {
      return states.get(this);
    }
    throwIfAborted() {
      if (states.get(this)) throw new ErrorType("Operation cancelled");
    }
  }
  class GuestAbortController {
    constructor() {
      define(this, "signal", { value: new GuestAbortSignal() });
    }
    abort() {
      states.set(this.signal, true);
    }
  }
  class GuestTextEncoder {
    encode(value = "") {
      const text = String(value);
      const output = new Uint8Array(text.length * 3);
      let length = 0;
      for (let index = 0; index < text.length; index++) {
        let cp = text.codePointAt(index);
        if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
        if (cp > 0xffff) index++;
        if (cp < 128) output[length++] = cp;
        else if (cp < 2048) {
          output[length++] = 192 | (cp >> 6);
          output[length++] = 128 | (cp & 63);
        } else if (cp < 65536) {
          output[length++] = 224 | (cp >> 12);
          output[length++] = 128 | ((cp >> 6) & 63);
          output[length++] = 128 | (cp & 63);
        } else {
          output[length++] = 240 | (cp >> 18);
          output[length++] = 128 | ((cp >> 12) & 63);
          output[length++] = 128 | ((cp >> 6) & 63);
          output[length++] = 128 | (cp & 63);
        }
      }
      return output.slice(0, length);
    }
  }
  for (const [name, value] of [
    ["AbortSignal", GuestAbortSignal],
    ["AbortController", GuestAbortController],
    ["TextEncoder", GuestTextEncoder],
  ]) {
    freeze(value.prototype);
    freeze(value);
    define(globalThis, name, { value, writable: false, configurable: false });
  }
  let state = "initial",
    provider,
    mailbox = null,
    pending = null,
    sent = 0;
  const controller = new GuestAbortController();
  const failure = () => {
    if (state !== "cancelled") {
      state = "failed";
      mailbox = encode({ kind: "error", code: "worker_failed" });
    }
  };
  const broker = freeze({
    request(operationId, parameters) {
      if (state !== "running" || pending || sent)
        return PromiseType.reject(new ErrorType("Operation unavailable"));
      sent++;
      return new PromiseType((yes, no) => {
        pending = { yes, no };
        mailbox = encode({
          protocol: "tritonai.plugin-broker/v1",
          requestId: 1,
          kind: "operation",
          operationId,
          parameters,
        });
      });
    },
  });
  return freeze({
    initialize(factory, json) {
      if (state !== "initial" || typeof factory !== "function")
        throw new ErrorType("Invalid factory");
      state = "initializing";
      resolve(factory({ configuration: parse(json), broker })).then((value) => {
        if (!value || typeof value.invoke !== "function") return failure();
        provider = value;
        state = "ready";
        mailbox = encode({ kind: "ready", id: value.id });
      }, failure);
    },
    invoke(json) {
      if (state !== "ready" || mailbox !== null) throw new ErrorType("Invalid invocation");
      const input = parse(json);
      state = "running";
      resolve(provider.invoke(input.toolName, input.input, { signal: controller.signal })).then(
        (value) => {
          if (state === "cancelled") return;
          if (pending) return failure();
          state = "finished";
          mailbox = encode({ kind: "result", value });
        },
        failure,
      );
    },
    deliver(json) {
      if (state !== "running" || !pending) throw new ErrorType("Unexpected response");
      const reply = parse(json);
      if (reply.protocol !== "tritonai.plugin-broker/v1" || reply.requestId !== 1)
        throw new ErrorType("Invalid response");
      const callback = pending;
      pending = null;
      if (reply.kind === "result") callback.yes(reply.value);
      else if (reply.kind === "error") callback.no(new ErrorType("Host operation failed"));
      else throw new ErrorType("Invalid response");
    },
    poll() {
      const result = mailbox;
      mailbox = null;
      return result;
    },
    cancel() {
      state = "cancelled";
      controller.abort();
      if (pending) pending.no(new ErrorType("Cancelled"));
      pending = null;
      mailbox = null;
    },
  });
})();
