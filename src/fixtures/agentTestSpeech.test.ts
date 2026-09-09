import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_TEST_A2V_DURATION_SEC,
  AGENT_TEST_SPEECH_DURATION_SEC,
  AGENT_TEST_A2V_MODEL,
  AGENT_TEST_A2V_PROMPT,
  AGENT_TEST_SPEECH_MP3_PATH,
  AGENT_TEST_SPEECH_PATH,
  AGENT_TEST_SPEECH_SCRIPT,
  AGENT_TEST_SPEECH_TEXT,
  AGENT_TEST_STILL_MODEL,
  AGENT_TEST_STILL_PATH,
  AGENT_TEST_STILL_PROMPT,
  AGENT_TEST_VIDEO_PATH,
} from "./agentTestSpeech";

function wavDurationSec(buf: Buffer): number {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a WAVE file");
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let dataBytes = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt ") {
      channels = buf.readUInt16LE(start + 2);
      sampleRate = buf.readUInt32LE(start + 4);
      bits = buf.readUInt16LE(start + 14);
    } else if (id === "data") {
      dataBytes = size;
      break;
    }
    offset = start + size + (size % 2);
  }
  if (!sampleRate || !channels || !bits || !dataBytes) {
    throw new Error("incomplete WAVE");
  }
  return dataBytes / (sampleRate * channels * (bits / 8));
}

