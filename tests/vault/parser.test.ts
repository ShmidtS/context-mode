/**
 * parser.test — Unit tests for vault note parser.
 */

import { describe, test } from "vitest";
import { strict as assert } from "node:assert";
import { parseVaultNote } from "../../src/vault/parser.js";
import type { ParsedNote } from "../../src/vault/parser.js";

describe("parseVaultNote: frontmatter", () => {
  test("extracts YAML frontmatter keys", () => {
    const content = `---
title: My Note
tags: [research, ai]
priority: 5
pinned: true
---
# My Note
Some content`;

    const result = parseVaultNote("notes/my-note.md", content);
    assert.equal(result.frontmatter.title, "My Note");
    assert.deepEqual(result.frontmatter.tags, ["research", "ai"]);
    assert.equal(result.frontmatter.priority, 5);
    assert.equal(result.frontmatter.pinned, true);
  });

  test("returns empty frontmatter when no --- delimiters", () => {
    const result = parseVaultNote("simple.md", "Just text");
    assert.deepEqual(result.frontmatter, {});
  });

  test("returns empty frontmatter when only opening --- exists", () => {
    const content = `---
title: Orphan
No closing delimiter`;
    const result = parseVaultNote("orphan.md", content);
    assert.deepEqual(result.frontmatter, {});
  });
});

describe("parseVaultNote: title derivation", () => {
  test("uses frontmatter title when present", () => {
    const content = `---
title: Frontmatter Title
---
# H1 Title
Content`;
    const result = parseVaultNote("path/note.md", content);
    assert.equal(result.title, "Frontmatter Title");
  });

  test("falls back to first H1 when no frontmatter title", () => {
    const content = `# H1 Title
Content`;
    const result = parseVaultNote("path/note.md", content);
    assert.equal(result.title, "H1 Title");
  });

  test("falls back to filename stem when no title anywhere", () => {
    const result = parseVaultNote("path/my-note.md", "Just content");
    assert.equal(result.title, "my-note");
  });
});

describe("parseVaultNote: wiki-links", () => {
  test("extracts simple wiki-link [[Target]]", () => {
    const content = "See [[Some Note]] for details.";
    const result = parseVaultNote("note.md", content);
    assert.equal(result.wikiLinks.length, 1);
    assert.equal(result.wikiLinks[0].target, "Some Note");
    assert.equal(result.wikiLinks[0].type, "wikilink");
    assert.equal(result.wikiLinks[0].alias, undefined);
    assert.ok(result.wikiLinks[0].lineNumber > 0);
  });

  test("extracts wiki-link with alias [[Target|Alias]]", () => {
    const content = "Check [[Some Note|the note]] here.";
    const result = parseVaultNote("note.md", content);
    assert.equal(result.wikiLinks.length, 1);
    assert.equal(result.wikiLinks[0].target, "Some Note");
    assert.equal(result.wikiLinks[0].alias, "the note");
  });

  test("extracts embed wiki-link ![[Target]]", () => {
    const content = "Here is an image: ![[screenshot.png]]";
    const result = parseVaultNote("note.md", content);
    assert.equal(result.wikiLinks.length, 1);
    assert.equal(result.wikiLinks[0].target, "screenshot.png");
    assert.equal(result.wikiLinks[0].type, "embed");
  });

  test("extracts multiple wiki-links on same line", () => {
    const content = "Links: [[A]] and [[B]] together.";
    const result = parseVaultNote("note.md", content);
    assert.equal(result.wikiLinks.length, 2);
    assert.equal(result.wikiLinks[0].target, "A");
    assert.equal(result.wikiLinks[1].target, "B");
  });

  test("ignores wiki-links inside fenced code blocks", () => {
    const content = "Text\n```js\nconst x = [[NotALink]]\n```\nReal [[ActualLink]]";
    const result = parseVaultNote("note.md", content);
    assert.equal(result.wikiLinks.length, 1);
    assert.equal(result.wikiLinks[0].target, "ActualLink");
  });

  test("ignores wiki-links inside 4-space indented code blocks", () => {
    const content = "Text\n    const x = [[NotALink]]\nReal [[ActualLink]]";
    const result = parseVaultNote("note.md", content);
    assert.equal(result.wikiLinks.length, 1);
    assert.equal(result.wikiLinks[0].target, "ActualLink");
  });

  test("extracts wiki-link with heading anchor [[Target#Section]]", () => {
    const content = "See [[Some Note#Introduction]] for details.";
    const result = parseVaultNote("note.md", content);
    assert.equal(result.wikiLinks.length, 1);
    assert.equal(result.wikiLinks[0].target, "Some Note");
  });
});

