import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

function copyDirFiles(source, target) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.isFile()) {
      copyFileSync(join(source, entry.name), join(target, entry.name));
    }
  }
}

copyDirFiles("src/templates", "dist/src/templates");
copyDirFiles("migrations", "dist/migrations");
