export type LabModuleId =
  | "groups"
  | "create"
  | "seeds"
  | "isolate"
  | "a2v"
  | "extend"
  | "frame"
  | "mutate"
  | "openai"
  | "align"
  | "mvConcept"
  | "mvBudget"
  | "mvScenes";

export const LAB_MODULES: {
  id: LabModuleId;
  label: string;
  blurb: string;
}[] = [
  { id: "groups", label: "Project groups", blurb: "Ensure Images or Videos group" },
  { id: "create", label: "Parascene create", blurb: "Image (or video) create → Library" },
  { id: "seeds", label: "Upload / seeds", blurb: "Inspect seed URLs from project assets" },
  { id: "isolate", label: "Vocals / slice", blurb: "Full-track demucs + vocals slice" },
  { id: "a2v", label: "a2v compose", blurb: "Still + vocals slice → ltx_a2v" },
  { id: "extend", label: "Clip extend", blurb: "Loop / ping-pong / trim-loop" },
  { id: "frame", label: "Pull frame", blurb: "Still from video → Images group" },
  { id: "mutate", label: "Image mutate", blurb: "i2i edit → Images group" },
  { id: "openai", label: "OpenAI raw", blurb: "Structured JSON round-trip" },
  { id: "align", label: "Lyric align", blurb: "Vocals STT + lyrics → timed captions" },
  { id: "mvConcept", label: "MV Concept", blurb: "Brainstorm or lock creative direction" },
  { id: "mvBudget", label: "MV Budget", blurb: "Plan generation budget from concept" },
  { id: "mvScenes", label: "MV Scenes", blurb: "Propose timed scenes + timeline" },
];
