/**
 * Persist Lab run selection + form drafts (Replicate models / Blue methods).
 * File-pick serialization matches Replicate's creation:/path: format.
 */

import type { ReplicateInputField } from "../../replicate/replicateClient";
import type { LabRunFilePick } from "./LabLibraryFilePicker";
import { isFileArrayField, isFileField } from "./labSchemaForm";

export type LabPersistScope = "replicate" | "blue";

const SELECTED_KEY: Record<LabPersistScope, string> = {
  replicate: "parascene.lab.replicateSelected",
  blue: "parascene.lab.blueSelected",
};

const VALUES_KEY: Record<LabPersistScope, string> = {
  replicate: "parascene.lab.replicateRunValues",
  blue: "parascene.lab.blueRunValues",
};

const FILES_KEY: Record<LabPersistScope, string> = {
  // Replicate keeps legacy `parascene.lab.replicateRunImages` in its panel.
  replicate: "parascene.lab.replicateRunImages",
  blue: "parascene.lab.blueRunFiles",
};

function readJsonObject(key: string): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore quota / private mode
  }
}

/** Replicate: `owner/name`. Blue: method id. */
export function loadLabSelection(scope: LabPersistScope): string | null {
  try {
    const raw = localStorage.getItem(SELECTED_KEY[scope])?.trim();
    return raw || null;
  } catch {
    return null;
  }
}

export function saveLabSelection(
  scope: LabPersistScope,
  key: string | null,
): void {
  try {
    if (!key) localStorage.removeItem(SELECTED_KEY[scope]);
    else localStorage.setItem(SELECTED_KEY[scope], key);
  } catch {
    // ignore
  }
}

export function loadLabFormValues(
  scope: LabPersistScope,
  modelKey: string,
): Record<string, string> {
  const all = readJsonObject(VALUES_KEY[scope]);
  const entry = all[modelKey];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export function saveLabFormValues(
  scope: LabPersistScope,
  modelKey: string,
  values: Record<string, string>,
): void {
  const all = readJsonObject(VALUES_KEY[scope]);
  all[modelKey] = values;
  writeJson(VALUES_KEY[scope], all);
}

export function serializeLabRunFilePick(pick: LabRunFilePick): string {
  if (pick.kind === "creation") return `creation:${pick.creationId}`;
  return `path:${pick.path}`;
}

export function parseLabRunFilePick(raw: string): LabRunFilePick | null {
  const t = raw.trim();
  if (!t) return null;
  if (t.startsWith("creation:")) {
    const creationId = t.slice("creation:".length).trim();
    return creationId ? { kind: "creation", creationId } : null;
  }
  if (t.startsWith("path:")) {
    const path = t.slice("path:".length);
    return path ? { kind: "path", path } : null;
  }
  return { kind: "creation", creationId: t };
}

function fileStorageKey(modelKey: string, field: string): string {
  return `${modelKey}::${field}`;
}

function loadFileMap(scope: LabPersistScope): Record<string, string> {
  const parsed = readJsonObject(FILES_KEY[scope]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === "string" && v.trim()) out[k] = v.trim();
  }
  return out;
}

export function saveLabFilePick(
  scope: LabPersistScope,
  modelKey: string,
  field: string,
  pick: LabRunFilePick | null,
): void {
  const map = loadFileMap(scope);
  const key = fileStorageKey(modelKey, field);
  if (pick) map[key] = serializeLabRunFilePick(pick);
  else delete map[key];
  writeJson(FILES_KEY[scope], map);
}

export function saveLabFileListPick(
  scope: LabPersistScope,
  modelKey: string,
  field: string,
  picks: LabRunFilePick[],
): void {
  const map = loadFileMap(scope);
  const key = fileStorageKey(modelKey, field);
  if (picks.length) {
    map[key] = JSON.stringify(picks.map(serializeLabRunFilePick));
  } else {
    delete map[key];
  }
  writeJson(FILES_KEY[scope], map);
}

export function loadLabFilePicksForModel(
  scope: LabPersistScope,
  modelKey: string,
  fields: ReplicateInputField[],
): Record<string, LabRunFilePick> {
  const map = loadFileMap(scope);
  const out: Record<string, LabRunFilePick> = {};
  for (const field of fields) {
    if (!isFileField(field)) continue;
    const raw = map[fileStorageKey(modelKey, field.name)];
    if (!raw || raw.startsWith("[")) continue;
    const pick = parseLabRunFilePick(raw);
    if (pick) out[field.name] = pick;
  }
  return out;
}

export function loadLabFileListPicksForModel(
  scope: LabPersistScope,
  modelKey: string,
  fields: ReplicateInputField[],
): Record<string, LabRunFilePick[]> {
  const map = loadFileMap(scope);
  const out: Record<string, LabRunFilePick[]> = {};
  for (const field of fields) {
    if (!isFileArrayField(field)) continue;
    const raw = map[fileStorageKey(modelKey, field.name)];
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) continue;
      const picks: LabRunFilePick[] = [];
      for (const item of parsed) {
        if (typeof item !== "string") continue;
        const pick = parseLabRunFilePick(item);
        if (pick) picks.push(pick);
      }
      if (picks.length) out[field.name] = picks;
    } catch {
      // ignore
    }
  }
  return out;
}
