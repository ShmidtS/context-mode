/**
 * code-parser.test — Unit tests for code file import parser.
 */

import { describe, test } from "vitest";
import { strict as assert } from "node:assert";
import { parseCodeFile } from "../../src/vault/code-parser.js";

describe("parseCodeFile: static imports", () => {
  test("extracts import ... from 'module'", () => {
    const content = `import { foo } from "./utils";\nconsole.log(foo);\n`;
    const result = parseCodeFile("src/main.ts", content);
    assert.equal(result.imports.length, 1);
    assert.equal(result.imports[0].specifier, "./utils");
    assert.equal(result.imports[0].kind, "static");
    assert.equal(result.imports[0].lineNumber, 1);
  });

  test("extracts multiple static imports", () => {
    const content = `import { a } from "./a";\nimport { b } from "./b";\n`;
    const result = parseCodeFile("src/main.ts", content);
    assert.equal(result.imports.length, 2);
    assert.equal(result.imports[0].specifier, "./a");
    assert.equal(result.imports[1].specifier, "./b");
  });

  test("resolves relative imports when allPaths provided", () => {
    const content = `import { foo } from "./utils";\n`;
    const allPaths = new Set(["src/utils.ts", "src/main.ts"]);
    const result = parseCodeFile("src/main.ts", content, allPaths);
    assert.equal(result.imports[0].resolvedPath, "src/utils.ts");
  });

  test("returns null resolvedPath for non-relative imports", () => {
    const content = `import { createHash } from "node:crypto";\n`;
    const allPaths = new Set(["src/main.ts"]);
    const result = parseCodeFile("src/main.ts", content, allPaths);
    assert.equal(result.imports[0].resolvedPath, null);
  });
});

describe("parseCodeFile: dynamic imports", () => {
  test("extracts import('module')", () => {
    const content = `const mod = import("./lazy");\n`;
    const result = parseCodeFile("src/main.ts", content);
    assert.equal(result.imports.length, 1);
    assert.equal(result.imports[0].specifier, "./lazy");
    assert.equal(result.imports[0].kind, "dynamic");
  });
});

describe("parseCodeFile: require calls", () => {
  test("extracts require('module')", () => {
    const content = `const path = require("node:path");\nconst utils = require("./utils");\n`;
    const result = parseCodeFile("src/main.cjs", content);
    assert.equal(result.imports.length, 2);
    const requireImp = result.imports.find((i) => i.specifier === "./utils");
    assert.ok(requireImp);
    assert.equal(requireImp!.kind, "require");
  });
});

describe("parseCodeFile: export-from", () => {
  test("extracts export { ... } from 'module'", () => {
    const content = `export { foo } from "./base";\n`;
    const result = parseCodeFile("src/index.ts", content);
    assert.equal(result.imports.length, 1);
    assert.equal(result.imports[0].specifier, "./base");
    assert.equal(result.imports[0].kind, "export-from");
  });

  test("extracts export * from 'module'", () => {
    const content = `export * from "./all";\n`;
    const result = parseCodeFile("src/index.ts", content);
    assert.equal(result.imports.length, 1);
    assert.equal(result.imports[0].kind, "export-from");
  });
});

describe("parseCodeFile: tags from path", () => {
  test("derives tags from directory segments", () => {
    const result = parseCodeFile("src/vault/indexer.ts", "");
    assert.ok(result.tags.includes("src"));
    assert.ok(result.tags.includes("vault"));
    assert.equal(result.tags.length, 2);
  });

  test("no tags for root-level file", () => {
    const result = parseCodeFile("main.ts", "");
    assert.equal(result.tags.length, 0);
  });
});

describe("parseCodeFile: title derivation", () => {
  test("title is basename without extension", () => {
    const result = parseCodeFile("src/vault/parser.ts", "");
    assert.equal(result.title, "parser");
  });

  test("handles .mjs extension", () => {
    const result = parseCodeFile("cli.mjs", "");
    assert.equal(result.title, "cli");
  });
});

describe("parseCodeFile: contentHash", () => {
  test("produces SHA-256 hash", () => {
    const result = parseCodeFile("a.ts", "content");
    assert.equal(result.contentHash.length, 64);
  });

  test("different content different hash", () => {
    const r1 = parseCodeFile("a.ts", "aaa");
    const r2 = parseCodeFile("a.ts", "bbb");
    assert.notEqual(r1.contentHash, r2.contentHash);
  });
});

describe("parseCodeFile: import resolution", () => {
  test("resolves with .ts extension", () => {
    const allPaths = new Set(["src/foo.ts", "src/main.ts"]);
    const content = `import { x } from "./foo";\n`;
    const result = parseCodeFile("src/main.ts", content, allPaths);
    assert.equal(result.imports[0].resolvedPath, "src/foo.ts");
  });

  test("resolves with .js extension", () => {
    const allPaths = new Set(["src/foo.js", "src/main.js"]);
    const content = `import { x } from "./foo";\n`;
    const result = parseCodeFile("src/main.js", content, allPaths);
    assert.equal(result.imports[0].resolvedPath, "src/foo.js");
  });

  test("resolves index files", () => {
    const allPaths = new Set(["src/mod/index.ts", "src/main.ts"]);
    const content = `import { x } from "./mod";\n`;
    const result = parseCodeFile("src/main.ts", content, allPaths);
    assert.equal(result.imports[0].resolvedPath, "src/mod/index.ts");
  });

  test("returns null for unresolvable relative import", () => {
    const allPaths = new Set(["src/main.ts"]);
    const content = `import { x } from "./missing";\n`;
    const result = parseCodeFile("src/main.ts", content, allPaths);
    assert.equal(result.imports[0].resolvedPath, null);
  });
});
