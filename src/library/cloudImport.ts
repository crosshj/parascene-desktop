import type { Creation } from "./types";
import { isCoverOnlyCloudAv } from "./previewUrl";

export type CloudProvider = "suno" | "youtube";

export type CloudImport = {
  provider: CloudProvider;
  label: string;
  pageUrl: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function providerFromUrl(url: string): CloudProvider | null {
  const lower = url.toLowerCase();
  if (lower.includes("suno.com")) return "suno";
  if (
    lower.includes("youtube.com") ||
    lower.includes("youtu.be") ||
    lower.includes("youtube-nocookie.com")
  ) {
    return "youtube";
  }
  return null;
}

function labelFor(provider: CloudProvider): string {
  return provider === "suno" ? "Suno" : "YouTube";
}

/** Suno / YouTube import metadata stored on `remote_json.meta.import`. */
export function parseCloudImport(c: {
  remoteJson?: string | null;
}): CloudImport | null {
  const raw = c.remoteJson?.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const root = asRecord(parsed);
    const meta = asRecord(root?.meta);
    const imp = asRecord(meta?.import) ?? asRecord(root?.import);
    if (!imp) return null;
    const pageUrl =
      asString(imp.url) || asString(imp.embed_url) || asString(imp.page_url);
    const named = asString(imp.provider).toLowerCase();
    const provider: CloudProvider | null =
      named === "suno" || named === "youtube"
        ? named
        : providerFromUrl(pageUrl);
    if (!provider) return null;
    return {
      provider,
      label: labelFor(provider),
      pageUrl: pageUrl || null,
    };
  } catch {
    return null;
  }
}

export function cloudHostCaption(c: Creation): string | null {
  const imp = parseCloudImport(c);
  const coverOnly = isCoverOnlyCloudAv(c);
  if (!imp && !coverOnly) return null;
  const kind = String(c.mediaType ?? "")
    .trim()
    .toLowerCase();
  const media =
    kind === "audio"
      ? "Cloud audio"
      : kind === "video"
        ? "Cloud video"
        : "Cloud";
  return imp ? `${media} · ${imp.label}` : media;
}

export function cloudPlayAction(c: Creation): { label: string; url: string } | null {
  const imp = parseCloudImport(c);
  if (!imp?.pageUrl) return null;
  return { label: `Play on ${imp.label}`, url: imp.pageUrl };
}
