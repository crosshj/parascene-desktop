import { describe, expect, it } from "vitest";
import type { Creation, CreationUpsert } from "../library/types";
import {
  addAssetGenerationFromCreation,
  creationUpsertWithAddAssetGeneration,
  deriveAddAssetGenerationFromParasceneMeta,
  isImageToImageGeneration,
  isTextToImageGeneration,
  makeImageToImageGeneration,
  mergeAddAssetGenerationIntoRemoteJson,
  mergeStampWithDerivedGeneration,
  preserveDesktopAddAssetGeneration,
  resolveAddAssetGenerationFromCreation,
  shouldStampCatalogAddAssetGeneration,
  stampIntentFromVideoRun,
} from "./desktopAddAssetGeneration";
import type { AddAssetGeneration } from "./types";

const generation: AddAssetGeneration = {
  prompt: "creature walks",
  generatedAt: "2026-07-28T00:00:00.000Z",
  creationId: "gen-1",
  mode: "start_frame",
  model: "vidu/q3-turbo",
  provider: "replicate",
  methodId: "replicate_timeline_fill",
  startFrameFraming: "fill",
};

function baseCreation(remoteJson: string | null = "{}"): Creation {
  return {
    id: "gen-1",
    title: "Clip",
    mediaType: "video",
    remoteUrl: null,
    thumbnailUrl: null,
    fitThumbnailUrl: null,
    videoUrl: null,
    localPath: "/tmp/a.mp4",
    localThumbPath: null,
    published: false,
    publishedAt: null,
    createdAt: "2026-07-28T00:00:00.000Z",
    downloadState: "local",
    checksum: null,
    prompt: null,
    expiresAt: null,
    updatedAt: "2026-07-28T00:00:00.000Z",
    filename: "a.mp4",
    description: null,
    color: null,
    status: "completed",
    width: 1280,
    height: 720,
    aspectRatio: "16:9",
    nsfw: false,
    isModeratedError: false,
    remoteJson,
  };
}

describe("desktopAddAssetGeneration", () => {
  it("round-trips generation through remoteJson", () => {
    const upsert = creationUpsertWithAddAssetGeneration(
      baseCreation(),
      generation,
    );
    expect(upsert.prompt).toBe("creature walks");
    expect(addAssetGenerationFromCreation(upsert)).toMatchObject(generation);
  });

  it("round-trips text-to-video mode none", () => {
    const t2v: AddAssetGeneration = {
      prompt: "a bird over water",
      generatedAt: "2026-08-07T00:00:00.000Z",
      creationId: "gen-t2v",
      mode: "none",
      model: "wan_t2v",
      provider: "parascene_blue",
      methodId: "blue_timeline_fill",
    };
    const upsert = creationUpsertWithAddAssetGeneration(baseCreation(), t2v);
    expect(addAssetGenerationFromCreation(upsert)).toMatchObject(t2v);
  });

  it("preserves prior desktop stamp when sync upsert lacks one", () => {
    const existing = creationUpsertWithAddAssetGeneration(
      baseCreation(),
      generation,
    );
    const remoteUpsert: CreationUpsert = {
      ...existing,
      prompt: null,
      remoteJson: JSON.stringify({ id: "gen-1", meta: { prompt: "api" } }),
    };
    const preserved = preserveDesktopAddAssetGeneration(
      remoteUpsert,
      baseCreation(existing.remoteJson),
    );
    expect(addAssetGenerationFromCreation(preserved)?.prompt).toBe(
      "creature walks",
    );
    expect(preserved.prompt).toBe("creature walks");
  });

  it("keeps cabinet desktop keys when merging generation", () => {
    const withCabinet = mergeAddAssetGenerationIntoRemoteJson(
      JSON.stringify({
        meta: { desktop: { role: "project_videos", client: "parascene-desktop" } },
      }),
      generation,
    );
    const parsed = JSON.parse(withCabinet) as {
      meta: { desktop: Record<string, unknown> };
    };
    expect(parsed.meta.desktop.role).toBe("project_videos");
    expect(parsed.meta.desktop.addAssetGeneration).toMatchObject({
      prompt: "creature walks",
    });
  });

  it("detects image-to-image library generations", () => {
    const i2i = makeImageToImageGeneration({
      prompt: "blue sky",
      creationId: "out-1",
      model: "grok-imagine",
      server: "parascene_blue",
      sourceCreationId: "src-1",
    });
    expect(isImageToImageGeneration(i2i)).toBe(true);
    expect(isTextToImageGeneration(i2i)).toBe(false);
  });
});

function parasceneRemoteJson(meta: Record<string, unknown>): string {
  return JSON.stringify({
    id: "gen-1",
    media_type: "image",
    created_at: "2026-08-23T04:00:00.000Z",
    meta,
  });
}

