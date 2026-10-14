import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

it("UI text and accessible descriptions cannot silently bypass dictionaries", () => {
  const findings: string[] = [];
  const allowed = new Set(["Unifi Protect Archive UI", "MAC", "PostgreSQL", "UniFi Protect"]);
  for (const directory of ["src/app", "src/components"]) {
    for (const name of readdirSync(directory, { recursive: true }) as string[]) {
      if (!name.endsWith(".tsx")) continue;
      const file = path.join(directory, name);
      const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      function walk(node: ts.Node) {
        if (ts.isJsxText(node)) {
          const text = node.text.replace(/\s+/g, " ").trim();
          if (/[A-Za-zÀ-ž]/.test(text) && !allowed.has(text) && !text.startsWith("npm run ")) findings.push(`${file}: ${text}`);
        }
        if (ts.isJsxAttribute(node) && ["aria-label", "title", "alt", "placeholder"].includes(node.name.getText(source)) && node.initializer && ts.isStringLiteral(node.initializer) && /[A-Za-zÀ-ž]/.test(node.initializer.text) && !allowed.has(node.initializer.text)) findings.push(`${file}: ${node.name.getText(source)}`);
        ts.forEachChild(node, walk);
      }
      walk(source);
    }
  }
  expect(findings).toEqual([]);
});
