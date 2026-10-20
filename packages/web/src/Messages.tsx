import type { Comment } from "@livingboard/shared";
import { useState } from "react";
import type { BoardModel } from "./board";

/** On a device's first visit, older messages count as read: only fresh ones pop open. */
const FRESH_MS = 6 * 60 * 60 * 1000;

/** Per-device memory of which Claude messages this person has already read. */
export function useReadMessages(board: string, comments: Iterable<Comment>) {
  const key = `livingboard:read:${board}`;
  const [read, setRead] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw) return new Set(JSON.parse(raw) as string[]);
    } catch {
      // storage blocked: everything counts as unread this session
    }
    const old = [...comments].filter((c) => c.author === "ai" && Date.now() - c.at > FRESH_MS).map((c) => c.id);
    return new Set(old);
  });
  const markRead = (ids: string[]) =>
    setRead((prev) => {
      const next = new Set([...prev, ...ids]);
      try {
        localStorage.setItem(key, JSON.stringify([...next].slice(-800)));
      } catch {
        // ignore
      }
      return next;
    });
  return { read, markRead };
}

/** Everything said about one thing on the board (or about the board itself, anchor null). */
export interface Thread {
  anchor: string | null;
  messages: Comment[];
  /** Claude's messages this person hasn't read yet. */
  unread: Comment[];
  /** Claude asked something and nobody answered after it. */
  asking: boolean;
  lastAi?: Comment;
}

export function buildThreads(comments: Iterable<Comment>, read: Set<string>, anchorExists: (id: string) => boolean): Thread[] {
  const by = new Map<string | null, Comment[]>();
  for (const c of comments) {
    const anchor = c.nodeId && anchorExists(c.nodeId) ? c.nodeId : null;
    const list = by.get(anchor) ?? [];
    list.push(c);
    by.set(anchor, list);
  }
  const out: Thread[] = [];
  for (const [anchor, list] of by) {
    list.sort((a, b) => a.at - b.at);
    const ai = list.filter((c) => c.author === "ai");
    if (!ai.length) continue;
    const lastAi = ai[ai.length - 1];
    const answeredAfter = list.some((c) => c.author === "user" && c.at > lastAi.at);
    out.push({
      anchor,
      messages: list,
      unread: ai.filter((c) => !read.has(c.id)),
      asking: lastAi.kind === "question" && !answeredAfter,
      lastAi,
    });
  }
  return out;
}

export const BUBBLE_W = 288;

/** Rough height of an open bubble, for placement before it is rendered. */
export function bubbleHeight(t: Thread, expanded: boolean) {
  const shown = expanded ? t.messages.slice(-6) : t.unread.slice(-3);
  const lines = shown.reduce((n, c) => n + Math.ceil(c.text.length / 36) + (expanded ? 1 : 0), 0);
  return Math.min(320, 64 + lines * 19);
}

const KIND: Record<Comment["kind"], string> = { answer: "Answer", question: "Question", note: "Note", reply: "" };

/**
 * A message from Claude, open on the board next to what it is about, until
 * this person has read it. Reply right there; "Ok" folds it into a small mark.
 */
export function Bubble(props: {
  thread: Thread;
  left: number;
  top: number;
  expanded: boolean;
  model: BoardModel;
  onRead: () => void;
  onCollapse: () => void;
}) {
  const { thread, left, top, expanded, model, onRead, onCollapse } = props;
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState("");
  const shown = expanded ? thread.messages.slice(-6) : thread.unread.slice(-3);
  const send = () => {
    if (!text.trim()) return;
    model.reply(text.trim(), { nodeId: thread.anchor ?? undefined, replyTo: thread.lastAi?.id });
    setText("");
    setReplying(false);
    onRead();
  };
  return (
    <div
      className={`msg-bubble ${thread.asking ? "asking" : ""}`}
      style={{ left, top, width: BUBBLE_W }}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="msg-head">
        <span>
          ✳ Claude{thread.asking ? " · asks you" : thread.lastAi && KIND[thread.lastAi.kind] ? ` · ${KIND[thread.lastAi.kind]}` : ""}
        </span>
        {expanded && (
          <button type="button" className="msg-x" onClick={onCollapse} aria-label="Close">
            ×
          </button>
        )}
      </div>
      <div className="msg-body">
        {shown.map((c) => (
          <p key={c.id} className={c.author === "ai" ? "" : "mine"}>
            {c.author === "ai" ? "" : <b>{c.authorName}: </b>}
            {c.text}
          </p>
        ))}
      </div>
      {replying ? (
        <form
          className="msg-reply"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Reply to Claude…" />
          <button type="submit" className="btn ok" disabled={!text.trim()}>
            Send
          </button>
        </form>
      ) : (
        <div className="msg-actions">
          <button type="button" className="btn ghost" onClick={() => setReplying(true)}>
            Reply
          </button>
          {!expanded && (
            <button type="button" className="btn ok" onClick={onRead}>
              Ok
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** A read conversation: one small mark by the thing it is about. */
export function MessageMark({ thread, left, top, onOpen }: { thread: Thread; left: number; top: number; onOpen: () => void }) {
  return (
    <button
      type="button"
      className={`msg-mark ${thread.asking ? "asking" : ""}`}
      style={{ left, top }}
      onClick={onOpen}
      title={`Claude: ${thread.lastAi?.text.slice(0, 120) ?? ""}`}
    >
      {thread.asking ? "?" : "✳"}
    </button>
  );
}

/** Unread messages that have no place on screen right now (about the whole board, or off-screen). */
export function Inbox(props: { threads: Thread[]; model: BoardModel; onGo: (anchor: string) => void; onRead: (t: Thread) => void }) {
  const { threads, model, onGo, onRead } = props;
  const [open, setOpen] = useState(true);
  const [reply, setReply] = useState<{ key: string; text: string } | null>(null);
  if (!threads.length) return null;
  const count = threads.reduce((n, t) => n + t.unread.length, 0);
  return (
    <div className="msg-inbox" onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <button type="button" className="msg-inbox-head" onClick={() => setOpen(!open)}>
        ✳ {count === 1 ? "1 message from Claude" : `${count} messages from Claude`} {open ? "▴" : "▾"}
      </button>
      {open &&
        threads.map((t) => {
          const key = t.anchor ?? "board";
          const last = t.unread[t.unread.length - 1];
          return (
            <div key={key} className={`msg-inbox-item ${t.asking ? "asking" : ""}`}>
              <p>{last.text}</p>
              {reply?.key === key ? (
                <form
                  className="msg-reply"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!reply.text.trim()) return;
                    model.reply(reply.text.trim(), { nodeId: t.anchor ?? undefined, replyTo: last.id });
                    setReply(null);
                    onRead(t);
                  }}
                >
                  <input autoFocus value={reply.text} onChange={(e) => setReply({ key, text: e.target.value })} placeholder="Reply to Claude…" />
                  <button type="submit" className="btn ok">
                    Send
                  </button>
                </form>
              ) : (
                <div className="msg-actions">
                  {t.anchor && (
                    <button type="button" className="btn ghost" onClick={() => onGo(t.anchor!)}>
                      Go there
                    </button>
                  )}
                  <button type="button" className="btn ghost" onClick={() => setReply({ key, text: "" })}>
                    Reply
                  </button>
                  <button type="button" className="btn ok" onClick={() => onRead(t)}>
                    Ok
                  </button>
                </div>
              )}
            </div>
          );
        })}
    </div>
  );
}
