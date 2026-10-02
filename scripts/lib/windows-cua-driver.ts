const WINDOWS_GUI_SUBSYSTEM = 2;
const WINDOWS_CONSOLE_SUBSYSTEM = 3;
const PE32_PLUS_MAGIC = 0x20b;
const MACHINE = { x64: 0x8664, arm64: 0xaa64 } as const;

/**
 * The embedded SDK owns process creation and does not expose CREATE_NO_WINDOW.
 * Give only our bundled helper the Windows GUI subsystem before signing, so
 * Windows does not allocate a console. Its entry point and inherited stdio
 * (including the SDK's parent-liveness pipe) remain unchanged.
 */
export function prepareWindowsCuaDriver(bytes: Uint8Array, arch: "x64" | "arm64") {
  const image = Buffer.from(bytes);
  const invalid = () => new Error("Expected an unsigned PE32+ Cua Driver executable.");
  if (image.length < 64 || image.readUInt16LE(0) !== 0x5a4d) throw invalid();
  const peOffset = image.readUInt32LE(0x3c);
  const optionalOffset = peOffset + 24;
  if (peOffset < 64 || optionalOffset + 152 > image.length) throw invalid();
  const optionalSize = image.readUInt16LE(peOffset + 20);
  if (
    image.readUInt32LE(peOffset) !== 0x00004550 ||
    image.readUInt16LE(peOffset + 4) !== MACHINE[arch] ||
    (image.readUInt16LE(peOffset + 22) & 0x2002) !== 0x0002 ||
    optionalSize < 152 ||
    optionalOffset + optionalSize > image.length ||
    image.readUInt16LE(optionalOffset) !== PE32_PLUS_MAGIC ||
    image.readUInt32LE(optionalOffset + 108) < 5 ||
    image.readUInt32LE(optionalOffset + 144) !== 0 ||
    image.readUInt32LE(optionalOffset + 148) !== 0
  ) {
    throw invalid();
  }

  const subsystemOffset = optionalOffset + 68;
  const subsystem = image.readUInt16LE(subsystemOffset);
  if (subsystem === WINDOWS_GUI_SUBSYSTEM) return image;
  if (subsystem !== WINDOWS_CONSOLE_SUBSYSTEM) throw invalid();
  // The pinned upstream executables have no image checksum. Refuse a changed
  // artifact rather than silently invalidating a checksum or signature.
  if (image.readUInt32LE(optionalOffset + 64) !== 0) throw invalid();
  image.writeUInt16LE(WINDOWS_GUI_SUBSYSTEM, subsystemOffset);
  return image;
}
