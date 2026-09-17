import type { PreviewAnnotationPayload } from "@t3tools/contracts";
import { create } from "zustand";

import type { ComposerSubmissionIntent } from "./composer-logic";
import type { ComposerFileAttachment, ComposerImageAttachment } from "./composerDraftStore";
import type { TerminalContextDraft } from "./lib/terminalContext";
import { randomUUID } from "./lib/utils";
import type { ReviewCommentContext } from "./reviewCommentContext";

/**
 * A composer submission held back while the thread's turn is running. It
 * carries the full draft snapshot so the send path can dispatch it later with
 * the same text, attachments, and contexts the user pressed Enter on.
 */
export interface QueuedComposerMessage {
  id: string;
  prompt: string;
  images: ComposerImageAttachment[];
  files: ComposerFileAttachment[];
  terminalContexts: TerminalContextDraft[];
  previewAnnotations: PreviewAnnotationPayload[];
  reviewComments: ReviewCommentContext[];
  submissionIntent: ComposerSubmissionIntent;
  createdAt: string;
}

interface QueuedMessageStoreState {
  queuesByThreadKey: Record<string, QueuedComposerMessage[]>;
  pausedByThreadKey: Record<string, boolean>;
  pauseGenerationByThreadKey: Record<string, number>;
  // Remember the completion that handed off to a queued send, even after
  // take removes the last message and before notification effects observe it.
  suppressedCompletionByThreadKey: Record<string, number>;
  enqueue: (threadKey: string, message: Omit<QueuedComposerMessage, "id">) => QueuedComposerMessage;
  take: (
    threadKey: string,
    id: string,
    completedAt?: string | null,
  ) => QueuedComposerMessage | null;
  remove: (threadKey: string, id: string) => QueuedComposerMessage | null;
  holdAtFront: (threadKey: string, message: QueuedComposerMessage) => void;
  pause: (threadKey: string) => void;
  resume: (threadKey: string) => void;
  updatePrompt: (threadKey: string, id: string, prompt: string) => void;
  reorder: (threadKey: string, id: string, overId: string) => void;
}

const EMPTY_QUEUE: QueuedComposerMessage[] = [];

/** Queues belong to this client session, scoped to an environment and thread. */
export const useQueuedMessageStore = create<QueuedMessageStoreState>()((set, get) => ({
  queuesByThreadKey: {},
  pausedByThreadKey: {},
  pauseGenerationByThreadKey: {},
  suppressedCompletionByThreadKey: {},
  enqueue: (threadKey, message) => {
    const entry = { ...message, id: randomUUID() };
    set((state) => ({
      queuesByThreadKey: {
        ...state.queuesByThreadKey,
        [threadKey]: [...(state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE), entry],
      },
    }));
    return entry;
  },
  take: (threadKey, id, completedAt) => {
    if (!get().queuesByThreadKey[threadKey]?.some((message) => message.id === id)) return null;
    const completion = Date.parse(completedAt ?? "");
    if (Number.isFinite(completion)) {
      set((state) => ({
        suppressedCompletionByThreadKey: {
          ...state.suppressedCompletionByThreadKey,
          [threadKey]: completion,
        },
      }));
    }
    return get().remove(threadKey, id);
  },
  remove: (threadKey, id) => {
    const queue = get().queuesByThreadKey[threadKey];
    const entry = queue?.find((message) => message.id === id);
    if (!queue || !entry) return null;
    set((state) => {
      const remaining = queue.filter((message) => message.id !== id);
      const queuesByThreadKey = { ...state.queuesByThreadKey };
      if (remaining.length === 0) delete queuesByThreadKey[threadKey];
      else queuesByThreadKey[threadKey] = remaining;
      return { queuesByThreadKey };
    });
    return entry;
  },
  holdAtFront: (threadKey, message) => {
    set((state) => ({
      queuesByThreadKey: {
        ...state.queuesByThreadKey,
        [threadKey]: [
          message,
          ...(state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE).filter(
            (entry) => entry.id !== message.id,
          ),
        ],
      },
      pausedByThreadKey: { ...state.pausedByThreadKey, [threadKey]: true },
    }));
  },
  pause: (threadKey) =>
    set((state) => ({
      pausedByThreadKey: { ...state.pausedByThreadKey, [threadKey]: true },
      // Even an empty queue can have a message awaiting an upload. Scope the
      // cancellation to this thread so stopping another chat cannot cancel it.
      pauseGenerationByThreadKey: {
        ...state.pauseGenerationByThreadKey,
        [threadKey]: (state.pauseGenerationByThreadKey[threadKey] ?? 0) + 1,
      },
    })),
  resume: (threadKey) =>
    set((state) => ({
      pausedByThreadKey: { ...state.pausedByThreadKey, [threadKey]: false },
    })),
  updatePrompt: (threadKey, id, prompt) =>
    set((state) => ({
      queuesByThreadKey: {
        ...state.queuesByThreadKey,
        [threadKey]: (state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE).map((message) =>
          message.id === id ? { ...message, prompt } : message,
        ),
      },
    })),
  reorder: (threadKey, id, overId) => {
    const queue = get().queuesByThreadKey[threadKey];
    if (!queue || id === overId) return;
    const from = queue.findIndex((message) => message.id === id);
    const to = queue.findIndex((message) => message.id === overId);
    if (from < 0 || to < 0) return;
    const reordered = [...queue];
    reordered.splice(to, 0, ...reordered.splice(from, 1));
    set((state) => ({ queuesByThreadKey: { ...state.queuesByThreadKey, [threadKey]: reordered } }));
  },
}));

/** A paused queue keeps new follow-ups even when immediate steering is enabled. */
export function shouldQueueFollowUp(input: {
  isRunning: boolean;
  hasQueuedMessages: boolean;
  paused: boolean;
  followUpBehavior: "queue" | "steer";
  submissionIntent?: ComposerSubmissionIntent;
}): boolean {
  return (
    (input.isRunning || input.hasQueuedMessages) &&
    (input.paused ||
      (input.followUpBehavior === "queue") !== (input.submissionIntent === "alternate"))
  );
}

/** Wait for the whole turn. A resumed interrupted session can start a new turn. */
export function isQueuedMessageDue(input: {
  paused: boolean;
  phase: "connecting" | "running" | "ready" | "disconnected";
}): boolean {
  return !input.paused && input.phase !== "running" && input.phase !== "connecting";
}

export function useQueuedMessages(threadKey: string): QueuedComposerMessage[] {
  return useQueuedMessageStore((state) => state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE);
}

/** Read at notification time; draining or deleting a queue must not replay old alerts. */
export function isQueuedCompletionSuppressed(threadKey: string, completedAt: number): boolean {
  const state = useQueuedMessageStore.getState();
  return (
    (state.queuesByThreadKey[threadKey]?.length ?? 0) > 0 ||
    state.suppressedCompletionByThreadKey[threadKey] === completedAt
  );
}