describe("agent test speech fixture", () => {
  it("is about 21 seconds of mono PCM, with a matching mp3", () => {
    const buf = readFileSync(AGENT_TEST_SPEECH_PATH);
    const duration = wavDurationSec(buf);
    expect(duration).toBeGreaterThan(AGENT_TEST_SPEECH_DURATION_SEC - 0.5);
    expect(duration).toBeLessThan(AGENT_TEST_SPEECH_DURATION_SEC + 0.5);
    expect(AGENT_TEST_SPEECH_DURATION_SEC).toBe(21);
    expect(existsSync(AGENT_TEST_SPEECH_MP3_PATH)).toBe(true);
    expect(statSync(AGENT_TEST_SPEECH_MP3_PATH).size).toBeGreaterThan(10_000);
    expect(AGENT_TEST_SPEECH_TEXT).toContain("Can you hear that?");
    expect(AGENT_TEST_SPEECH_SCRIPT).toHaveLength(4);
  });

  it("ships the generate still and muxed clip next to the wav", () => {
    expect(existsSync(AGENT_TEST_STILL_PATH)).toBe(true);
    expect(statSync(AGENT_TEST_STILL_PATH).size).toBeGreaterThan(10_000);
    const video = readFileSync(AGENT_TEST_VIDEO_PATH);
    expect(video.subarray(4, 8).toString("ascii")).toBe("ftyp");
    expect(video.length).toBeGreaterThan(10_000);
  });

  it("keeps Audio to Video on the generate project — same still, no second T2I", () => {
    const testSrc = readFileSync(
      join(process.cwd(), "integration/06-a2v.integration.test.ts"),
      "utf8",
    );
    expect(testSrc).toContain("requireGenerateJourney");
    expect(testSrc).toContain("AGENT_TEST_A2V_PROMPT");
    expect(testSrc).toContain("AGENT_TEST_A2V_DURATION_SEC");
    expect(testSrc).toContain("generate: false");
    expect(testSrc).toContain("captureHelpScreen");
    expect(testSrc).toContain("window.setSize");
    expect(testSrc).toContain("form: true");
    expect(testSrc).toContain("AGENT_TEST_EDITOR_A2V_FORM_SCREEN");
    expect(testSrc).toMatch(
      /captureHelpScreen\(AGENT_TEST_EDITOR_AUDIO_SCREEN\)[\s\S]+captureHelpScreen\(AGENT_TEST_EDITOR_A2V_FORM_SCREEN[\s\S]+captureHelpScreen\(AGENT_TEST_EDITOR_A2V_SCREEN\)/,
    );
    const a2vSrc = readFileSync(
      join(process.cwd(), "src/agent/runAgentA2v.ts"),
      "utf8",
    );
    expect(a2vSrc).toContain("setOpenProjectTimeline([audioClip])");
    expect(a2vSrc).toContain("must not already show a video clip");
    expect(a2vSrc).toContain("removeCreationsFromOpenProject");
    expect(a2vSrc).toContain("removeCreationsFromOpenProjectLocal");
    expect(a2vSrc).toContain("flushProjectStore");
    expect(a2vSrc).toContain("leftoverVideoIdsToHide");
    expect(a2vSrc).toContain("requestApplyEditorSelection");
    expect(a2vSrc).toContain('setMode("director")');
    expect(a2vSrc).toContain("setOpenProjectSelectedTimelineClipId(null)");
    expect(a2vSrc.indexOf("setOpenProjectTimeline([audioClip])")).toBeLessThan(
      a2vSrc.indexOf("setOpenProjectTimeline([videoClip, audioClip])"),
    );
    expect(testSrc).toContain("publishHelpMedia");
    expect(testSrc).toContain("sweepTestCreations");
    expect(testSrc).toContain("agent-test-speech");
    expect(testSrc).toContain("audioDurationSec");
    expect(testSrc).not.toContain("generation.start");
    expect(testSrc.indexOf("requireGenerateJourney")).toBeLessThan(
      testSrc.indexOf("library.import"),
    );
    const teardownSrc = readFileSync(
      join(process.cwd(), "integration/teardown.ts"),
      "utf8",
    );
    expect(teardownSrc).toContain("leftoverProjectsFromState");
    expect(teardownSrc.indexOf('invokeSweep(agent, "project.delete"')).toBeLessThan(
      teardownSrc.indexOf('invokeSweep(agent, "cloud.delete"'),
    );
    expect(AGENT_TEST_STILL_MODEL).toBe("xai/grok-imagine-image");
    expect(AGENT_TEST_A2V_MODEL).toBe("ltx_a2v");
    expect(AGENT_TEST_A2V_DURATION_SEC).toBe(9);
    expect(AGENT_TEST_STILL_PROMPT.toLowerCase()).toContain("goblin");
    expect(AGENT_TEST_STILL_PROMPT.toLowerCase()).toContain("purple");
    expect(AGENT_TEST_STILL_PROMPT.toLowerCase()).toContain("no headset");
    expect(AGENT_TEST_A2V_PROMPT.toLowerCase()).toContain("mouth");
    expect(AGENT_TEST_A2V_PROMPT.toLowerCase()).toContain("sync");
    expect(AGENT_TEST_A2V_PROMPT.toLowerCase()).toContain("no headset");

    const help = readFileSync(
      join(process.cwd(), "public/help/audio.html"),
      "utf8",
    );
    expect(help).toContain("desktop/media/agent-test-still.png");
    expect(help).toContain("desktop/media/agent-test-speech.mp3");
    expect(help).toContain("desktop/media/agent-test-speech.mp4");
    expect(help).toContain("desktop/screens/editor-audio-timeline.png");
    expect(help).toContain("desktop/screens/editor-a2v-form.png");
    expect(help).toContain("desktop/screens/editor-a2v.png");
    expect(help).toContain("video lane is still empty");
    expect(help).toContain(AGENT_TEST_A2V_PROMPT);
    expect(help).toContain(AGENT_TEST_A2V_MODEL);
    expect(help).toContain(AGENT_TEST_SPEECH_TEXT);
    expect(help).toContain("9 seconds");
    expect(help).toContain("don't trim");
    expect(help).toContain("Where to go from here");
    expect(help).not.toContain("xai/grok-imagine-image");
    expect(help).toContain('href="generate.html">Generate an image</a>');
    expect(help).not.toContain("Log in");
    expect(help).not.toMatch(/the (A2V |desktop )?test/i);
    expect(help).not.toContain("writes this screenshot");
  });
});
