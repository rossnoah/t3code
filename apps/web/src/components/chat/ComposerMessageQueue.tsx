import { memo, useCallback, useMemo, useState } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { CheckIcon, GripVerticalIcon, ImageIcon, PencilIcon, XIcon } from "lucide-react";
import { type ScopedThreadRef } from "@t3tools/contracts";
import { useShallow } from "zustand/react/shallow";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import {
  type DraftId,
  type QueuedMessage,
  useComposerDraftStore,
} from "../../composerDraftStore";

const EMPTY_QUEUE: QueuedMessage[] = [];

interface ComposerMessageQueueProps {
  target: ScopedThreadRef | DraftId;
  className?: string;
}

/**
 * The staged-message queue shown above the composer input. Messages land here
 * when the composer is submitted (Tab/Enter) while the agent is working, and are
 * auto-sent one turn at a time as the agent goes idle. Rows can be edited,
 * removed, and drag-reordered; only the message text is editable.
 */
export const ComposerMessageQueue = memo(function ComposerMessageQueue({
  target,
  className,
}: ComposerMessageQueueProps) {
  const messages = useComposerDraftStore(
    useShallow((store) => store.getComposerDraft(target)?.queuedMessages ?? EMPTY_QUEUE),
  );
  const setQueuedMessages = useComposerDraftStore((store) => store.setQueuedMessages);
  const removeQueuedMessage = useComposerDraftStore((store) => store.removeQueuedMessage);
  const updateQueuedMessage = useComposerDraftStore((store) => store.updateQueuedMessage);
  const clearQueuedMessages = useComposerDraftStore((store) => store.clearQueuedMessages);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const ids = useMemo(() => messages.map((message) => message.id), [messages]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const from = messages.findIndex((message) => message.id === active.id);
      const to = messages.findIndex((message) => message.id === over.id);
      if (from < 0 || to < 0) return;
      setQueuedMessages(target, arrayMove(messages, from, to));
    },
    [messages, setQueuedMessages, target],
  );

  const beginEdit = useCallback((message: QueuedMessage) => {
    setEditingId(message.id);
    setEditText(message.text);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setEditText("");
  }, []);

  const commitEdit = useCallback(() => {
    if (editingId === null) return;
    const trimmed = editText.trim();
    if (trimmed.length === 0) {
      removeQueuedMessage(target, editingId);
    } else {
      updateQueuedMessage(target, editingId, editText);
    }
    setEditingId(null);
    setEditText("");
  }, [editText, editingId, removeQueuedMessage, target, updateQueuedMessage]);

  if (messages.length === 0) return null;

  return (
    <div
      className={cn(
        "rounded-xl border border-border/60 bg-muted/40 px-2 py-2 text-[13px]",
        className,
      )}
      data-chat-composer-queue="true"
    >
      <div className="flex items-center justify-between px-1 pb-1.5">
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          {messages.length} queued
        </span>
        <button
          type="button"
          className="text-[11px] text-muted-foreground/80 hover:text-foreground"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            cancelEdit();
            clearQueuedMessages(target);
          }}
        >
          Clear all
        </button>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <ul className="flex flex-col gap-1">
            {messages.map((message, index) => (
              <QueuedMessageRow
                key={message.id}
                message={message}
                index={index}
                isEditing={editingId === message.id}
                editText={editText}
                onEditTextChange={setEditText}
                onBeginEdit={beginEdit}
                onCommitEdit={commitEdit}
                onCancelEdit={cancelEdit}
                onRemove={(id) => {
                  if (editingId === id) cancelEdit();
                  removeQueuedMessage(target, id);
                }}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    </div>
  );
});

interface QueuedMessageRowProps {
  message: QueuedMessage;
  index: number;
  isEditing: boolean;
  editText: string;
  onEditTextChange: (text: string) => void;
  onBeginEdit: (message: QueuedMessage) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
  onRemove: (id: string) => void;
}

function QueuedMessageRow({
  message,
  index,
  isEditing,
  editText,
  onEditTextChange,
  onBeginEdit,
  onCommitEdit,
  onCancelEdit,
  onRemove,
}: QueuedMessageRowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: message.id, disabled: isEditing });

  const preview = message.text.trim();
  const imageCount = message.images.length;

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "group flex items-start gap-1.5 rounded-lg bg-background/70 px-1.5 py-1.5 ring-1 ring-border/50",
        isDragging && "z-10 opacity-80 shadow-sm",
      )}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        className={cn(
          "mt-0.5 shrink-0 cursor-grab touch-none text-muted-foreground/50 hover:text-muted-foreground active:cursor-grabbing",
          isEditing && "pointer-events-none opacity-30",
        )}
        aria-label="Reorder queued message"
        onPointerDown={(event) => event.preventDefault()}
        {...attributes}
        {...listeners}
      >
        <GripVerticalIcon className="size-4" />
      </button>
      <span className="mt-0.5 shrink-0 text-[11px] tabular-nums text-muted-foreground/60">
        {index + 1}.
      </span>
      {isEditing ? (
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Textarea
            autoFocus
            value={editText}
            onChange={(event) => onEditTextChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onCommitEdit();
              } else if (event.key === "Escape") {
                event.preventDefault();
                onCancelEdit();
              }
            }}
            className="min-h-[2.25rem] resize-none text-[13px]"
          />
          <div className="flex items-center justify-end gap-1">
            <Button size="sm" variant="ghost" className="h-7 px-2" onClick={onCancelEdit}>
              Cancel
            </Button>
            <Button size="sm" className="h-7 px-2" onClick={onCommitEdit}>
              <CheckIcon className="size-3.5" />
              Save
            </Button>
          </div>
        </div>
      ) : (
        <>
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left text-foreground/90 hover:text-foreground"
            title="Edit queued message"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => onBeginEdit(message)}
          >
            {imageCount > 0 && (
              <span className="mr-1 inline-flex items-center gap-0.5 align-middle text-muted-foreground/70">
                <ImageIcon className="size-3.5" />
                {imageCount}
              </span>
            )}
            {preview || <span className="text-muted-foreground/50">(empty message)</span>}
          </button>
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <button
              type="button"
              className="rounded p-1 text-muted-foreground/70 hover:bg-muted hover:text-foreground"
              aria-label="Edit queued message"
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => onBeginEdit(message)}
            >
              <PencilIcon className="size-3.5" />
            </button>
            <button
              type="button"
              className="rounded p-1 text-muted-foreground/70 hover:bg-muted hover:text-foreground"
              aria-label="Remove queued message"
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => onRemove(message.id)}
            >
              <XIcon className="size-3.5" />
            </button>
          </div>
        </>
      )}
    </li>
  );
}