describe("parseVaultNote: markdown links", () => {
  test("extracts markdown link to .md file", () => {
    const content = "See [the docs](./docs/guide.md) for info.";
    const result = parseVaultNote("note.md", content);
    assert.equal(result.markdownLinks.length, 1);
    assert.equal(result.markdownLinks[0].text, "the docs");
    assert.equal(result.markdownLinks[0].target, "./docs/guide.md");
  });

  test("captures markdown links to any file type, skips URLs", () => {
    const content = "See [image](./img/photo.png) and [site](https://example.com).";
    const result = parseVaultNote("note.md", content);
    assert.equal(result.markdownLinks.length, 1);
    assert.equal(result.markdownLinks[0].text, "image");
    assert.equal(result.markdownLinks[0].target, "./img/photo.png");
  });

  test("ignores markdown links inside fenced code blocks", () => {
    const content = "```md\n[link](other.md)\n```\n[real](real.md)";
    const result = parseVaultNote("note.md", content);
    assert.equal(result.markdownLinks.length, 1);
    assert.equal(result.markdownLinks[0].target, "real.md");
  });
});

describe("parseVaultNote: tags", () => {
  test("extracts inline tags #tag and #parent/child", () => {
    const content = "Working on #ai and #ml/transformers today.";
    const result = parseVaultNote("note.md", content);
    assert.ok(result.tags.includes("ai"));
    assert.ok(result.tags.includes("ml/transformers"));
  });

  test("extracts tags from frontmatter tags array", () => {
    const content = `---
tags: [research, draft]
---
Some text`;
    const result = parseVaultNote("note.md", content);
    assert.ok(result.tags.includes("research"));
    assert.ok(result.tags.includes("draft"));
  });

  test("deduplicates tags between frontmatter and inline", () => {
    const content = `---
tags: [ai]
---
Working on #ai again.`;
    const result = parseVaultNote("note.md", content);
    const aiCount = result.tags.filter((t) => t === "ai").length;
    assert.equal(aiCount, 1);
  });

  test("ignores tags inside fenced code blocks", () => {
    const content = "```py\n# notatag\n```\n#realtag here";
    const result = parseVaultNote("note.md", content);
    assert.ok(result.tags.includes("realtag"));
    assert.ok(!result.tags.includes("notatag"));
  });

  test("ignores tags inside 4-space indented code", () => {
    const content = "    #indentedtag\n#realtag";
    const result = parseVaultNote("note.md", content);
    assert.ok(result.tags.includes("realtag"));
    assert.ok(!result.tags.includes("indentedtag"));
  });

  test("ignores tags that look like URL fragments", () => {
    const content = "Visit https://example.com/page#section for info. #real";
    const result = parseVaultNote("note.md", content);
    assert.ok(result.tags.includes("real"));
    // #section should NOT be extracted as it follows a URL
    assert.ok(!result.tags.includes("section"));
  });

  test("ignores # tags that start with a digit", () => {
    const content = "Issue #123 is fixed. #valid-tag";
    const result = parseVaultNote("note.md", content);
    assert.ok(!result.tags.includes("123"));
    assert.ok(result.tags.includes("valid-tag"));
  });
});

describe("parseVaultNote: contentHash", () => {
  test("produces consistent SHA-256 hash", () => {
    const content = "Hello world";
    const result1 = parseVaultNote("a.md", content);
    const result2 = parseVaultNote("a.md", content);
    assert.equal(result1.contentHash, result2.contentHash);
    assert.equal(result1.contentHash.length, 64); // hex SHA-256
  });

  test("different content produces different hash", () => {
    const result1 = parseVaultNote("a.md", "Content A");
    const result2 = parseVaultNote("a.md", "Content B");
    assert.notEqual(result1.contentHash, result2.contentHash);
  });
});

describe("parseVaultNote: broken link scenario", () => {
  test("wiki-link to non-existent target is still extracted", () => {
    const content = "This links to [[NonExistentNote]] which does not exist.";
    const result = parseVaultNote("note.md", content);
    assert.equal(result.wikiLinks.length, 1);
    assert.equal(result.wikiLinks[0].target, "NonExistentNote");
    // Resolver handles broken link detection, parser just extracts
  });
});