describe("deriveAddAssetGenerationFromParasceneMeta", () => {
  it("derives text2image from Parascene meta.args", () => {
    const creation = baseCreation(
      parasceneRemoteJson({
        method: "text2image",
        server_id: 6,
        server_name: "Parascene Blue",
        user_prompt: "beautiful scenery",
        completed_at: "2026-08-23T05:39:26.954Z",
        args: {
          model: "checkpoints/1.5/liberty_main.safetensors",
          prompt: "beautiful scenery",
          aspect_ratio: "9:16",
        },
      }),
    );
    creation.mediaType = "image";
    const derived = deriveAddAssetGenerationFromParasceneMeta(creation);
    expect(derived).toMatchObject({
      prompt: "beautiful scenery",
      creationId: "gen-1",
      generatedAt: "2026-08-23T05:39:26.954Z",
      mode: "none",
      model: "checkpoints/1.5/liberty_main.safetensors",
      intentId: "text_to_image",
      methodId: "text_to_image",
      server: "parascene_blue",
    });
    expect(isTextToImageGeneration(derived)).toBe(true);
  });

  it("derives image2video with start-frame preview from input_images", () => {
    const creation = baseCreation(
      parasceneRemoteJson({
        method: "image2video",
        server_id: 6,
        server_name: "Parascene Blue",
        completed_at: "2026-08-23T04:58:33.349Z",
        source_image_url: "https://example.com/fallback.png",
        args: {
          model: "ltx_i2v",
          prompt: "Camera gently glides toward the lake",
          input_images: ["https://sh.parascene.com/api/share/v1/AGSm/image"],
          duration_seconds: 15,
        },
      }),
    );
    creation.mediaType = "video";
    const derived = deriveAddAssetGenerationFromParasceneMeta(creation);
    expect(derived).toMatchObject({
      prompt: "Camera gently glides toward the lake",
      mode: "start_frame",
      intentId: "image_to_video",
      methodId: "image_to_video",
      model: "ltx_i2v",
      startFramePreviewUrl: "https://sh.parascene.com/api/share/v1/AGSm/image",
    });
  });

  it("derives replicate image edit as image_to_image", () => {
    const creation = baseCreation(
      parasceneRemoteJson({
        method: "replicate",
        server_id: 1,
        server_name: "Parascene",
        completed_at: "2026-08-23T04:48:40.715Z",
        args: {
          model: "xai/grok-imagine-image",
          prompt: "make flowers yellow",
          input_images: ["https://sh.parascene.com/api/share/v1/AGQ6/image"],
        },
      }),
    );
    creation.mediaType = "image";
    const derived = deriveAddAssetGenerationFromParasceneMeta(creation);
    expect(derived).toMatchObject({
      prompt: "make flowers yellow",
      intentId: "image_to_image",
      methodId: "image_to_image",
      mode: "start_frame",
      server: "parascene_blue",
    });
    expect(isImageToImageGeneration(derived)).toBe(true);
  });

  it("skips uploadImage even when a prompt column exists", () => {
    const creation = baseCreation(
      parasceneRemoteJson({
        method: "uploadImage",
        server_name: "Parascene",
        args: { aspect_ratio: "9:16" },
      }),
    );
    creation.mediaType = "image";
    creation.prompt = "should not matter";
    expect(deriveAddAssetGenerationFromParasceneMeta(creation)).toBeNull();
  });

  it("resolve prefers desktop stamp over Parascene meta.args", () => {
    const stamped = creationUpsertWithAddAssetGeneration(
      baseCreation(
        parasceneRemoteJson({
          method: "text2image",
          server_id: 6,
          args: { prompt: "from cloud args", model: "cloud-model" },
          completed_at: "2026-08-23T05:00:00.000Z",
        }),
      ),
      {
        prompt: "from desktop stamp",
        generatedAt: "2026-08-23T06:00:00.000Z",
        creationId: "gen-1",
        mode: "none",
        model: "stamp-model",
        intentId: "text_to_image",
        server: "parascene_blue",
        provider: "parascene_blue",
        methodId: "text_to_image",
      },
    );
    const creation = baseCreation(stamped.remoteJson);
    creation.mediaType = "image";
    expect(resolveAddAssetGenerationFromCreation(creation)?.prompt).toBe(
      "from desktop stamp",
    );
    expect(addAssetGenerationFromCreation(creation)?.prompt).toBe(
      "from desktop stamp",
    );
  });

  it("resolve falls back to Parascene meta when stamp is missing", () => {
    const creation = baseCreation(
      parasceneRemoteJson({
        method: "text2image",
        server_id: 6,
        args: { prompt: "cloud only", model: "liberty" },
        completed_at: "2026-08-23T05:00:00.000Z",
      }),
    );
    creation.mediaType = "image";
    expect(addAssetGenerationFromCreation(creation)).toBeNull();
    expect(resolveAddAssetGenerationFromCreation(creation)?.prompt).toBe(
      "cloud only",
    );
  });

  it("heals local-* FIRST stamps when Parascene meta has the still URL", () => {
    const stamped = mergeAddAssetGenerationIntoRemoteJson(
      parasceneRemoteJson({
        method: "image2video",
        server_id: 6,
        args: {
          prompt: "glide",
          model: "ltx_i2v",
          input_images: ["https://sh.parascene.com/api/share/v1/still/image"],
        },
        completed_at: "2026-08-23T05:00:00.000Z",
      }),
      {
        prompt: "glide",
        generatedAt: "2026-08-23T06:00:00.000Z",
        creationId: "gen-1",
        mode: "start_frame",
        model: "ltx_i2v",
        intentId: "image_to_video",
        server: "parascene_blue",
        provider: "parascene_blue",
        methodId: "image_to_video",
        startFrameAssetId: "local-temp-extract",
        firstFrameSource: { kind: "asset", assetId: "local-temp-extract" },
      },
    );
    const creation = baseCreation(stamped);
    creation.mediaType = "video";
    const resolved = resolveAddAssetGenerationFromCreation(creation);
    expect(resolved?.startFrameAssetId).toBeUndefined();
    expect(resolved?.firstFrameSource).toEqual({ kind: "none" });
    expect(resolved?.startFramePreviewUrl).toBe(
      "https://sh.parascene.com/api/share/v1/still/image",
    );
  });

  it("heals I2I stamp on image2video to I2V while keeping start asset id", () => {
    const stamped = mergeAddAssetGenerationIntoRemoteJson(
      parasceneRemoteJson({
        method: "image2video",
        server_id: 6,
        args: {
          prompt: "glide",
          model: "ltx_i2v",
          input_images: ["https://sh.parascene.com/api/share/v1/still/image"],
        },
        completed_at: "2026-08-23T05:00:00.000Z",
      }),
      {
        prompt: "glide",
        generatedAt: "2026-08-23T06:00:00.000Z",
        creationId: "gen-1",
        mode: "start_frame",
        model: "ltx_i2v",
        intentId: "image_to_image",
        server: "parascene_blue",
        provider: "parascene_blue",
        methodId: "image_to_image",
        startFrameAssetId: "25757",
        firstFrameSource: { kind: "asset", assetId: "25757" },
        startFramePreviewUrl: "asset://preview/25757",
      },
    );
    const creation = baseCreation(stamped);
    creation.mediaType = "video";
    const stamp = addAssetGenerationFromCreation(creation);
    const merged = mergeStampWithDerivedGeneration(stamp, creation);
    expect(merged?.intentId).toBe("image_to_video");
    expect(merged?.methodId).toBe("image_to_video");
    expect(merged?.model).toBe("ltx_i2v");
    expect(merged?.mode).toBe("start_frame");
    expect(merged?.startFrameAssetId).toBe("25757");
    expect(merged?.startFramePreviewUrl).toBe("asset://preview/25757");
    expect(isImageToImageGeneration(merged)).toBe(false);
  });
});

