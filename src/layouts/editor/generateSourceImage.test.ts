import { describe, expect, it } from "vitest";
import {
  generateSourceFactsFromFrame,
  planGenerateSourceImage,
  type GenerateSourceImageFacts,
  type GenerateSourceTarget,
} from "./generateSourceImage";

const TARGETS: GenerateSourceTarget[] = [
  "parascene_blue",
  "blue_direct",
  "replicate",
];

function facts(partial: Partial<GenerateSourceImageFacts>): GenerateSourceImageFacts {
  return {
    target: "parascene_blue",
    hostedStill: true,
    inImagesGroup: true,
    videoStill: false,
    derivedPixels: false,
    ...partial,
  };
}

describe("planGenerateSourceImage", () => {
  it("never regroups the source in any of the four-question cases", () => {
    for (const hostedStill of [true, false]) {
      for (const inImagesGroup of [true, false]) {
        for (const target of TARGETS) {
          for (const videoStill of [true, false]) {
            for (const derivedPixels of [true, false]) {
              const plan = planGenerateSourceImage(
                facts({
                  hostedStill,
                  inImagesGroup,
                  target,
                  videoStill,
                  derivedPixels,
                }),
              );
              expect(plan.regroupSource).toBe(false);
            }
          }
        }
      }
    }
  });

  it("grouped vs not does not change the send path", () => {
    for (const hostedStill of [true, false]) {
      for (const target of TARGETS) {
        for (const videoStill of [true, false]) {
          for (const derivedPixels of [true, false]) {
            const grouped = planGenerateSourceImage(
              facts({
                hostedStill,
                inImagesGroup: true,
                target,
                videoStill,
                derivedPixels,
              }),
            );
            const loose = planGenerateSourceImage(
              facts({
                hostedStill,
                inImagesGroup: false,
                target,
                videoStill,
                derivedPixels,
              }),
            );
            expect(grouped.send).toBe(loose.send);
            expect(grouped.fileNewStillIntoImages).toBe(
              loose.fileNewStillIntoImages,
            );
            expect(grouped.durableId).toBe(loose.durableId);
          }
        }
      }
    }
  });

  it("uses a hosted project still as-is on Parascene (the 25019 case)", () => {
    const plan = planGenerateSourceImage(
      facts({
        target: "parascene_blue",
        hostedStill: true,
        inImagesGroup: true,
        videoStill: false,
        derivedPixels: false,
      }),
    );
    expect(plan).toEqual({
      send: "parascene_url",
      fileNewStillIntoImages: false,
      durableId: "source_asset",
      regroupSource: false,
    });
  });

  it("uploads a new still when Parascene needs derived pixels", () => {
    const fill = planGenerateSourceImage(
      facts({ derivedPixels: true, inImagesGroup: true }),
    );
    const localOnly = planGenerateSourceImage(
      facts({ hostedStill: false, videoStill: false }),
    );
    for (const plan of [fill, localOnly]) {
      expect(plan.send).toBe("upload_new_creation");
      expect(plan.fileNewStillIntoImages).toBe(true);
      expect(plan.durableId).toBe("new_creation");
      expect(plan.regroupSource).toBe(false);
    }
  });

  it("sends a video extract to ephemeral CDN and does not file Images", () => {
    const fromVideo = planGenerateSourceImage(
      facts({ videoStill: true, hostedStill: false, inImagesGroup: false }),
    );
    expect(fromVideo).toEqual({
      send: "upload_ephemeral",
      fileNewStillIntoImages: false,
      durableId: "ephemeral_url",
      regroupSource: false,
    });
  });

  it("sends local files to Blue and Replicate without grouping", () => {
    for (const target of ["blue_direct", "replicate"] as const) {
      const image = planGenerateSourceImage(facts({ target, inImagesGroup: true }));
      expect(image).toEqual({
        send: "local_file",
        fileNewStillIntoImages: false,
        durableId: "source_asset",
        regroupSource: false,
      });
      const extract = planGenerateSourceImage(
        facts({ target, videoStill: true, hostedStill: false }),
      );
      expect(extract.send).toBe("local_file");
      expect(extract.fileNewStillIntoImages).toBe(false);
      expect(extract.durableId).toBe("local_extract");
    }
  });
});

describe("generateSourceFactsFromFrame", () => {
  it("treats a fit Images-group still as hosted, not derived", () => {
    expect(
      generateSourceFactsFromFrame({
        target: "parascene_blue",
        sourceIsImage: true,
        sourceAssetId: "25019",
        parasceneImageUrl: "https://cdn.example/25019.png",
        framing: "fit",
        imagesGroupId: "18842",
        imagesGroupMemberIds: ["25019", "25020"],
      }),
    ).toEqual({
      target: "parascene_blue",
      hostedStill: true,
      inImagesGroup: true,
      videoStill: false,
      derivedPixels: false,
    });
  });

  it("treats a video extract as a video still even when the video is hosted", () => {
    expect(
      generateSourceFactsFromFrame({
        target: "parascene_blue",
        sourceIsImage: false,
        sourceAssetId: "vid-9",
        parasceneImageUrl: "https://cdn.example/poster.png",
        framing: "fit",
        imagesGroupId: "18842",
      }),
    ).toMatchObject({
      hostedStill: false,
      videoStill: true,
      derivedPixels: true,
    });
  });
});
