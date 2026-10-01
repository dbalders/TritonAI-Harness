import { describe, expect, it } from "vite-plus/test";

import { prepareWindowsCuaDriver } from "./windows-cua-driver.ts";

const PE_OFFSET = 0x80;
const OPTIONAL_OFFSET = PE_OFFSET + 24;
const SUBSYSTEM_OFFSET = OPTIONAL_OFFSET + 68;

function executable(arch: "x64" | "arm64") {
  const image = Buffer.alloc(1024, 0);
  image.writeUInt16LE(0x5a4d, 0);
  image.writeUInt32LE(PE_OFFSET, 0x3c);
  image.writeUInt32LE(0x00004550, PE_OFFSET);
  image.writeUInt16LE(arch === "x64" ? 0x8664 : 0xaa64, PE_OFFSET + 4);
  image.writeUInt16LE(240, PE_OFFSET + 20);
  image.writeUInt16LE(0x0022, PE_OFFSET + 22);
  image.writeUInt16LE(0x20b, OPTIONAL_OFFSET);
  image.writeUInt32LE(0x1000, OPTIONAL_OFFSET + 16);
  image.writeUInt16LE(3, SUBSYSTEM_OFFSET);
  image.writeUInt32LE(16, OPTIONAL_OFFSET + 108);
  image.fill(0x5a, 512);
  return image;
}

describe("bundled Windows Cua Driver", () => {
  it.each(["x64", "arm64"] as const)(
    "prevents console allocation for %s without changing code or the entry point",
    (arch) => {
      const source = executable(arch);
      const prepared = prepareWindowsCuaDriver(source, arch);
      expect(prepared.readUInt16LE(SUBSYSTEM_OFFSET)).toBe(2);
      expect(source.readUInt16LE(SUBSYSTEM_OFFSET)).toBe(3);
      prepared.writeUInt16LE(3, SUBSYSTEM_OFFSET);
      expect(prepared).toEqual(source);
    },
  );

  it("is idempotent when the upstream helper already has no console", () => {
    const image = executable("arm64");
    image.writeUInt16LE(2, SUBSYSTEM_OFFSET);
    expect(prepareWindowsCuaDriver(image, "arm64")).toEqual(image);
  });

  it("rejects the wrong architecture", () => {
    expect(() => prepareWindowsCuaDriver(executable("x64"), "arm64")).toThrow();
  });

  it.each([
    [0, 0],
    [0x3c, 0xffff],
    [PE_OFFSET, 0],
    [PE_OFFSET + 20, 0],
    [PE_OFFSET + 22, 0x2002],
    [OPTIONAL_OFFSET, 0x10b],
    [OPTIONAL_OFFSET + 64, 1],
    [OPTIONAL_OFFSET + 108, 0],
    [OPTIONAL_OFFSET + 144, 512],
    [OPTIONAL_OFFSET + 148, 128],
    [SUBSYSTEM_OFFSET, 1],
  ])("rejects unsupported or signed images (field %s)", (offset, value) => {
    const image = executable("x64");
    image.writeUInt16LE(value, offset);
    expect(() => prepareWindowsCuaDriver(image, "x64")).toThrow();
  });

  it.each([0, 63, OPTIONAL_OFFSET + 151, OPTIONAL_OFFSET + 239])(
    "rejects truncated images (%s bytes)",
    (length) => {
      expect(() => prepareWindowsCuaDriver(executable("x64").subarray(0, length), "x64")).toThrow();
    },
  );
});
