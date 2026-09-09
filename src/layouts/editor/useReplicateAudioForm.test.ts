import { describe, expect, it } from "vitest";
import { replicateSchemaVoiceField } from "./useReplicateAudioForm";

describe("replicateSchemaVoiceField", () => {
  it("does not throw when a Parascene model has fields and no inputs", () => {
    expect(replicateSchemaVoiceField({})).toBeUndefined();
    expect(replicateSchemaVoiceField(null)).toBeUndefined();
    expect(replicateSchemaVoiceField({ inputs: undefined })).toBeUndefined();
  });

  it("reads the Replicate Gemini voice enum", () => {
    const voice = { name: "voice" };
    expect(
      replicateSchemaVoiceField({
        inputs: [{ name: "prompt" }, voice],
      }),
    ).toBe(voice);
  });
});
