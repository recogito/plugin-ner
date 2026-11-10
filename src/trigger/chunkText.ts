export interface TextChunk {
  text: string;
  /** UTF-16 offset, matching Java/CoreNLP and Recogito string offsets. */
  start: number;
}

// Exact, bounded slices: joining them reproduces the original text byte-for-byte
// after UTF-8 encoding. Keep separators instead of reconstructing offsets later.
export function chunkText(text: string, maxLength = 5000): TextChunk[] {
  if (!Number.isInteger(maxLength) || maxLength < 2)
    throw new Error('Chunk size must be an integer of at least 2');
  const chunks: TextChunk[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxLength, text.length);
    if (end < text.length) {
      const space = text.lastIndexOf(' ', end - 1);
      if (space >= start) end = space + 1;
      // A hard split of a long unbroken string must not split a surrogate pair.
      const previous = text.charCodeAt(end - 1), next = text.charCodeAt(end);
      if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff)
        end--;
    }
    chunks.push({ text: text.slice(start, end), start });
    start = end;
  }
  return chunks;
}
