import { readFileSync } from "fs";
import {
  loadStoredProjects,
  normalizeTimelineClip,
} from "../src/project/projectStore.ts";

const raw = readFileSync("/tmp/parascene-projects-v1.json", "utf8");
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => {
    store.set(k, v);
  },
  removeItem: (k: string) => {
    store.delete(k);
  },
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage;

store.set("parascene.projects.v1", raw);
try {
  const loaded = loadStoredProjects();
  console.log(
    "loaded count",
    loaded.length,
    loaded.map((p) => p.title),
  );
} catch (e) {
  console.error("load threw", e);
}

const parsed = JSON.parse(raw) as Array<{
  title: string;
  timeline?: unknown[];
}>;
for (const p of parsed) {
  console.log("project", p.title, "timeline clips", (p.timeline || []).length);
  let dropped = 0;
  for (const c of p.timeline || []) {
    try {
      const n = normalizeTimelineClip(c);
      if (!n) dropped++;
    } catch (e) {
      console.log("  clip threw", e);
    }
  }
  console.log("  dropped", dropped);
}
