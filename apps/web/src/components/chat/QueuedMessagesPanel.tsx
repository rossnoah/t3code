import { useId, useState } from "react";
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
import { ComposerBanner } from "./ComposerBanner";
import { cn } from "../../lib/utils";
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
  const listId = useId();
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
  const nextMessage = messages[0];
  const collapsedPreview =
    nextMessage?.prompt.trim() ||
    (nextMessage?.images.length || nextMessage?.files.length ? "Attachments" : "Context");
  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Surface
        role="region"
        aria-label="Message queue"
        className="pb-[calc(var(--chat-composer-attachment-overlap)+0.25rem)]"
      >
        <div className="flex min-h-9 items-center gap-2 px-2 py-1">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60"
            disabled={editingId !== null}
            aria-expanded={!collapsed}
            aria-controls={listId}
            onClick={() => setCollapsed(!collapsed)}
          >
            <ChevronDownIcon
              aria-hidden
              className={cn("size-3.5 shrink-0", collapsed && "-rotate-90")}
            />
            <span className={cn("shrink-0 font-medium", paused && "text-foreground")}>
              {paused ? "Queue paused" : "Queued"}
            </span>
            <span className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded bg-foreground/5 px-1 text-[10px] tabular-nums">
              {messages.length}
            </span>
            {collapsed ? (
              <span className="truncate text-muted-foreground/70">{collapsedPreview}</span>
            ) : null}
          </button>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="xs"
                  variant={paused ? "ghost" : "ghost-muted"}
                  className={cn(
                    "h-6 shrink-0 gap-1.5 rounded-md px-2 text-xs",
                    paused && "bg-foreground/5",
                  )}
                  disabled={editingId !== null}
                  onClick={() => (paused ? resume(threadKey) : pause(threadKey))}
                />
              }
            >
              {paused ? <PlayIcon className="size-3" /> : <PauseIcon className="size-3" />}
              {paused ? "Resume" : "Pause"}
            </TooltipTrigger>
            <TooltipPopup>
              {paused ? "Resume sending after each turn" : "Pause queued messages"}
            </TooltipPopup>
          </Tooltip>
        </div>
        <div
          id={listId}
          hidden={collapsed}
          className="max-h-[min(30vh,16rem)] overflow-y-auto overscroll-contain px-1.5 pb-1"
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
                  editDisabled={editingId !== null}
                  dragDisabled={editingId !== null || messages.length < 2}
                  sendDisabled={sendDisabled || editingId !== null}
                  onSendNow={() => onSendNow(message.id)}
                  onDelete={() => {
                    const removed = remove(threadKey, message.id);
                    if (!removed) return;
                    releaseDraftAttachments([...removed.images, ...removed.files]);
                    for (const image of removed.images) {
                      if (image.previewUrl.startsWith("blob:"))
                        URL.revokeObjectURL(image.previewUrl);
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
      </ComposerBanner.Surface>
    </ComposerBanner.Attachment>
  );
}

function QueuedMessageRow({
  message,
  editing,
  editDisabled,
  dragDisabled,
  sendDisabled,
  onSendNow,
  onDelete,
  onEdit,
  onFinishEdit,
}: {
  message: QueuedComposerMessage;
  editing: boolean;
  editDisabled: boolean;
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
      className={cn(
        "group/queue-row relative flex items-start gap-1 rounded-lg px-1 py-1.5 hover:bg-foreground/4 focus-within:bg-foreground/4",
        isDragging &&
          "z-10 bg-(--chat-composer-attached-surface) shadow-md ring-1 ring-(--chat-composer-attached-outline)",
      )}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        {...attributes}
        {...listeners}
        aria-label="Drag to reorder message"
        className="mt-0.5 touch-none rounded p-1 text-muted-foreground/50 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:invisible pointer-fine:opacity-0 pointer-fine:group-hover/queue-row:opacity-100 pointer-fine:group-focus-within/queue-row:opacity-100"
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
              className="min-h-20 w-full resize-y rounded-lg border border-(--chat-composer-attached-outline) bg-background/40 px-2.5 py-2 text-[13px]/5 outline-none focus:border-ring"
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
          <div className="whitespace-pre-wrap px-1 py-1 text-[13px]/5 text-foreground/90 [overflow-wrap:anywhere]">
            {message.prompt || (attachmentCount ? "Attachments" : "Context")}
          </div>
        )}
        {attachmentCount + contextCount > 0 ? (
          <div className="px-1 text-[11px]/4 text-muted-foreground">
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
        <div className="mt-0.5 flex shrink-0 items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  className="rounded-md pointer-fine:opacity-0 pointer-fine:group-hover/queue-row:opacity-100 pointer-fine:group-focus-within/queue-row:opacity-100"
                  aria-label="Edit queued message"
                  disabled={editDisabled}
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
                  className="rounded-md hover:bg-destructive/10 hover:text-destructive hover:[--control-icon-color:var(--destructive)] pointer-fine:opacity-0 pointer-fine:group-hover/queue-row:opacity-100 pointer-fine:group-focus-within/queue-row:opacity-100"
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
                  className="rounded-md text-muted-foreground hover:text-foreground"
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