describe("stampIntentFromVideoRun", () => {
  it("infers image_to_video from i2v model even when draft is I2I", () => {
    expect(
      stampIntentFromVideoRun({
        mode: "start_frame",
        model: "ltx_i2v",
        draftIntentId: "image_to_image",
        draftMethodId: "image_to_image",
      }),
    ).toEqual({
      intentId: "image_to_video",
      methodId: "image_to_video",
    });
  });

  it("keeps draft when it already matches the inferred video intent", () => {
    expect(
      stampIntentFromVideoRun({
        mode: "start_frame",
        model: "ltx_i2v",
        draftIntentId: "image_to_video",
        draftMethodId: "image_to_video",
      }),
    ).toEqual({
      intentId: "image_to_video",
      methodId: "image_to_video",
    });
  });

  it("infers text_to_video for none mode / t2v model", () => {
    expect(
      stampIntentFromVideoRun({
        mode: "none",
        model: "wan_t2v",
        draftIntentId: "text_to_image",
      }),
    ).toEqual({
      intentId: "text_to_video",
      methodId: "text_to_video",
    });
  });
});

describe("shouldStampCatalogAddAssetGeneration", () => {
  it("does not stamp Parascene Creation-backed servers", () => {
    expect(shouldStampCatalogAddAssetGeneration("parascene_blue")).toBe(false);
    expect(shouldStampCatalogAddAssetGeneration("parascene")).toBe(false);
  });

  it("stamps local-only servers that lack Creation meta", () => {
    expect(shouldStampCatalogAddAssetGeneration("blue_direct")).toBe(true);
    expect(shouldStampCatalogAddAssetGeneration("replicate")).toBe(true);
  });

  it("does not stamp unknown or empty servers", () => {
    expect(shouldStampCatalogAddAssetGeneration(null)).toBe(false);
    expect(shouldStampCatalogAddAssetGeneration(undefined)).toBe(false);
    expect(shouldStampCatalogAddAssetGeneration("")).toBe(false);
    expect(shouldStampCatalogAddAssetGeneration("other")).toBe(false);
  });
});
