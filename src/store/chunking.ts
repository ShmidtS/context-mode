/**
 * Content chunking — markdown, plain text, and JSON chunkers.
 *
 * Each chunker splits input into titled, size-bounded chunks suitable
 * for FTS5 indexing. Code-block awareness prevents mid-fence splits.
 */

import { Chunk, MAX_CHUNK_BYTES } from "./types.js";

// ─────────────────────────────────────────────────────────
// Markdown chunker
// ─────────────────────────────────────────────────────────

export function chunkMarkdown(text: string, maxChunkBytes: number = MAX_CHUNK_BYTES): Chunk[] {
  const chunks: Chunk[] = [];
  const lines = text.split("\n");
  const headingStack: Array<{ level: number; text: string }> = [];
  let currentContent: string[] = [];
  let currentHeading = "";

  const flush = () => {
    const joined = currentContent.join("\n").trim();
    if (joined.length === 0) return;

    const title = buildTitle(headingStack, currentHeading);
    const hasCode = currentContent.some((l) => /^`{3,}/.test(l));

    // If under the cap, emit as-is (fast path — most chunks hit this)
    if (Buffer.byteLength(joined) <= maxChunkBytes) {
      chunks.push({ title, content: joined, hasCode });
      currentContent = [];
      return;
    }

    // Split oversized chunk at paragraph boundaries (double newlines)
    const paragraphs = joined.split(/\n\n+/);
    let accumulator: string[] = [];
    let partIndex = 1;

    const flushAccumulator = () => {
      if (accumulator.length === 0) return;
      const part = accumulator.join("\n\n").trim();
      if (part.length === 0) return;
      const partTitle = paragraphs.length > 1 ? `${title} (${partIndex})` : title;
      partIndex++;
      chunks.push({
        title: partTitle,
        content: part,
        hasCode: part.includes("```"),
      });
      accumulator = [];
    };

    for (const para of paragraphs) {
      accumulator.push(para);
      const candidate = accumulator.join("\n\n");
      if (Buffer.byteLength(candidate) > maxChunkBytes && accumulator.length > 1) {
        accumulator.pop();
        flushAccumulator();
        accumulator = [para];
      }
    }
    flushAccumulator();

    currentContent = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Horizontal rule separator (Context7 uses long dashes)
    if (/^[-_*]{3,}\s*$/.test(line)) {
      flush();
      i++;
      continue;
    }

    // Heading (H1-H4)
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      flush();

      const level = headingMatch[1].length;
      const heading = headingMatch[2].trim();

      // Pop deeper levels from stack
      while (
        headingStack.length > 0 &&
        headingStack[headingStack.length - 1].level >= level
      ) {
        headingStack.pop();
      }
      headingStack.push({ level, text: heading });
      currentHeading = heading;

      currentContent.push(line);
      i++;
      continue;
    }

    // Code block — collect entire block as a unit
    const codeMatch = line.match(/^(`{3,})(.*)?$/);
    if (codeMatch) {
      const fence = codeMatch[1];
      const codeLines: string[] = [line];
      i++;

      while (i < lines.length) {
        codeLines.push(lines[i]);
        if (lines[i].startsWith(fence) && lines[i].trim() === fence) {
          i++;
          break;
        }
        i++;
      }

      currentContent.push(...codeLines);
      continue;
    }

    // Regular line
    currentContent.push(line);
    i++;
  }

  // Flush remaining content
  flush();

  return chunks;
}

// ─────────────────────────────────────────────────────────
// Plain text chunker
// ─────────────────────────────────────────────────────────

export function chunkPlainText(
  text: string,
  linesPerChunk: number,
): Array<{ title: string; content: string }> {
  // Try blank-line splitting first for naturally-sectioned output
  const sections = text.split(/\n\s*\n/);
  if (
    sections.length >= 3 &&
    sections.length <= 200 &&
    sections.every((s) => Buffer.byteLength(s) < 5000)
  ) {
    return sections
      .map((section, i) => {
        const trimmed = section.trim();
        const firstLine = trimmed.split("\n")[0].slice(0, 80);
        return {
          title: firstLine || `Section ${i + 1}`,
          content: trimmed,
        };
      })
      .filter((s) => s.content.length > 0);
  }

  const lines = text.split("\n");

  // Small enough for a single chunk
  if (lines.length <= linesPerChunk) {
    return [{ title: "Output", content: text }];
  }

  // Fixed-size line groups with 2-line overlap
  const chunks: Array<{ title: string; content: string }> = [];
  const overlap = 2;
  const step = Math.max(linesPerChunk - overlap, 1);

  for (let i = 0; i < lines.length; i += step) {
    const slice = lines.slice(i, i + linesPerChunk);
    if (slice.length === 0) break;
    const startLine = i + 1;
    const endLine = Math.min(i + slice.length, lines.length);
    const firstLine = slice[0]?.trim().slice(0, 80);
    chunks.push({
      title: firstLine || `Lines ${startLine}-${endLine}`,
      content: slice.join("\n"),
    });
  }

  return chunks;
}

// ─────────────────────────────────────────────────────────
// JSON chunker
// ─────────────────────────────────────────────────────────

export function walkJSON(
  value: unknown,
  path: string[],
  chunks: Chunk[],
  maxChunkBytes: number,
): void {
  const title = path.length > 0 ? path.join(" > ") : "(root)";
  const serialized = JSON.stringify(value, null, 2);

  // Small enough — emit as a single chunk
  if (Buffer.byteLength(serialized) <= maxChunkBytes) {
    // Exception: objects with nested structure (object/array values) always
    // recurse so that key paths become chunk titles for searchability —
    // even when the subtree fits in one chunk. Flat objects (all primitive
    // values) stay as a single chunk since there's no hierarchy to expose.
    const shouldRecurse =
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.values(value).some(
        (v) => typeof v === "object" && v !== null,
      );

    if (!shouldRecurse) {
      chunks.push({ title, content: serialized, hasCode: true });
      return;
    }
  }

  // Object — recurse into each key
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const entries = Object.entries(value);
    if (entries.length > 0) {
      for (const [key, val] of entries) {
        walkJSON(val, [...path, key], chunks, maxChunkBytes);
      }
      return;
    }
    // Empty object — emit as-is
    chunks.push({ title, content: serialized, hasCode: true });
    return;
  }

  // Array — batch by size with identity-field-aware titles
  if (Array.isArray(value)) {
    chunkJSONArray(value, path, chunks, maxChunkBytes);
    return;
  }

  // Primitive that exceeds maxChunkBytes (e.g., very long string)
  chunks.push({ title, content: serialized, hasCode: false });
}

/**
 * Scan the first element of an array of objects for a recognizable
 * identity field. Returns the field name or null.
 */
function findIdentityField(arr: unknown[]): string | null {
  if (arr.length === 0) return null;
  const first = arr[0];
  if (typeof first !== "object" || first === null || Array.isArray(first)) return null;

  const candidates = ["id", "name", "title", "path", "slug", "key", "label"];
  const obj = first as Record<string, unknown>;
  for (const field of candidates) {
    if (field in obj && (typeof obj[field] === "string" || typeof obj[field] === "number")) {
      return field;
    }
  }
  return null;
}

function jsonBatchTitle(
  prefix: string,
  startIdx: number,
  endIdx: number,
  batch: unknown[],
  identityField: string | null,
): string {
  const sep = prefix ? `${prefix} > ` : "";

  if (!identityField) {
    return startIdx === endIdx
      ? `${sep}[${startIdx}]`
      : `${sep}[${startIdx}-${endIdx}]`;
  }

  const getId = (item: unknown) =>
    String((item as Record<string, unknown>)[identityField]);

  if (batch.length === 1) {
    return `${sep}${getId(batch[0])}`;
  }
  if (batch.length <= 3) {
    return sep + batch.map(getId).join(", ");
  }
  return `${sep}${getId(batch[0])}…${getId(batch[batch.length - 1])}`;
}

function chunkJSONArray(
  arr: unknown[],
  path: string[],
  chunks: Chunk[],
  maxChunkBytes: number,
): void {
  const prefix = path.length > 0 ? path.join(" > ") : "(root)";
  const identityField = findIdentityField(arr);

  let batch: unknown[] = [];
  let batchStart = 0;

  const flushBatch = (batchEnd: number) => {
    if (batch.length === 0) return;
    const title = jsonBatchTitle(prefix, batchStart, batchEnd, batch, identityField);
    chunks.push({
      title,
      content: JSON.stringify(batch, null, 2),
      hasCode: true,
    });
  };

  for (let i = 0; i < arr.length; i++) {
    batch.push(arr[i]);
    const candidate = JSON.stringify(batch, null, 2);

    if (Buffer.byteLength(candidate) > maxChunkBytes && batch.length > 1) {
      batch.pop();
      flushBatch(i - 1);
      batch = [arr[i]];
      batchStart = i;
    }
  }

  // Flush remaining
  flushBatch(batchStart + batch.length - 1);
}

// ─────────────────────────────────────────────────────────
// Title builder
// ─────────────────────────────────────────────────────────

function buildTitle(
  headingStack: Array<{ level: number; text: string }>,
  currentHeading: string,
): string {
  if (headingStack.length === 0) {
    return currentHeading || "Untitled";
  }
  return headingStack.map((h) => h.text).join(" > ");
}
