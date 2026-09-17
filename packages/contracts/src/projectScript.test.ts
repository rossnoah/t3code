import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { ProjectScript, PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "./orchestration.ts";
import { ServerSettingsPatch } from "./settings.ts";

const settingsCodec = Schema.fromJsonString(ServerSettingsPatch);
const decodeSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const encodeSettingsJson = Schema.encodeSync(settingsCodec);
const decodeSettingsJson = Schema.decodeUnknownSync(settingsCodec);
const decodeScript = Schema.decodeUnknownSync(ProjectScript);

const prompt = {
  id: "update-ticket",
  name: "Update Linear ticket",
  kind: "prompt",
  prompt: "Update the ticket with this thread's progress.",
  icon: "play",
  runOnWorktreeCreate: false,
};

describe("project prompt actions", () => {
  it("round trips through the settings wire format", () => {
    const patch = decodeSettingsPatch({
      defaultProjectScripts: [prompt],
    });
    const encoded = encodeSettingsJson(patch);
    expect(decodeSettingsJson(encoded)).toEqual(patch);
    expect(patch.defaultProjectScripts).toEqual([prompt]);
  });

  it("keeps legacy shell actions valid", () => {
    const shell = {
      id: "test",
      name: "Test",
      command: "bun test",
      icon: "test",
      runOnWorktreeCreate: true,
    };
    expect(decodeScript(shell)).toEqual(shell);
  });

  it("rejects empty prompts, automatic setup prompts, and missing prompt text", () => {
    expect(() => decodeScript({ ...prompt, prompt: " " })).toThrow();
    expect(() =>
      decodeScript({ ...prompt, prompt: "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS + 1) }),
    ).toThrow();
    expect(() => decodeScript({ ...prompt, runOnWorktreeCreate: true })).toThrow();
    expect(() => decodeScript({ ...prompt, prompt: undefined, command: "echo wrong" })).toThrow();
  });
});
