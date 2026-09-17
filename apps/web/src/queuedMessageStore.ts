import type {
  ModelSelection,
  PreviewAnnotationPayload,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";
import { create } from "zustand";

import type { LocalDispatchSnapshot } from "./components/ChatView.logic";
import type { ComposerSubmissionIntent } from "./composer-logic";
import type { ComposerFileAttachment, ComposerImageAttachment } from "./composerDraftStore";
import type { TerminalContextDraft } from "./lib/terminalContext";
import { randomUUID } from "./lib/utils";
import type { ReviewCommentContext } from "./reviewCommentContext";

/**
 * The composer's model and modes when the message was queued. The send uses
 * these instead of the live composer, so it can go out while the user is on
 * another thread.
 */
export interface QueuedMessageSendSettings {
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  /** Effort written into the prompt text, for providers that read it there. */
  promptEffort: string | null;
}

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
  sendSettings: QueuedMessageSendSettings;
  /**
   * Set while a send is under way; the row stays until it settles. Pausing
   * can still take a "preparing" message back (uploads, thread settings), but
   * not a "dispatching" one, whose turn start is already on the wire.
   */
  sending?: "preparing" | "dispatching";
  createdAt: string;
}

/**
 * The thread as it was when its last queued turn start went out. The next
 * message waits until the server has moved past it, so a send that starts a
 * new turn and the message after it do not leave on one boundary.
 */
interface QueuedDispatch {
  /** The message that went out, or null for a dispatch restored after a failure. */
  messageId: string | null;
  thread: LocalDispatchSnapshot;
  /** The dispatch this one replaced. If this send fails, that one still counts. */
  previous: LocalDispatchSnapshot | null;
}

interface QueuedMessageStoreState {
  queuesByThreadKey: Record<string, QueuedComposerMessage[]>;
  lastDispatchByThreadKey: Record<string, QueuedDispatch>;
  pausedByThreadKey: Record<string, boolean>;
  // Remember the completion that handed off to a queued send, even after
  // finishSend removes the last message and before notification effects observe it.
  suppressedCompletionByThreadKey: Record<string, number>;
  /** The thread whose queue is being dragged or edited. Nothing leaves it meanwhile. */
  interactingThreadKey: string | null;
  enqueue: (threadKey: string, message: Omit<QueuedComposerMessage, "id">) => QueuedComposerMessage;
  /**
   * Marks one message as sending and returns it, or null when it is gone or
   * the thread already has a send under way. `completedAt` is the finished
   * turn this send follows, whose completion alert it replaces.
   */
  beginSend: (
    threadKey: string,
    id: string,
    completedAt: string | null,
  ) => QueuedComposerMessage | null;
  /** The turn start is going out. False when a pause took the message back first. */
  markDispatching: (threadKey: string, id: string, thread: LocalDispatchSnapshot) => boolean;
  /** Drops a message whose send went out, or that had nothing left to send. */
  finishSend: (threadKey: string, id: string) => void;
  /**
   * Moves a message whose send failed back to the head and pauses the queue,
   * so nothing behind it overtakes. False when the message is already gone.
   */
  failSend: (threadKey: string, id: string) => boolean;
  /** Removes one message. Null when gone or sending. */
  remove: (threadKey: string, id: string) => QueuedComposerMessage | null;
  pause: (threadKey: string) => void;
  resume: (threadKey: string) => void;
  updatePrompt: (threadKey: string, id: string, prompt: string) => void;
  reorder: (threadKey: string, id: string, overId: string) => void;
  setInteracting: (threadKey: string, active: boolean) => void;
}

const EMPTY_QUEUE: QueuedComposerMessage[] = [];

type QueueState = Pick<QueuedMessageStoreState, "queuesByThreadKey" | "lastDispatchByThreadKey">;

/** Replaces one thread's queue. `lastDispatch` null forgets it; an empty queue always does. */
function withQueue(
  state: QueueState,
  threadKey: string,
  queue: QueuedComposerMessage[],
  lastDispatch?: QueuedDispatch | null,
): QueueState {
  const queuesByThreadKey = { ...state.queuesByThreadKey, [threadKey]: queue };
  const lastDispatchByThreadKey = { ...state.lastDispatchByThreadKey };
  if (lastDispatch) lastDispatchByThreadKey[threadKey] = lastDispatch;
  if (queue.length === 0) delete queuesByThreadKey[threadKey];
  if (queue.length === 0 || lastDispatch === null) delete lastDispatchByThreadKey[threadKey];
  return { queuesByThreadKey, lastDispatchByThreadKey };
}

