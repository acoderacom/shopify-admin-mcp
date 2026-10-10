import { gzipSync } from "node:zlib";

// Builds tar archives the way git archive does: ustar headers, plus pax headers where needed
function header(name: string, size: number, type: string, prefix = ""): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100);
  block.write("0000644\0", 100);
  block.write("0000000\0", 108);
  block.write("0000000\0", 116);
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  block.write("00000000000\0", 136);
  block.fill(0x20, 148, 156);
  block.write(type, 156);
  block.write("ustar\u000000", 257);
  block.write(prefix, 345, 155);
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
}

export function entry(name: string, content: string | Buffer, type = "0", prefix = ""): Buffer {
  const data = Buffer.from(content);
  return Buffer.concat([header(name, data.length, type, prefix), data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

export function paxPath(value: string): Buffer {
  const body = ` path=${value}\n`;
  let length = body.length + 1;
  while (String(length).length + body.length !== length) length++;
  return entry("PaxHeader", `${length}${body}`, "x");
}

export const tar = (...entries: Buffer[]) => Buffer.concat([...entries, Buffer.alloc(1024)]);

// Serves a tar archive the way GitHub's archive downloads do
export const gzipped = (archive: Buffer) => new Response(gzipSync(archive));
