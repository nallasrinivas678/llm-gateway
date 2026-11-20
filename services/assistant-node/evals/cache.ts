// Embeddings do not change for the same model and text, so they are saved on disk and a re-run with
// other settings costs no embedding calls.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { EmbedFn } from "../src/docQa/embeddings.js";

export function withDiskCache(embed: EmbedFn, file: string, model: string): EmbedFn {
  const saved: Record<string, number[]> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const keyOf = (task: string, text: string) => createHash("sha1").update(`${model}\n${task}\n${text}`).digest("hex");

  return async (texts, task) => {
    const missing = [...new Set(texts.filter((text) => !(keyOf(task, text) in saved)))];
    if (missing.length > 0) {
      const vectors = await embed(missing, task);
      missing.forEach((text, i) => (saved[keyOf(task, text)] = vectors[i]!));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(saved));
    }
    return texts.map((text) => saved[keyOf(task, text)]!);
  };
}
