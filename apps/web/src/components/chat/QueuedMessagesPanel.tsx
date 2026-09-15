import { useState } from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowUpIcon,
  ChevronDownIcon,
  GripVerticalIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  Trash2Icon,
} from "lucide-react";

import { type QueuedComposerMessage, useQueuedMessageStore } from "../../queuedMessageStore";
import { releaseDraftAttachments } from "../../lib/attachmentUploadQueue";
import { Button } from "../ui/button";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";

export function QueuedMessagesPanel({
  threadKey,
  messages,
  paused,
  sendDisabled,
  onSendNow,
  onInteractionChange,
}: {
  threadKey: string;
  messages: QueuedComposerMessage[];
  paused: boolean;
  sendDisabled: boolean;
  onSendNow: (id: string) => void;
  onInteractionChange: (active: boolean) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const pause = useQueuedMessageStore((state) => state.pause);
  const resume = useQueuedMessageStore((state) => state.resume);
  const reorder = useQueuedMessageStore((state) => state.reorder);
  const remove = useQueuedMessageStore((state) => state.remove);
  const updatePrompt = useQueuedMessageStore((state) => state.updatePrompt);
  return (
    <section
      aria-label="Message queue"
      className="mx-2 -mb-5 overflow-hidden rounded-t-xl border border-border bg-background pb-5"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm text-muted-foreground"
          disabled={editingId !== null}
          aria-expanded={!collapsed}
          aria-controls="queued-message-list"
          onClick={() => setCollapsed(!collapsed)}
        >
          <span>
            {paused ? "Queue paused" : "Queued"}{" "}
            <span className="text-xs">({messages.length})</span>
          </span>
          <ChevronDownIcon className={`size-4 ${collapsed ? "-rotate-90" : ""}`} />
        </button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={editingId !== null}
          onClick={() => (paused ? resume(threadKey) : pause(threadKey))}
        >
          {paused ? <PlayIcon className="size-3.5" /> : <PauseIcon className="size-3.5" />}
          {paused ? "Resume" : "Pause"}
        </Button>
      </div>
      <div
        id="queued-message-list"
        hidden={collapsed}
        className="max-h-[min(30vh,16rem)] overflow-y-auto p-1.5"
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={() => onInteractionChange(true)}
          onDragCancel={() => onInteractionChange(false)}
          onDragEnd={({ active, over }) => {
            if (over) reorder(threadKey, String(active.id), String(over.id));
            onInteractionChange(false);
          }}
        >
          <SortableContext
            items={messages.map((message) => message.id)}
            strategy={verticalListSortingStrategy}
          >
            {messages.map((message) => (
              <QueuedMessageRow
                key={message.id}
                message={message}
                editing={editingId === message.id}
                dragDisabled={editingId !== null}
                sendDisabled={sendDisabled || editingId !== null}
                onSendNow={() => onSendNow(message.id)}
                onDelete={() => {
                  const removed = remove(threadKey, message.id);
                  if (!removed) return;
                  releaseDraftAttachments([...removed.images, ...removed.files]);
                  for (const image of removed.images) {
                    if (image.previewUrl.startsWith("blob:")) URL.revokeObjectURL(image.previewUrl);
                  }
                }}
                onEdit={() => {
                  setEditingId(message.id);
                  onInteractionChange(true);
                }}
                onFinishEdit={(prompt) => {
                  if (prompt !== null) updatePrompt(threadKey, message.id, prompt);
                  setEditingId(null);
                  onInteractionChange(false);
                }}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>
    </section>
  );
}

function QueuedMessageRow({
  message,
  editing,
  dragDisabled,
  sendDisabled,
  onSendNow,
  onDelete,
  onEdit,
  onFinishEdit,
}: {
  message: QueuedComposerMessage;
  editing: boolean;
  dragDisabled: boolean;
  sendDisabled: boolean;
  onSendNow: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onFinishEdit: (prompt: string | null) => void;
}) {
  const [prompt, setPrompt] = useState(message.prompt);
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: message.id, disabled: dragDisabled });
  const attachmentCount = message.images.length + message.files.length;
  const contextCount =
    message.terminalContexts.length +
    message.previewAnnotations.length +
    message.reviewComments.length;
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-queued-message-id={message.id}
      className={`group/queue-row relative flex items-start gap-1 rounded-lg px-1 py-2 hover:bg-muted/60 focus-within:bg-muted/60 ${isDragging ? "z-10 bg-muted shadow-md" : ""}`}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        {...attributes}
        {...listeners}
        aria-label="Drag to reorder message"
        className="mt-0.5 touch-none rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
        disabled={dragDisabled}
      >
        <GripVerticalIcon className="size-3.5" />
      </button>
      <div className="min-w-0 flex-1">
        {editing ? (
          <>
            <textarea
              aria-label="Edit queued message"
              autoFocus
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  onFinishEdit(null);
                }
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  onFinishEdit(prompt);
                }
              }}
              className="min-h-20 w-full resize-y rounded-md border border-border bg-background px-2 py-1 text-sm outline-none focus:border-ring"
            />
            <div className="mt-1 flex justify-end gap-1">
              <Button type="button" size="xs" variant="ghost" onClick={() => onFinishEdit(null)}>
                Cancel
              </Button>
              <Button type="button" size="xs" onClick={() => onFinishEdit(prompt)}>
                Save
              </Button>
            </div>
          </>
        ) : (
          <div className="whitespace-pre-wrap break-words px-1 py-1 text-sm">
            {message.prompt || (attachmentCount ? "Attachments" : "Context")}
          </div>
        )}
        {attachmentCount + contextCount > 0 ? (
          <div className="px-1 text-xs text-muted-foreground">
            {[
              attachmentCount
                ? `${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`
                : null,
              contextCount ? `${contextCount} context item${contextCount === 1 ? "" : "s"}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        ) : null}
      </div>
      {!editing ? (
        <div className="flex shrink-0 items-center sm:opacity-0 sm:group-hover/queue-row:opacity-100 sm:group-focus-within/queue-row:opacity-100">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Edit queued message"
                  disabled={dragDisabled}
                  onClick={() => {
                    setPrompt(message.prompt);
                    onEdit();
                  }}
                />
              }
            >
              <PencilIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup>Edit</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Delete queued message"
                  onClick={onDelete}
                />
              }
            >
              <Trash2Icon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup>Delete</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Send queued message now"
                  disabled={sendDisabled}
                  onClick={onSendNow}
                />
              }
            >
              <ArrowUpIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup>Send now</TooltipPopup>
          </Tooltip>
        </div>
      ) : null}
    </div>
  );
}
