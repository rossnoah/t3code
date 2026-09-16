import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  isQueuedMessageDue,
  useQueuedMessageStore,
  type QueuedComposerMessage,
} from "./queuedMessageStore";

function makeMessage(prompt: string): Omit<QueuedComposerMessage, "id"> {
  return {
    prompt,
    images: [],
    files: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    submissionIntent: "foreground",
    createdAt: "2026-09-11T00:00:00.000Z",
  };
}
const queue = (key = "thread-a") => useQueuedMessageStore.getState().queuesByThreadKey[key] ?? [];

describe("queuedMessageStore", () => {
  beforeEach(() => {
    useQueuedMessageStore.setState({
      queuesByThreadKey: {},
      pausedByThreadKey: {},
      pauseGenerationByThreadKey: {},
      suppressedCompletionByThreadKey: {},
    });
  });

  it("keeps messages in submission order per thread", () => {
    const { enqueue } = useQueuedMessageStore.getState();
    enqueue("thread-a", makeMessage("first"));
    enqueue("thread-a", makeMessage("second"));
    enqueue("thread-b", makeMessage("other"));
    expect(queue().map((message) => message.prompt)).toEqual(["first", "second"]);
    expect(queue("thread-b").map((message) => message.prompt)).toEqual(["other"]);
  });

  it("hands a message to exactly one sender", () => {
    const { enqueue, take } = useQueuedMessageStore.getState();
    const first = enqueue("thread-a", makeMessage("first"));
    const second = enqueue("thread-a", makeMessage("second"));
    expect(take("thread-a", first.id)).toEqual(first);
    expect(take("thread-a", first.id)).toBeNull();
    expect(queue()).toEqual([second]);
  });

  it("pauses without moving messages and keeps later submissions paused", () => {
    const { enqueue, pause, resume } = useQueuedMessageStore.getState();
    const first = enqueue("thread-a", makeMessage("first"));
    pause("thread-a");
    const second = enqueue("thread-a", makeMessage("second"));
    expect(queue()).toEqual([first, second]);
    expect(useQueuedMessageStore.getState().pausedByThreadKey["thread-a"]).toBe(true);
    resume("thread-a");
    expect(queue()).toEqual([first, second]);
    expect(useQueuedMessageStore.getState().pausedByThreadKey["thread-a"]).toBe(false);
  });

  it("sending a selected message immediately leaves a paused queue paused", () => {
    const { enqueue, pause, take } = useQueuedMessageStore.getState();
    const first = enqueue("thread-a", makeMessage("first"));
    const second = enqueue("thread-a", makeMessage("second"));
    pause("thread-a");
    expect(take("thread-a", second.id)).toEqual(second);
    expect(queue()).toEqual([first]);
    expect(useQueuedMessageStore.getState().pausedByThreadKey["thread-a"]).toBe(true);
  });

  it("keeps new submissions paused after Stop until explicitly resumed", () => {
    const { enqueue, pause, resume } = useQueuedMessageStore.getState();
    pause("thread-a");
    const message = enqueue("thread-a", makeMessage("follow-up after restarting"));

    expect(queue()).toEqual([message]);
    expect(
      isQueuedMessageDue({
        phase: "ready",
        paused: useQueuedMessageStore.getState().pausedByThreadKey["thread-a"] ?? false,
      }),
    ).toBe(false);
    resume("thread-a");
    expect(queue()).toEqual([message]);
    expect(
      isQueuedMessageDue({
        phase: "ready",
        paused: useQueuedMessageStore.getState().pausedByThreadKey["thread-a"] ?? false,
      }),
    ).toBe(true);
  });

  it.each(["remove", "take"] as const)(
    "keeps new submissions paused after %s empties a paused queue",
    (action) => {
      const { enqueue, pause } = useQueuedMessageStore.getState();
      const previous = enqueue("thread-a", makeMessage("previous"));
      pause("thread-a");
      useQueuedMessageStore.getState()[action]("thread-a", previous.id);
      const next = enqueue("thread-a", makeMessage("next"));

      expect(queue()).toEqual([next]);
      expect(useQueuedMessageStore.getState().pausedByThreadKey["thread-a"]).toBe(true);
    },
  );

  it("keeps a stopped upload cancelled when a new queue starts before it returns", () => {
    const { enqueue, take, pause, holdAtFront } = useQueuedMessageStore.getState();
    const uploading = enqueue("thread-a", makeMessage("upload"));
    take("thread-a", uploading.id);
    const generationAtTake =
      useQueuedMessageStore.getState().pauseGenerationByThreadKey["thread-a"] ?? 0;
    pause("thread-a");
    const next = enqueue("thread-a", makeMessage("next"));

    expect(useQueuedMessageStore.getState().pauseGenerationByThreadKey["thread-a"]).toBe(
      generationAtTake + 1,
    );
    holdAtFront("thread-a", uploading);
    expect(queue()).toEqual([uploading, next]);
    expect(useQueuedMessageStore.getState().pausedByThreadKey["thread-a"]).toBe(true);
  });

  it("invalidates an in-flight upload even when it took the last queued message", () => {
    const { enqueue, take, pause, resume } = useQueuedMessageStore.getState();
    const message = enqueue("thread-a", makeMessage("upload"));
    take("thread-a", message.id);
    pause("thread-b");
    expect(useQueuedMessageStore.getState().pauseGenerationByThreadKey["thread-a"] ?? 0).toBe(0);
    pause("thread-a");
    resume("thread-a");
    expect(useQueuedMessageStore.getState().pauseGenerationByThreadKey["thread-a"]).toBe(1);
    expect(useQueuedMessageStore.getState().pauseGenerationByThreadKey["thread-b"]).toBe(1);
  });

  it("returns failed sends to the head and pauses the whole queue", () => {
    const { enqueue, take, holdAtFront, reorder } = useQueuedMessageStore.getState();
    const first = enqueue("thread-a", makeMessage("first"));
    const second = enqueue("thread-a", makeMessage("second"));
    take("thread-a", first.id);
    holdAtFront("thread-a", first);
    holdAtFront("thread-a", first);
    expect(queue()).toEqual([first, second]);
    reorder("thread-a", first.id, second.id);
    expect(queue()).toEqual([second, first]);
    expect(useQueuedMessageStore.getState().pausedByThreadKey["thread-a"]).toBe(true);
  });

  it("reorders both directions without changing payloads or other threads", () => {
    const { enqueue, reorder } = useQueuedMessageStore.getState();
    const first = enqueue("thread-a", makeMessage("first"));
    const second = enqueue("thread-a", makeMessage("second"));
    const third = enqueue("thread-a", makeMessage("third"));
    const other = enqueue("thread-b", makeMessage("other"));
    reorder("thread-a", third.id, first.id);
    expect(queue()).toEqual([third, first, second]);
    reorder("thread-a", third.id, second.id);
    expect(queue()).toEqual([first, second, third]);
    reorder("thread-a", other.id, first.id);
    reorder("thread-a", first.id, "deleted");
    expect(queue()).toEqual([first, second, third]);
    expect(queue("thread-b")).toEqual([other]);
  });

  it("edits only the selected prompt, retaining attachments and contexts", () => {
    const { enqueue, updatePrompt, remove } = useQueuedMessageStore.getState();
    const first = enqueue("thread-a", makeMessage("first"));
    const second = enqueue("thread-a", makeMessage("second"));
    updatePrompt("thread-a", first.id, "changed");
    expect(queue()).toEqual([{ ...first, prompt: "changed" }, second]);
    expect(queue()[0]?.images).toBe(first.images);
    expect(queue()[0]?.terminalContexts).toBe(first.terminalContexts);
    remove("thread-a", first.id);
    updatePrompt("thread-a", first.id, "late edit");
    expect(queue()).toEqual([second]);
    remove("thread-a", second.id);
    expect(useQueuedMessageStore.getState().queuesByThreadKey["thread-a"]).toBeUndefined();
  });
});

describe("queued message dispatch timing", () => {
  it.each(["running", "connecting"] as const)(
    "waits while %s, regardless of tool completions",
    (phase) => {
      expect(isQueuedMessageDue({ phase, paused: false })).toBe(false);
    },
  );
  it("can resume after Stop leaves the provider disconnected", () => {
    expect(isQueuedMessageDue({ phase: "disconnected", paused: true })).toBe(false);
    expect(isQueuedMessageDue({ phase: "disconnected", paused: false })).toBe(true);
  });
  it("sends only when the session is ready and the queue is resumed", () => {
    expect(isQueuedMessageDue({ phase: "ready", paused: true })).toBe(false);
    expect(isQueuedMessageDue({ phase: "ready", paused: false })).toBe(true);
  });
});
