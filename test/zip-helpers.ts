import { crc32, inflateRawSync } from "node:zlib";

/** Reads a zip back through its central directory, checking each file's CRC, for tests. */
export function readZip(zip: Buffer): Map<string, Buffer> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end === -1) throw new Error("No end of central directory");
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error("Bad central directory entry");
    const crc = zip.readUInt32LE(offset + 16);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const local = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error(`Bad local header for ${name}`);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = inflateRawSync(zip.subarray(start, start + compressedSize));
    if (crc32(data) !== crc) throw new Error(`CRC mismatch for ${name}`);
    files.set(name, data);
    offset += 46 + nameLength;
  }
  return files;
}
