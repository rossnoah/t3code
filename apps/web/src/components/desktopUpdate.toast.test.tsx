import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({ addToast: vi.fn() }));
vi.mock("./ui/toast", () => ({ toastManager: { add: testState.addToast } }));

import { openDesktopUpdateReleaseNotes } from "./desktopUpdate.toast";

const releaseUrl = "https://github.com/rossnoah/t3code/releases/tag/v0.0.43-nightly.20260917.1";

describe("openDesktopUpdateReleaseNotes", () => {
  beforeEach(() => testState.addToast.mockReset());

  it("opens the selected release in the desktop shell", async () => {
    const openExternal = vi.fn().mockResolvedValue(true);
    await openDesktopUpdateReleaseNotes({ openExternal }, releaseUrl);
    expect(openExternal).toHaveBeenCalledWith(releaseUrl);
    expect(testState.addToast).not.toHaveBeenCalled();
  });

  it.each([
    ["returns false", vi.fn().mockResolvedValue(false)],
    ["rejects", vi.fn().mockRejectedValue(new Error("open failed"))],
  ])("reports failure when opening release notes %s", async (_description, openExternal) => {
    await openDesktopUpdateReleaseNotes({ openExternal }, releaseUrl);
    expect(testState.addToast).toHaveBeenCalledWith({
      type: "error",
      title: "Unable to open release notes",
    });
  });
});
