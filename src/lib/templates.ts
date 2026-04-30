import { readFileSync } from "node:fs";
import { join } from "node:path";

const templateNames = new Set(["nda", "privacy", "contractor"]);

export function loadTemplate(name: string): string {
  if (!templateNames.has(name)) {
    throw new Error(`Unknown template: ${name}`);
  }
  return readFileSync(join(process.cwd(), "src", "templates", `${name}.md`), "utf8");
}

export function applyTemplateVars(markdown: string, vars: Record<string, unknown> = {}) {
  return markdown.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => {
    const value = vars[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

export function titleFromMarkdown(markdown: string) {
  const heading = markdown.match(/^#\s+(.+)$/m);
  return heading?.[1]?.trim() || "Agreement";
}
