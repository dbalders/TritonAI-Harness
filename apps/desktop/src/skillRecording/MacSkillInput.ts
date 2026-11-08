// Native macOS reads for the recorder child: which app is in front, mouse and
// modifier state, and the accessibility element under the pointer. Only the
// recorder's helper process loads this, so its process-wide AX timeout and
// background activation policy never touch the main app. Load it once, then
// make one reader per recorded app with `forApp`.
import type { SkillInputApi } from "./skillRecordingInput.ts";

const LIBRARIES = {
  cg: "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics",
  ax: "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices",
  cf: "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation",
  objc: "/usr/lib/libobjc.A.dylib",
  appKit: "/System/Library/Frameworks/AppKit.framework/AppKit",
} as const;
type Library = keyof typeof LIBRARIES;

const UTF8 = 0x08000100;
const AX_ERROR_NO_VALUE = -25212;
const AX_ERROR_ATTRIBUTE_UNSUPPORTED = -25205;
const NS_APPLICATION_ACTIVATION_POLICY_PROHIBITED = 2;
const TEXT_ROLES = /AX(?:SecureTextField|TextField|TextArea|SearchField|ComboBox)/;
const MAX_NAME_CHARS = 160;

function normalizedRole(role: string): string {
  return role
    .replace(/^AX/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

export async function loadMacSkillInput() {
  const { DataType: D, load, open } = await import("ffi-rs");
  for (const [name, path] of Object.entries(LIBRARIES)) {
    open({ library: `t3-skill-${name}`, path });
  }
  const call = <A>(
    library: Library,
    funcName: string,
    retType: unknown,
    paramsType: ReadonlyArray<unknown> = [],
    paramsValue: ReadonlyArray<unknown> = [],
  ): A =>
    load({
      library: `t3-skill-${library}`,
      funcName,
      retType: retType as never,
      paramsType: [...paramsType] as never,
      paramsValue: [...paramsValue],
    }) as A;

  const release = (pointer: bigint) => {
    if (pointer !== 0n) call<void>("cf", "CFRelease", D.Void, [D.BigInt], [pointer]);
  };
  const selectors = new Map<string, bigint>();
  const selector = (name: string) => {
    let value = selectors.get(name);
    if (value === undefined) {
      value = call<bigint>("objc", "sel_registerName", D.BigInt, [D.String], [name]);
      selectors.set(name, value);
    }
    return value;
  };
  const objcClass = (name: string) =>
    call<bigint>("objc", "objc_getClass", D.BigInt, [D.String], [name]);
  const send = <A>(
    target: bigint,
    name: string,
    retType: unknown = D.BigInt,
    types: ReadonlyArray<unknown> = [],
    values: ReadonlyArray<unknown> = [],
  ) =>
    call<A>(
      "objc",
      "objc_msgSend",
      retType,
      [D.BigInt, D.BigInt, ...types],
      [target, selector(name), ...values],
    );

  // Reading window-server state would otherwise give this helper a Dock icon.
  const application = send<bigint>(objcClass("NSApplication"), "sharedApplication");
  send<boolean>(
    application,
    "setActivationPolicy:",
    D.Boolean,
    [D.I64],
    [NS_APPLICATION_ACTIVATION_POLICY_PROHIBITED],
  );
  const workspace = send<bigint>(objcClass("NSWorkspace"), "sharedWorkspace");
  const poolClass = objcClass("NSAutoreleasePool");

  const attributeNames = new Map(
    ["AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXIdentifier", "AXFocusedUIElement"].map(
      (name) => [
        name,
        call<bigint>(
          "cf",
          "CFStringCreateWithCString",
          D.BigInt,
          [D.BigInt, D.String, D.U32],
          [0n, name, UTF8],
        ),
      ],
    ),
  );
  const systemElement = call<bigint>("ax", "AXUIElementCreateSystemWide", D.BigInt);
  const shortTimeout = (element: bigint) =>
    call<number>(
      "ax",
      "AXUIElementSetMessagingTimeout",
      D.I32,
      [D.BigInt, D.Float],
      [element, 0.05],
    );
  shortTimeout(systemElement);

  const copyAttribute = (element: bigint, name: string) => {
    const out = Buffer.alloc(8);
    const error = call<number>(
      "ax",
      "AXUIElementCopyAttributeValue",
      D.I32,
      [D.BigInt, D.BigInt, D.U8Array],
      [element, attributeNames.get(name), out],
    );
    return { error, pointer: error === 0 ? out.readBigUInt64LE() : 0n };
  };
  const decodeString = (pointer: bigint): string | null => {
    if (pointer === 0n) return null;
    const buffer = Buffer.alloc(1024);
    const ok = call<boolean>(
      "cf",
      "CFStringGetCString",
      D.Boolean,
      [D.BigInt, D.U8Array, D.I64, D.U32],
      [pointer, buffer, buffer.length, UTF8],
    );
    return ok ? buffer.subarray(0, buffer.indexOf(0)).toString("utf8") : null;
  };
  const stringAttribute = (element: bigint, name: string) => {
    const { pointer } = copyAttribute(element, name);
    try {
      return decodeString(pointer);
    } finally {
      release(pointer);
    }
  };
  const ownerPid = (element: bigint): number | null => {
    const out = Buffer.alloc(4);
    const error = call<number>(
      "ax",
      "AXUIElementGetPid",
      D.I32,
      [D.BigInt, D.U8Array],
      [element, out],
    );
    return error === 0 ? out.readInt32LE() : null;
  };
  /** Role and subrole, or null when they can't be read and the element must be treated as unsafe. */
  const identity = (element: bigint) => {
    const role = stringAttribute(element, "AXRole");
    if (!role) return null;
    const read = copyAttribute(element, "AXSubrole");
    try {
      if (![0, AX_ERROR_ATTRIBUTE_UNSUPPORTED, AX_ERROR_NO_VALUE].includes(read.error)) return null;
      const subrole = decodeString(read.pointer);
      if (read.pointer !== 0n && subrole === null) return null;
      return { role, subrole, protected: /secure|password/i.test(`${role} ${subrole ?? ""}`) };
    } finally {
      release(read.pointer);
    }
  };

  const forApp = (pid: number): SkillInputApi => {
    const appElement = call<bigint>("ax", "AXUIElementCreateApplication", D.BigInt, [D.I32], [pid]);
    shortTimeout(appElement);
    return {
      frontPid: () => {
        const pool = send<bigint>(poolClass, "new");
        try {
          const front = send<bigint>(workspace, "frontmostApplication");
          return front === 0n ? null : send<number>(front, "processIdentifier", D.I32);
        } finally {
          send<void>(pool, "drain", D.Void);
        }
      },
      flags: () => call<number>("cg", "CGEventSourceFlagsState", D.U64, [D.I32], [0]),
      buttonDown: (button) =>
        call<boolean>("cg", "CGEventSourceButtonState", D.Boolean, [D.I32, D.U32], [0, button]),
      // CGKeyCode is uint16_t; ffi-rs has no U16 and I16 shares its ABI for these codes.
      keyDown: (keyCode) =>
        call<boolean>("cg", "CGEventSourceKeyState", D.Boolean, [D.I32, D.I16], [0, keyCode]),
      pointer: () => {
        const event = call<bigint>("cg", "CGEventCreate", D.BigInt, [D.BigInt], [0n]);
        if (event === 0n) return null;
        try {
          return call<{ x: number; y: number }>(
            "cg",
            "CGEventGetLocation",
            { x: D.Double, y: D.Double, ffiTypeTag: D.StackStruct },
            [D.BigInt],
            [event],
          );
        } finally {
          release(event);
        }
      },
      focus: () => {
        const { pointer } = copyAttribute(appElement, "AXFocusedUIElement");
        if (pointer === 0n) return null;
        try {
          if (ownerPid(pointer) !== pid) return null;
          shortTimeout(pointer);
          const target = identity(pointer);
          return target
            ? {
                role: normalizedRole(target.role),
                subrole: target.subrole,
                protected: target.protected,
              }
            : null;
        } finally {
          release(pointer);
        }
      },
      hitTest: (x, y) => {
        const out = Buffer.alloc(8);
        const error = call<number>(
          "ax",
          "AXUIElementCopyElementAtPosition",
          D.I32,
          [D.BigInt, D.Float, D.Float, D.U8Array],
          [systemElement, x, y, out],
        );
        if (error !== 0) return null;
        const element = out.readBigUInt64LE();
        try {
          // Ownership first: nothing is read from another app's element.
          if (ownerPid(element) !== pid) return null;
          shortTimeout(element);
          const target = identity(element);
          if (!target || target.protected) return null;
          // Some apps echo entered text into a field's title, so fields stay unnamed.
          // Icon buttons carry their label in the description instead of a title.
          const label = TEXT_ROLES.test(target.role)
            ? null
            : stringAttribute(element, "AXTitle") || stringAttribute(element, "AXDescription");
          const name = label?.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_CHARS) || null;
          return {
            role: normalizedRole(target.role),
            name,
            elementKey: stringAttribute(element, "AXIdentifier"),
          };
        } finally {
          release(element);
        }
      },
      close: () => release(appElement),
    };
  };

  return {
    forApp,
    close: () => {
      for (const pointer of attributeNames.values()) release(pointer);
      release(systemElement);
    },
  };
}
