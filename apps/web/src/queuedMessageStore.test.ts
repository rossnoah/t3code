import { ProviderInstanceId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { createLocalDispatchSnapshot } from "./components/ChatView.logic";
import {
  isQueuedCompletionSuppressed,
  isQueuedMessageDue,
  shouldQueueFollowUp,
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
    sendSettings: {
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      promptEffort: null,
    },
    createdAt: "2026-09-11T00:00:00.000Z",
  };
}
const queue = (key = "thread-a") => useQueuedMessageStore.getState().queuesByThreadKey[key] ?? [];
const paused = (key = "thread-a") =>
  useQueuedMessageStore.getState().pausedByThreadKey[key] ?? false;

describe("queuedMessageStore", () => {
  beforeEach(() => {
    useQueuedMessageStore.setState({
      queuesByThreadKey: {},
      lastDispatchByThreadKey: {},
      pausedByThreadKey: {},
      suppressedCompletionByThreadKey: {},
      interactingThreadKey: null,
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

  it("allows one send per thread", () => {
    const { enqueue, beginSend } = useQueuedMessageStore.getState();
    const first = enqueue("thread-a", makeMessage("first"));
    const second = enqueue("thread-a", makeMessage("second"));

    expect(beginSend("thread-a", first.id, null)?.prompt).toBe("first");
    expect(beginSend("thread-a", first.id, null)).toBeNull();
    expect(beginSend("thread-a", second.id, null)).toBeNull();
    expect(queue().map((message) => message.sending)).toEqual(["preparing", undefined]);
  });

  it("finishSend drops the sent message", () => {
    const { enqueue, beginSend, finishSend } = useQueuedMessageStore.getState();
    const first = enqueue("thread-a", makeMessage("first"));
    beginSend("thread-a", first.id, null);

    finishSend("thread-a", first.id);

    expect(useQueuedMessageStore.getState().queuesByThreadKey["thread-a"]).toBeUndefined();
  });

  it("returns failed sends to the head and pauses the whole queue", () => {
    const { enqueue, beginSend, failSend } = useQueuedMessageStore.getState();
    enqueue("thread-a", makeMessage("first"));
    const second = enqueue("thread-a", makeMessage("second"));
    beginSend("thread-a", second.id, null);

    expect(failSend("thread-a", second.id)).toBe(true);

    expect(queue().map((message) => message.prompt)).toEqual(["second", "first"]);
    expect(queue()[0]?.sending).toBeUndefined();
    expect(paused()).toBe(true);
  });

  it("remove refuses a message being sent", () => {
    const { enqueue, remove, beginSend } = useQueuedMessageStore.getState();
    const first = enqueue("thread-a", makeMessage("first"));
    const second = enqueue("thread-a", makeMessage("second"));

    expect(remove("thread-a", second.id)?.prompt).toBe("second");
    expect(remove("thread-a", second.id)).toBeNull();
    expect(queue()).toEqual([first]);

    beginSend("thread-a", first.id, null);
    expect(remove("thread-a", first.id)).toBeNull();
  });

  it("a failed send keeps waiting on the dispatch before it", () => {
    const { enqueue, beginSend, markDispatching, finishSend, failSend } =
      useQueuedMessageStore.getState();
    const earlier = createLocalDispatchSnapshot(undefined);
    const first = enqueue("thread-a", makeMessage("first"));
    const second = enqueue("thread-a", makeMessage("second"));
    const third = enqueue("thread-a", makeMessage("third"));
    const lastDispatch = () => useQueuedMessageStore.getState().lastDispatchByThreadKey["thread-a"];
    beginSend("thread-a", first.id, null);
    markDispatching("thread-a", first.id, earlier);
    finishSend("thread-a", first.id);

    // Fails before its turn start went out: the first send is still the one to wait on.
    beginSend("thread-a", second.id, null);
    failSend("thread-a", second.id);
    expect(lastDispatch()?.thread).toBe(earlier);

    // Fails after going out: it never reached the server, so the first still counts.
    beginSend("thread-a", third.id, null);
    markDispatching("thread-a", third.id, { ...earlier, startedAt: "later" });
    failSend("thread-a", third.id);
    expect(lastDispatch()?.thread).toBe(earlier);
  });

  it("pausing takes back a preparing send but not one already dispatching", () => {
    const { enqueue, beginSend, markDispatching, pause } = useQueuedMessageStore.getState();
    const preparing = enqueue("thread-a", makeMessage("preparing"));
    const waiting = enqueue("thread-a", makeMessage("waiting"));
    beginSend("thread-a", preparing.id, null);

    pause("thread-a");
    expect(queue()).toEqual([preparing, waiting]);
    expect(markDispatching("thread-a", preparing.id, createLocalDispatchSnapshot(undefined))).toBe(
      false,
    );

    const dispatching = enqueue("thread-b", makeMessage("dispatching"));
    beginSend("thread-b", dispatching.id, null);
    markDispatching("thread-b", dispatching.id, createLocalDispatchSnapshot(undefined));
    pause("thread-b");
    expect(queue("thread-b")[0]?.sending).toBe("dispatching");
  });

  it("pauses without moving messages and keeps later submissions paused", () => {
    const { enqueue, pause, resume } = useQueuedMessageStore.getState();
    const first = enqueue("thread-a", makeMessage("first"));
    pause("thread-a");
    const second = enqueue("thread-a", makeMessage("second"));
    expect(queue()).toEqual([first, second]);
    expect(paused()).toBe(true);
    resume("thread-a");
    expect(queue()).toEqual([first, second]);
    expect(paused()).toBe(false);
  });

  it("starts a fresh queue unpaused after Stop with no queued messages", () => {
    const { enqueue, pause } = useQueuedMessageStore.getState();
    pause("thread-a");
    const message = enqueue("thread-a", makeMessage("follow-up after restarting"));

    expect(queue()).toEqual([message]);
    expect(isQueuedMessageDue({ phase: "running", paused: paused() })).toBe(false);
    expect(isQueuedMessageDue({ phase: "ready", paused: paused() })).toBe(true);
    expect(
      shouldQueueFollowUp({
        isRunning: true,
        hasQueuedMessages: false,
        paused: paused(),
        followUpBehavior: "steer",
      }),
    ).toBe(false);
  });

  it.each(["remove", "send"] as const)(
    "starts a fresh queue unpaused after %s empties a paused queue",
    (action) => {
      const { enqueue, pause, remove, beginSend, finishSend } = useQueuedMessageStore.getState();
      const previous = enqueue("thread-a", makeMessage("previous"));
      pause("thread-a");
      if (action === "remove") remove("thread-a", previous.id);
      else {
        beginSend("thread-a", previous.id, null);
        finishSend("thread-a", previous.id);
      }
      expect(paused()).toBe(false);
      const next = enqueue("thread-a", makeMessage("next"));

      expect(queue()).toEqual([next]);
      expect(isQueuedMessageDue({ phase: "ready", paused: paused() })).toBe(true);
    },
  );

  it("clearing a failed queue does not pause a fresh queue or another thread", () => {
    const { enqueue, beginSend, failSend, pause, remove } = useQueuedMessageStore.getState();
    const failed = enqueue("thread-a", makeMessage("failed send"));
    const other = enqueue("thread-b", makeMessage("other thread"));
    pause("thread-b");
    beginSend("thread-a", failed.id, null);
    failSend("thread-a", failed.id);
    remove("thread-a", failed.id);
    enqueue("thread-a", makeMessage("fresh follow-up"));

    expect(paused()).toBe(false);
    expect(paused("thread-b")).toBe(true);
    expect(queue("thread-b")).toEqual([other]);
  });

  it("sending a selected message immediately leaves a paused queue paused", () => {
    const { enqueue, pause, beginSend, finishSend } = useQueuedMessageStore.getState();
    const first = enqueue("thread-a", makeMessage("first"));
    const second = enqueue("thread-a", makeMessage("second"));
    pause("thread-a");
    beginSend("thread-a", second.id, null);
    finishSend("thread-a", second.id);
    expect(queue()).toEqual([first]);
    expect(paused()).toBe(true);
  });

  it("suppresses the completion alert of the turn a queued send follows", () => {
    const { enqueue, beginSend, finishSend } = useQueuedMessageStore.getState();
    const completedAt = "2026-09-11T00:01:00.000Z";
    const message = enqueue("thread-a", makeMessage("next"));
    expect(isQueuedCompletionSuppressed("thread-a", 0)).toBe(true);
    beginSend("thread-a", message.id, completedAt);
    finishSend("thread-a", message.id);
    expect(isQueuedCompletionSuppressed("thread-a", Date.parse(completedAt))).toBe(true);
    expect(isQueuedCompletionSuppressed("thread-a", Date.parse(completedAt) + 1)).toBe(false);
  });

  it("holds only the thread being dragged or edited", () => {
    const { setInteracting } = useQueuedMessageStore.getState();
    setInteracting("thread-a", true);
    setInteracting("thread-b", false);
    expect(useQueuedMessageStore.getState().interactingThreadKey).toBe("thread-a");
    setInteracting("thread-a", false);
    expect(useQueuedMessageStore.getState().interactingThreadKey).toBeNull();
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

describe("follow-up behavior", () => {
  it("queues running follow-ups by default and steers when requested", () => {
    const state = { isRunning: true, hasQueuedMessages: false, paused: false };
    expect(shouldQueueFollowUp({ ...state, followUpBehavior: "queue" })).toBe(true);
    expect(shouldQueueFollowUp({ ...state, followUpBehavior: "steer" })).toBe(false);
  });

  it("reverses the follow-up preference for the alternate send shortcut", () => {
    const state = {
      isRunning: true,
      hasQueuedMessages: false,
      paused: false,
      submissionIntent: "alternate" as const,
    };
    expect(shouldQueueFollowUp({ ...state, followUpBehavior: "queue" })).toBe(false);
    expect(shouldQueueFollowUp({ ...state, followUpBehavior: "steer" })).toBe(true);
  });

  it.each(["queue", "steer"] as const)(
    "keeps alternate submissions in a paused queue with %s selected",
    (followUpBehavior) => {
      expect(
        shouldQueueFollowUp({
          isRunning: true,
          hasQueuedMessages: true,
          paused: true,
          followUpBehavior,
          submissionIntent: "alternate",
        }),
      ).toBe(true);
    },
  );

  it.each([true, false])(
    "keeps a paused queue paused with steering enabled (running: %s)",
    (isRunning) => {
      expect(
        shouldQueueFollowUp({
          isRunning,
          hasQueuedMessages: true,
          paused: true,
          followUpBehavior: "steer",
        }),
      ).toBe(true);
    },
  );

  it("keeps new messages behind a waiting queue unless steering is selected", () => {
    const state = { isRunning: false, hasQueuedMessages: true, paused: false };
    expect(shouldQueueFollowUp({ ...state, followUpBehavior: "queue" })).toBe(true);
    expect(shouldQueueFollowUp({ ...state, followUpBehavior: "steer" })).toBe(false);
  });

  it("sends normally when no turn or queued messages are waiting", () => {
    const state = { isRunning: false, hasQueuedMessages: false, paused: false };
    expect(shouldQueueFollowUp({ ...state, followUpBehavior: "queue" })).toBe(false);
    expect(shouldQueueFollowUp({ ...state, followUpBehavior: "steer" })).toBe(false);
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
