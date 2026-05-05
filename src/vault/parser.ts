/**
 * parser — Parse markdown files from an Obsidian vault.
 *
 * Extracts frontmatter, tags, wiki-links, markdown links, and embeds
 * from Obsidian-flavoured markdown. Skips content inside code blocks.
 */

import { createHash } from "node:crypto";

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export interface WikiLink {
  target: string;
  alias?: string;
  lineNumber: number;
  context: string;
  type: "wikilink" | "embed";
}

export interface MarkdownLink {
  text: string;
  target: string;
  lineNumber: number;
  context: string;
}

export interface ParsedNote {
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
  wikiLinks: WikiLink[];
  markdownLinks: MarkdownLink[];
  contentHash: string;
}

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

/**
 * Strip code blocks (triple-backtick fences and 4-space indented blocks)
 * from markdown content. Returns an array of { text, isCode } segments
 * so callers can map line numbers back to the original.
 */
function segmentCodeBlocks(content: string): { text: string; isCode: boolean; startLine: number }[] {
  const lines = content.split("\n");
  const segments: { text: string; isCode: boolean; startLine: number }[] = [];
  let inFence = false;
  let fenceStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inFence && line.startsWith("```")) {
      inFence = true;
      fenceStart = i;
      continue;
    }
    if (inFence && line.startsWith("```")) {
      inFence = false;
      continue;
    }
    if (inFence) continue;

    // 4-space indented code block (single line basis — conservative)
    const isIndented = line.startsWith("    ") && line.trim().length > 0;

    segments.push({ text: line, isCode: isIndented, startLine: i });
  }

  return segments;
}

/**
 * Extract YAML frontmatter. Returns { frontmatter, bodyStartLine }.
 * bodyStartLine is the 0-based line index where content after frontmatter begins.
 */
function extractFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  bodyStartLine: number;
} {
  const lines = content.split("\n");
  if (lines[0] !== "---") {
    return { frontmatter: {}, bodyStartLine: 0 };
  }

  const closeIdx = lines.findIndex((line, i) => i > 0 && line === "---");
  if (closeIdx === -1) {
    return { frontmatter: {}, bodyStartLine: 0 };
  }

  const yamlBlock = lines.slice(1, closeIdx).join("\n");
  const frontmatter: Record<string, unknown> = {};

  for (const rawLine of yamlBlock.split("\n")) {
    const colonIdx = rawLine.indexOf(":");
    if (colonIdx === -1) continue;
    const key = rawLine.slice(0, colonIdx).trim();
    const val = rawLine.slice(colonIdx + 1).trim();
    // Minimal YAML parsing: strings, booleans, numbers, arrays
    if (val.startsWith("[") && val.endsWith("]")) {
      frontmatter[key] = val
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ""));
    } else if (val === "true") {
      frontmatter[key] = true;
    } else if (val === "false") {
      frontmatter[key] = false;
    } else if (val !== "" && !isNaN(Number(val))) {
      frontmatter[key] = Number(val);
    } else {
      frontmatter[key] = val.replace(/^['"]|['"]$/g, "");
    }
  }

  return { frontmatter, bodyStartLine: closeIdx + 1 };
}

/**
 * Derive note title from frontmatter `title` key, or from the first H1,
 * or from the filename stem.
 */
