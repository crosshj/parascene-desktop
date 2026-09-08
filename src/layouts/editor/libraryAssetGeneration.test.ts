import { describe, expect, it } from "vitest";
import type { LibraryAssetPlaceholder } from "../../project/libraryAssetPlaceholder";
import {
  findResumableLibraryAssetPlaceholders,
  libraryAudioCloneSeed,
  libraryPlaceholderResultSteps,
  makeLibraryAssetPlaceholderDraft,
} from "./libraryAssetGeneration";

function placeholder(
  patch: Partial<LibraryAssetPlaceholder> & {
    addAssetDraft?: Partial<LibraryAssetPlaceholder["addAssetDraft"]>;
  },
): LibraryAssetPlaceholder {
  return {
    id: "ph-1",
    kind: "image",
    aspectRatio: "16:9",
    status: "generating",
    addAssetDraft: {
      prompt: "test",
      intentId: "text_to_image",
      server: "parascene_blue",
      provider: "parascene_blue",
      methodId: "text_to_image",
      ...patch.addAssetDraft,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

describe("libraryPlaceholderResultSteps", () => {
  it("marks the first step active while starting", () => {
    const steps = libraryPlaceholderResultSteps(
      placeholder({
        addAssetDraft: {
          generationJob: {
            status: "starting",
            provider: "parascene_blue",
            startedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    );
    expect(steps[0]?.status).toBe("active");
    expect(steps[1]?.status).toBe("pending");
  });

  it("advances to sync when progress mentions syncing", () => {
    const steps = libraryPlaceholderResultSteps(
      placeholder({
        progressNote: "Syncing to Library…",
        addAssetDraft: {
          generationJob: {
            status: "importing",
            provider: "parascene_blue",
            startedAt: "2026-01-01T00:00:00.000Z",
            pendingCreationId: "remote-1",
          },
        },
      }),
    );
    expect(steps[1]?.status).toBe("done");
    expect(steps[2]?.status).toBe("active");
  });
});

describe("findResumableLibraryAssetPlaceholders", () => {
  it("returns generating audio with a persisted service job", () => {
    const found = findResumableLibraryAssetPlaceholders({
      "ph-1": placeholder({
        kind: "audio",
        addAssetDraft: {
          prompt: "hello",
          intentId: "text_to_speech",
          server: "replicate",
          provider: "replicate",
          methodId: "text_to_speech",
          audioExtras: { voiceId: "English_expressive_narrator" },
          generationJob: {
            status: "waiting",
            provider: "replicate",
            startedAt: "2026-01-01T00:00:00.000Z",
            serviceJobId: "job-9",
            model: "minimax/speech-2.8-hd",
          },
        },
      }),
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe("ph-1");
    expect(found[0]?.addAssetDraft.audioExtras?.voiceId).toBe(
      "English_expressive_narrator",
    );
  });

  it("skips error placeholders so a failed job is not re-watched", () => {
    const found = findResumableLibraryAssetPlaceholders({
      "ph-1": placeholder({
        status: "error",
        kind: "audio",
        addAssetDraft: {
          lastError: "Generate failed",
          generationJob: {
            status: "waiting",
            provider: "replicate",
            startedAt: "2026-01-01T00:00:00.000Z",
            serviceJobId: "job-9",
          },
        },
      }),
    });
    expect(found).toHaveLength(0);
  });
});

describe("makeLibraryAssetPlaceholderDraft", () => {
  it("persists speech extras for retry", () => {
    const draft = makeLibraryAssetPlaceholderDraft({
      prompt: "hello",
      intentId: "text_to_speech",
      server: "replicate",
      provider: "replicate",
      model: "minimax/speech-2.8-hd",
      audioExtras: { voiceId: "English_expressive_narrator" },
      serviceJobId: "job-1",
    });
    expect(draft.audioExtras).toEqual({
      voiceId: "English_expressive_narrator",
    });
    expect(draft.generationJob?.serviceJobId).toBe("job-1");
  });
});

describe("libraryAudioCloneSeed", () => {
  it("copies speech intent, model, line, and voice for Assets +", () => {
    expect(
      libraryAudioCloneSeed({
        prompt: "I had hoped you wouldn't find out like this.",
        generatedAt: "2026-01-01T00:00:00.000Z",
        creationId: "audio-1",
        mode: "none",
        model: "minimax/speech-2.8-hd",
        intentId: "text_to_speech",
        server: "replicate",
        provider: "replicate",
        methodId: "text_to_speech",
        voiceId: "English_expressive_narrator",
      }),
    ).toEqual({
      intentId: "text_to_speech",
      prompt: "I had hoped you wouldn't find out like this.",
      model: "minimax/speech-2.8-hd",
      extras: {
        voiceId: "English_expressive_narrator",
        geminiVoice: "English_expressive_narrator",
      },
    });
  });

  it("copies Gemini speaker and style even from a labeled model stamp", () => {
    expect(
      libraryAudioCloneSeed({
        prompt: "I had hoped you wouldn't find out like this.",
        generatedAt: "2026-01-01T00:00:00.000Z",
        creationId: "audio-2",
        mode: "none",
        model: "Gemini 3.1 Flash TTS",
        intentId: "text_to_speech",
        server: "replicate",
        provider: "replicate",
        methodId: "text_to_speech",
        voiceId: "Kore",
        stylePrompt: "warm, close-miked, unhurried",
      }),
    ).toEqual({
      intentId: "text_to_speech",
      prompt: "I had hoped you wouldn't find out like this.",
      model: "Gemini 3.1 Flash TTS",
      extras: {
        voiceId: "Kore",
        geminiVoice: "Kore",
        stylePrompt: "warm, close-miked, unhurried",
      },
    });
  });

  it("ignores video generations", () => {
    expect(
      libraryAudioCloneSeed({
        prompt: "a shot",
        generatedAt: "2026-01-01T00:00:00.000Z",
        creationId: "vid-1",
        mode: "start_frame",
        intentId: "image_to_video",
      }),
    ).toBeNull();
  });
});
