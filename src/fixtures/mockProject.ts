import type { Project, ProjectRepository } from "../project/types";

/** Development-only mock project. Do not treat as production data. */
export const mockProject: Project = {
  id: "fixture-project-1",
  title: "Sample sequence",
  aspectRatio: "16:9",
  scenes: [
    { id: "s1", title: "Opening", durationLabel: "0:08" },
    { id: "s2", title: "Interview A", durationLabel: "0:24" },
    { id: "s3", title: "B-roll city", durationLabel: "0:12" },
    { id: "s4", title: "Close", durationLabel: "0:06" },
  ],
  assets: [
    { id: "a1", name: "cam_a.mp4", kind: "video", durationLabel: "0:24" },
    { id: "a2", name: "cam_b.mp4", kind: "video", durationLabel: "0:18" },
    { id: "a3", name: "voiceover.wav", kind: "audio", durationLabel: "1:12" },
    { id: "a4", name: "logo.png", kind: "image" },
  ],
  folderIds: [],
  imagesGroupId: null,
  videosGroupId: null,
  labStillPrompt: null,
  labAnimatePrompt: null,
  mainAudioCreationId: null,
  lyricAlignment: null,
  timeline: [
    { id: "c1", label: "Opening", startSec: 0, endSec: 8 },
    { id: "c2", label: "Interview A", startSec: 8, endSec: 32 },
    { id: "c3", label: "B-roll", startSec: 32, endSec: 44 },
  ],
  selectedTimelineClipId: null,
  selectedAssetId: null,
  timelineZoom: 1,
  timelineMonitorActive: false,
  timelinePlayheadSec: 0,
  hookSuggestions: [
    {
      id: "h1",
      text: "What if the first line was the whole story?",
    },
    {
      id: "h2",
      text: "Nine seconds. One decision. Cut everything else.",
    },
    {
      id: "h3",
      text: "Start on the reaction — reveal the setup after.",
    },
  ],
};

export class FixtureProjectRepository implements ProjectRepository {
  getProject(): Project {
    return mockProject;
  }
}

export const defaultProjectRepository = new FixtureProjectRepository();
