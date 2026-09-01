const FLOW_ID = "synthetic-api-key";
const CAPABILITIES = ["synthetic-api-key.read", "synthetic-api-key.write"];
const CONNECTION_SECRET = "connection";
const API_KEY_SUBMISSION_KEYS = new Set(["kind", "flowId", "value"]);

function failure(code, message) {
  return Object.freeze({
    _tag: "PluginFailure",
    code,
    message,
    retryable: false,
  });
}

function assertPlainInput(value, allowed) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw failure("invalid_input", "Input must be a plain object with only declared fields.");
  }
}

export function createIntegrationProvider({ secrets }) {
  const items = new Map();
  const connection = async () => {
    const encoded = await secrets.get(CONNECTION_SECRET);
    if (!encoded) return null;
    let value;
    try {
      value = JSON.parse(encoded);
    } catch {
      throw failure("invalid_connection", "The stored synthetic connection is invalid.");
    }
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => !new Set(["apiKey", "capabilities"]).has(key)) ||
      typeof value.apiKey !== "string" ||
      value.apiKey.length < 1 ||
      value.apiKey.length > 256 ||
      !Array.isArray(value.capabilities) ||
      value.capabilities.length < 1 ||
      value.capabilities.some((capability) => !CAPABILITIES.includes(capability)) ||
      new Set(value.capabilities).size !== value.capabilities.length
    ) {
      throw failure("invalid_connection", "The stored synthetic connection is invalid.");
    }
    return value;
  };
  const requireCapability = async (capability) => {
    const connected = await connection();
    if (!connected) {
      throw failure("not_connected", "Connect an API key before using this plugin.");
    }
    if (!connected.capabilities.includes(capability)) {
      throw failure("capability_not_granted", "The connection did not grant this capability.");
    }
  };

  return {
    id: "synthetic-api-key",
    async status({ signal }) {
      signal.throwIfAborted();
      const connected = await connection();
      return {
        state: connected ? "connected" : "not_connected",
        accountLabel: connected ? "synthetic API key" : null,
        grantedCapabilities: connected ? connected.capabilities : [],
        message: null,
      };
    },
    async connect(capabilities, context, submission) {
      context.signal.throwIfAborted();
      if (
        capabilities.length < 1 ||
        new Set(capabilities).size !== capabilities.length ||
        capabilities.some((capability) => !CAPABILITIES.includes(capability))
      ) {
        throw failure("invalid_capability", "Connection requested an unsupported capability.");
      }
      if (submission === undefined) {
        return {
          kind: "api_key",
          flowId: FLOW_ID,
          label: "Synthetic API key",
          placeholder: "synthetic_test_key",
          message: "Enter any non-empty synthetic API key.",
        };
      }
      if (
        submission === null ||
        typeof submission !== "object" ||
        Array.isArray(submission) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(submission)) ||
        Object.keys(submission).some((key) => !API_KEY_SUBMISSION_KEYS.has(key)) ||
        submission.kind !== "api_key" ||
        submission.flowId !== FLOW_ID ||
        typeof submission.value !== "string" ||
        submission.value.length < 1 ||
        submission.value.length > 256
      ) {
        throw failure("invalid_api_key", "The synthetic API key submission is invalid.");
      }
      const commitSignal = await context.beginCommit();
      commitSignal.throwIfAborted();
      await secrets.set(
        CONNECTION_SECRET,
        JSON.stringify({ apiKey: submission.value, capabilities: [...capabilities].sort() }),
      );
      return { kind: "connected", flowId: FLOW_ID, message: "Synthetic API key connected." };
    },
    async disconnect(context) {
      const commitSignal = await context.beginCommit();
      commitSignal.throwIfAborted();
      await secrets.remove(CONNECTION_SECRET);
      items.clear();
    },
    async invoke(toolName, input, context) {
      context.signal.throwIfAborted();
      if (toolName === "synthetic.items.list") {
        await requireCapability("synthetic-api-key.read");
        assertPlainInput(input, new Set());
        return {
          items: [...items.entries()].map(([id, value]) => ({ id, value })),
        };
      }
      if (toolName !== "synthetic.items.put") {
        throw failure("tool_not_found", "The requested tool is not provided by this plugin.");
      }
      await requireCapability("synthetic-api-key.write");
      assertPlainInput(input, new Set(["id", "value"]));
      if (
        typeof input.id !== "string" ||
        input.id.length < 1 ||
        input.id.length > 32 ||
        typeof input.value !== "string" ||
        input.value.length > 128
      ) {
        throw failure("invalid_input", "id or value is outside its declared bounds.");
      }
      if (!context.writeApproved) {
        throw failure("write_not_approved", "The host did not approve this write.");
      }
      const commitSignal = await context.beginCommit();
      commitSignal.throwIfAborted();
      items.set(input.id, input.value);
      return { id: input.id, value: input.value };
    },
  };
}
