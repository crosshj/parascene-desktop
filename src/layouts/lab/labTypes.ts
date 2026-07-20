export type LabModuleId =
  | "groups"
  | "create"
  | "seeds"
  | "isolate"
  | "a2v"
  | "extend"
  | "mutate"
  | "openai"
  | "align"
  | "propose";

export const LAB_MODULES: {
  id: LabModuleId;
  label: string;
  blurb: string;
}[] = [
  { id: "groups", label: "Project groups", blurb: "Ensure Images + Videos groups" },
  { id: "create", label: "Parascene create", blurb: "Image (or video) create → Library" },
  { id: "seeds", label: "Upload / seeds", blurb: "Inspect seed URLs from project assets" },
  { id: "isolate", label: "Vocals / slice", blurb: "Full-track demucs + vocals slice" },
  { id: "a2v", label: "a2v compose", blurb: "Still + vocals slice → ltx_a2v" },
  { id: "extend", label: "Clip extend", blurb: "Loop / ping-pong / trim-loop" },
  { id: "mutate", label: "Image mutate", blurb: "i2i edit → Images group" },
  { id: "openai", label: "OpenAI raw", blurb: "Structured JSON round-trip" },
  { id: "align", label: "Lyric align", blurb: "Even-spaced draft timings (Lab)" },
  { id: "propose", label: "Storyboard propose", blurb: "OpenAI + shot catalog → scenes" },
];
