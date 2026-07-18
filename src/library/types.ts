export type MediaType = "video" | "image" | "audio";

export type DownloadState =
  | "remote"
  | "queued"
  | "downloading"
  | "local"
  | "failed";

/** Local catalog row (denormalized API fields + download state). */
export type Creation = {
  id: string;
  title: string;
  mediaType: MediaType | string;
  remoteUrl: string | null;
  thumbnailUrl: string | null;
  /** Native-aspect cloud thumb (`?variant=fit`); preferred over square. */
  fitThumbnailUrl: string | null;
  videoUrl: string | null;
  localPath: string | null;
  localThumbPath: string | null;
  published: boolean;
  publishedAt: string | null;
  createdAt: string;
  downloadState: DownloadState | string;
  checksum: string | null;
  prompt: string | null;
  expiresAt: string | null;
  updatedAt: string;
  filename: string | null;
  description: string | null;
  color: string | null;
  status: string | null;
  width: number | null;
  height: number | null;
  /** Creative ratio when present; groups prefer cover pixels over this. */
  aspectRatio: string | null;
  nsfw: boolean;
  isModeratedError: boolean;
  /** Full Parascene `GET /api/create/images` row as synced (JSON string). */
  remoteJson: string | null;
};

/** Payload written into SQLite by `library_apply_manifest`. */
export type CreationUpsert = {
  id: string;
  title: string;
  mediaType: string;
  remoteUrl: string | null;
  thumbnailUrl: string | null;
  fitThumbnailUrl?: string | null;
  videoUrl: string | null;
  published: boolean;
  publishedAt: string | null;
  createdAt: string;
  downloadState: DownloadState | string;
  prompt: string | null;
  filename: string | null;
  description: string | null;
  color: string | null;
  status: string | null;
  width: number | null;
  height: number | null;
  aspectRatio: string | null;
  nsfw: boolean;
  isModeratedError: boolean;
  remoteJson: string;
};

export type SyncStatus = {
  rootPath: string;
  lastSyncAt: string | null;
  total: number;
  local: number;
  remote: number;
  queued: number;
  downloading: number;
  failed: number;
  /** Creations with a local thumbnail on disk. */
  withThumb: number;
  /** Creations with full local media on disk. */
  withMedia: number;
  /** Missing previews that still have a downloadable URL. */
  missingThumbCacheable: number;
  /** Missing media that still have a remote URL. */
  missingMediaCacheable: number;
  /** Cloud-backed creations with no local thumb and no downloadable preview URL. */
  missingThumbUncacheable: number;
  /** Cloud-backed creations with no local media and no remote URL. */
  missingMediaUncacheable: number;
  /** Bytes under Library/media. */
  mediaBytes: number;
  /** Bytes under Library/thumbs. */
  thumbsBytes: number;
  /**
   * Cloud-backed creations with nothing to download (no cloud URLs). Capped in the backend.
   * Excludes local-only imports.
   */
  withoutCloudUrls: WithoutCloudUrl[];
};

export type WithoutCloudUrl = {
  id: string;
  title: string;
  filename: string | null;
};

export type CreationPage = {
  creations: Creation[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
};

/** Full-catalog tallies for the Creations sidebar (from SQLite). */
export type CatalogFilterCounts = {
  all: number;
  video: number;
  image: number;
  audio: number;
  groups: number;
  localOnly: number;
  published: number;
  unpublished: number;
  /** Approximate from denormalized aspect_ratio / width×height (not remote_json). */
  aspect11: number;
  aspect916: number;
  aspect45: number;
  aspect169: number;
};

export type DownloadSummary = {
  downloaded: number;
  failed: number;
  skipped: number;
  status: SyncStatus;
};

export type DownloadProgress = {
  done: number;
  total: number;
  currentId: string | null;
  failed: number;
  phase?: string;
};

/** One scroll page (~16 rows × 5 cols) — keep ahead of fast scroll. */
export const CREATIONS_PAGE_SIZE = 80;

/** How many SQLite pages to pull whenever the board gets near the end. */
export const CREATIONS_LOAD_MORE_PAGES = 2;