/** Queues belong to this client session, scoped to an environment and thread. */
export const useQueuedMessageStore = create<QueuedMessageStoreState>()((set, get) => {
  const queueOf = (threadKey: string) => get().queuesByThreadKey[threadKey] ?? EMPTY_QUEUE;
  const update = (
    threadKey: string,
    queue: QueuedComposerMessage[],
    lastDispatch?: QueuedDispatch | null,
  ) => set((state) => withQueue(state, threadKey, queue, lastDispatch));
  return {
    queuesByThreadKey: {},
    lastDispatchByThreadKey: {},
    pausedByThreadKey: {},
    suppressedCompletionByThreadKey: {},
    interactingThreadKey: null,
    enqueue: (threadKey, message) => {
      const entry: QueuedComposerMessage = { ...message, id: randomUUID() };
      update(threadKey, [...queueOf(threadKey), entry]);
      return entry;
    },
    beginSend: (threadKey, id, completedAt) => {
      const queue = queueOf(threadKey);
      const entry = queue.find((message) => message.id === id);
      if (!entry || queue.some((message) => message.sending)) return null;
      update(
        threadKey,
        queue.map((message) => (message.id === id ? { ...message, sending: "preparing" } : message)),
      );
      const completion = Date.parse(completedAt ?? "");
      if (Number.isFinite(completion)) {
        set((state) => ({
          suppressedCompletionByThreadKey: {
            ...state.suppressedCompletionByThreadKey,
            [threadKey]: completion,
          },
        }));
      }
      return entry;
    },
    markDispatching: (threadKey, id, thread) => {
      const queue = queueOf(threadKey);
      if (!queue.some((message) => message.id === id && message.sending)) return false;
      update(
        threadKey,
        queue.map((message) =>
          message.id === id ? { ...message, sending: "dispatching" } : message,
        ),
        {
          messageId: id,
          thread,
          previous: get().lastDispatchByThreadKey[threadKey]?.thread ?? null,
        },
      );
      return true;
    },
    finishSend: (threadKey, id) => {
      const queue = queueOf(threadKey);
      if (!queue.some((message) => message.id === id)) return;
      update(
        threadKey,
        queue.filter((message) => message.id !== id),
      );
    },
    failSend: (threadKey, id) => {
      const queue = queueOf(threadKey);
      const entry = queue.find((message) => message.id === id);
      if (!entry) return false;
      const { sending: _sending, ...rest } = entry;
      // This send never reached the server, so only an earlier one is worth
      // waiting for.
      const dispatch = get().lastDispatchByThreadKey[threadKey];
      update(
        threadKey,
        [rest, ...queue.filter((message) => message.id !== id)],
        dispatch?.messageId !== id
          ? undefined
          : dispatch.previous && { messageId: null, thread: dispatch.previous, previous: null },
      );
      set((state) => ({ pausedByThreadKey: { ...state.pausedByThreadKey, [threadKey]: true } }));
      return true;
    },
    remove: (threadKey, id) => {
      const queue = queueOf(threadKey);
      const entry = queue.find((message) => message.id === id);
      if (!entry || entry.sending) return null;
      update(
        threadKey,
        queue.filter((message) => message.id !== id),
      );
      return entry;
    },
    pause: (threadKey) =>
      set((state) => {
        // A message still preparing (uploads, thread settings) goes back to
        // waiting; its send sees that at markDispatching and gives up.
        const queue = state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE;
        const hasPreparing = queue.some((message) => message.sending === "preparing");
        return {
          pausedByThreadKey: { ...state.pausedByThreadKey, [threadKey]: true },
          ...(hasPreparing
            ? withQueue(
                state,
                threadKey,
                queue.map(({ sending, ...message }) =>
                  sending === "dispatching" ? { ...message, sending } : message,
                ),
              )
            : {}),
        };
      }),
    resume: (threadKey) =>
      set((state) => ({
        pausedByThreadKey: { ...state.pausedByThreadKey, [threadKey]: false },
      })),
    updatePrompt: (threadKey, id, prompt) =>
      update(
        threadKey,
        queueOf(threadKey).map((message) =>
          message.id === id && !message.sending ? { ...message, prompt } : message,
        ),
      ),
    reorder: (threadKey, id, overId) => {
      const queue = queueOf(threadKey);
      if (id === overId) return;
      const from = queue.findIndex((message) => message.id === id);
      const to = queue.findIndex((message) => message.id === overId);
      if (from < 0 || to < 0) return;
      const reordered = [...queue];
      reordered.splice(to, 0, ...reordered.splice(from, 1));
      update(threadKey, reordered);
    },
    setInteracting: (threadKey, active) =>
      set((state) =>
        active
          ? { interactingThreadKey: threadKey }
          : state.interactingThreadKey === threadKey
            ? { interactingThreadKey: null }
            : {},
      ),
  };
});

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