function deriveTitle(
  filePath: string,
  frontmatter: Record<string, unknown>,
  content: string,
): string {
  if (typeof frontmatter.title === "string" && frontmatter.title.length > 0) {
    return frontmatter.title as string;
  }

  const h1Match = content.match(/^#\s+(.+)$/m);
  if (h1Match) return h1Match[1].trim();

  const stem = filePath.replace(/\\/g, "/").split("/").pop() ?? filePath;
  return stem.replace(/\.md$/, "");
}

// ─────────────────────────────────────────────────────────
// Regex patterns
// ─────────────────────────────────────────────────────────

// Wiki-links: [[Target]] or [[Target|Alias]] or ![[Target]] (embed)
const WIKI_LINK_RE = /(!?)\[\[([^\]#|]+?)(?:#[^|]*)?(?:\|([^\]]+))?\]\]/g;

// Markdown links: [text](any-path) — matches any file path, URLs filtered in parsing loop
const MD_LINK_RE = /\[([^\]]*)\]\(([^)\s]+)\)/g;

// Inline tags: #tag or #parent/child — not inside code, not a URL fragment
const TAG_RE = /(?:^|[\s(>])#([a-zA-Z][\w/-]*)/g;

// ─────────────────────────────────────────────────────────
// Main parser
// ─────────────────────────────────────────────────────────

/**
 * Parse a single Obsidian vault note.
 *
 * @param filePath — Relative or absolute path to the note.
 * @param content — Raw markdown content of the note.
 */
export function parseVaultNote(filePath: string, content: string): ParsedNote {
  const contentHash = createHash("sha256").update(content).digest("hex");
  const { frontmatter, bodyStartLine } = extractFrontmatter(content);
  const title = deriveTitle(filePath, frontmatter, content);

  const lines = content.split("\n");
  const segments = segmentCodeBlocks(content);

  const tags = new Set<string>();
  const wikiLinks: WikiLink[] = [];
  const markdownLinks: MarkdownLink[] = [];

  // Extract tags from frontmatter `tags` key
  if (Array.isArray(frontmatter.tags)) {
    for (const t of frontmatter.tags as string[]) {
      tags.add(t);
    }
  }

  // Process non-code segments
  for (const seg of segments) {
    if (seg.isCode) continue;

    const lineNum = seg.startLine;
    const lineText = seg.text;

    // Inline tags
    let tagMatch: RegExpExecArray | null;
    const tagRe = new RegExp(TAG_RE.source, TAG_RE.flags);
    while ((tagMatch = tagRe.exec(lineText)) !== null) {
      const tag = tagMatch[1];
      tags.add(tag);
      // Tag hierarchy: #parent/child also adds #parent
      if (tag.includes("/")) {
        tags.add(tag.split("/")[0]);
      }
    }

    // Wiki-links and embeds
    let wlMatch: RegExpExecArray | null;
    const wlRe = new RegExp(WIKI_LINK_RE.source, WIKI_LINK_RE.flags);
    while ((wlMatch = wlRe.exec(lineText)) !== null) {
      const isEmbed = wlMatch[1] === "!";
      const target = wlMatch[2].trim();
      const alias = wlMatch[3]?.trim();
      // Context: ~120 chars around the match (60 before, 60 after)
      const matchStart = wlMatch.index;
      const ctxStart = Math.max(0, matchStart - 60);
      const ctxEnd = Math.min(lineText.length, matchStart + wlMatch[0].length + 60);
      const context = lineText.slice(ctxStart, ctxEnd);

      wikiLinks.push({
        target,
        alias,
        lineNumber: lineNum + 1, // 1-based
        context,
        type: isEmbed ? "embed" : "wikilink",
      });
    }

    // Markdown links to any file (skip URLs)
    let mdMatch: RegExpExecArray | null;
    const mdRe = new RegExp(MD_LINK_RE.source, MD_LINK_RE.flags);
    while ((mdMatch = mdRe.exec(lineText)) !== null) {
      const text = mdMatch[1].trim();
      const target = mdMatch[2].trim();

      // Skip URLs — only local file links are relevant
      if (/^(?:https?|ftp|mailto):/.test(target)) continue;
      const matchStart = mdMatch.index;
      const ctxStart = Math.max(0, matchStart - 60);
      const ctxEnd = Math.min(lineText.length, matchStart + mdMatch[0].length + 60);
      const context = lineText.slice(ctxStart, ctxEnd);

      markdownLinks.push({
        text,
        target,
        lineNumber: lineNum + 1, // 1-based
        context,
      });
    }
  }

  return {
    path: filePath,
    title,
    frontmatter,
    tags: [...tags],
    wikiLinks,
    markdownLinks,
    contentHash,
  };
}