describe("parseVaultNote: combined note", () => {
  test("parses note with frontmatter, tags, wiki-links, markdown-links, embeds", () => {
    const content = `---
title: Combined Note
tags: [project, active]
---
# Combined Note

This note is about #project/alpha.

See [[Design Doc]] for the architecture and [[API Reference|the API]] for endpoints.

Here's a screenshot: ![[diagram.png]]

Also check the [readme](../README.md) for setup.

\`\`\`python
# This is a comment, not a tag
x = "[[NotALink]]"
\`\`\`

Real link after code: [[Real Link]]`;

    const result = parseVaultNote("notes/combined.md", content);

    // Title
    assert.equal(result.title, "Combined Note");

    // Tags: frontmatter + inline, deduplicated
    assert.ok(result.tags.includes("project"));
    assert.ok(result.tags.includes("active"));
    assert.ok(result.tags.includes("project/alpha"));
    assert.ok(!result.tags.includes("comment"));

    // Wiki-links (3: Design Doc, API Reference, Real Link)
    assert.equal(result.wikiLinks.length, 3 + 1); // +1 for embed
    const targets = result.wikiLinks.map((wl) => wl.target);
    assert.ok(targets.includes("Design Doc"));
    assert.ok(targets.includes("API Reference"));
    assert.ok(targets.includes("diagram.png"));
    assert.ok(targets.includes("Real Link"));
    assert.ok(!targets.includes("NotALink"));

    // Embed
    const embed = result.wikiLinks.find((wl) => wl.type === "embed");
    assert.ok(embed);
    assert.equal(embed!.target, "diagram.png");

    // Alias
    const aliased = result.wikiLinks.find((wl) => wl.alias);
    assert.ok(aliased);
    assert.equal(aliased!.alias, "the API");

    // Markdown link
    assert.equal(result.markdownLinks.length, 1);
    assert.equal(result.markdownLinks[0].target, "../README.md");

    // Content hash
    assert.equal(result.contentHash.length, 64);
  });
});

describe("parseVaultNote: tag hierarchy", () => {
  test("#parent/child also adds #parent tag", () => {
    const content = "Working on #ml/transformers today.";
    const result = parseVaultNote("note.md", content);
    assert.ok(result.tags.includes("ml/transformers"));
    assert.ok(result.tags.includes("ml"), "parent tag 'ml' should be auto-added");
  });

  test("#a/b/c adds #a as parent", () => {
    const content = "Tagged #a/b/c";
    const result = parseVaultNote("note.md", content);
    assert.ok(result.tags.includes("a/b/c"));
    assert.ok(result.tags.includes("a"), "parent tag 'a' should be auto-added");
  });

  test("simple tag without slash does not add extra tags", () => {
    const content = "Just #simple";
    const result = parseVaultNote("note.md", content);
    assert.ok(result.tags.includes("simple"));
    assert.equal(result.tags.length, 1);
  });
});

describe("parseVaultNote: markdown links to code files", () => {
  test("extracts markdown link to .ts file", () => {
    const content = "See [server](./src/server.ts) for details.";
    const result = parseVaultNote("note.md", content);
    assert.equal(result.markdownLinks.length, 1);
    assert.equal(result.markdownLinks[0].target, "./src/server.ts");
  });

  test("extracts markdown link to .js file", () => {
    const content = "Check [app](./app.js) for the code.";
    const result = parseVaultNote("note.md", content);
    assert.equal(result.markdownLinks.length, 1);
    assert.equal(result.markdownLinks[0].target, "./app.js");
  });

  test("extracts markdown link to .mjs file", () => {
    const content = "See [cli](./cli.mjs).";
    const result = parseVaultNote("note.md", content);
    assert.equal(result.markdownLinks.length, 1);
    assert.equal(result.markdownLinks[0].target, "./cli.mjs");
  });

  test("extracts markdown link to .cjs file", () => {
    const content = "Config in [file](./config.cjs).";
    const result = parseVaultNote("note.md", content);
    assert.equal(result.markdownLinks.length, 1);
    assert.equal(result.markdownLinks[0].target, "./config.cjs");
  });

  test("still extracts .md links alongside code links", () => {
    const content = "See [doc](./guide.md) and [server](./server.ts).";
    const result = parseVaultNote("note.md", content);
    assert.equal(result.markdownLinks.length, 2);
  });
});

describe("parseVaultNote: snippet context size", () => {
  test("wiki-link context is >= 120 chars when content permits", () => {
    // Create a long line with a wiki-link in the middle
    const padding = "A".repeat(100);
    const content = `${padding}See [[Target]] for${padding}`;
    const result = parseVaultNote("note.md", content);
    assert.equal(result.wikiLinks.length, 1);
    // Context should be at least 120 chars (60 before + match + 60 after)
    assert.ok(
      result.wikiLinks[0].context.length >= 120,
      `Context length ${result.wikiLinks[0].context.length} should be >= 120`
    );
  });

  test("markdown-link context is >= 120 chars when content permits", () => {
    const padding = "B".repeat(100);
    const content = `${padding}See [text](./target.md) for${padding}`;
    const result = parseVaultNote("note.md", content);
    assert.equal(result.markdownLinks.length, 1);
    assert.ok(
      result.markdownLinks[0].context.length >= 120,
      `Context length ${result.markdownLinks[0].context.length} should be >= 120`
    );
  });
});
