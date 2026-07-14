export const MAX_OUTPUT_BYTES = 64 * 1024;

function utf8BoundaryBefore(buf: Buffer, index: number): number {
  let i = index;
  while (i > 0 && ((buf[i] ?? 0) & 0xc0) === 0x80) i--;
  return i;
}

function utf8BoundaryAtOrAfter(buf: Buffer, index: number): number {
  let i = index;
  while (i < buf.length && ((buf[i] ?? 0) & 0xc0) === 0x80) i++;
  return i;
}

export interface CappedOutput {
  text: string;
  truncated: boolean;
}

// Head+tail elision on UTF-8 boundaries: long test logs bury the failure at
// the end, so the tail matters as much as the head.
export function capOutput(
  text: string,
  maxBytes = MAX_OUTPUT_BYTES,
): CappedOutput {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  const half = Math.floor(maxBytes / 2);
  const head = buf.subarray(0, utf8BoundaryBefore(buf, half)).toString("utf8");
  const tail = buf
    .subarray(utf8BoundaryAtOrAfter(buf, buf.length - half))
    .toString("utf8");
  const elided = buf.length - maxBytes;
  return {
    text: `${head}\n[... ${elided} bytes elided ...]\n${tail}`,
    truncated: true,
  };
}
