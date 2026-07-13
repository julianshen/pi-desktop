import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { EventType, type RunAgentInput, type BaseEvent } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import { getOrCreateSession, getConversationMeta, touchConversation } from "../agent/conversations.js";

const DEFAULT_CONVERSATION_TITLE = "New conversation";
const DERIVED_TITLE_MAX_LENGTH = 60;

function extractLatestUserText(input: RunAgentInput): string {
  for (let i = input.messages.length - 1; i >= 0; i -= 1) {
    const message = input.messages[i];
    if (message.role === "user") {
      return typeof message.content === "string" ? message.content : "";
    }
  }
  return "";
}

function extractFirstUserText(input: RunAgentInput): string {
  for (const message of input.messages) {
    if (message.role === "user") {
      return typeof message.content === "string" ? message.content : "";
    }
  }
  return "";
}

function deriveTitle(text: string): string {
  const collapsed = text.trim().replace(/\s+/g, " ");
  if (!collapsed) return DEFAULT_CONVERSATION_TITLE;
  return collapsed.length > DERIVED_TITLE_MAX_LENGTH
    ? `${collapsed.slice(0, DERIVED_TITLE_MAX_LENGTH)}…`
    : collapsed;
}

/**
 * End-of-turn bookkeeping (Task 3): always bumps updatedAt via touchConversation,
 * and — only while the conversation still has the default title — derives one from
 * the first user message so freshly-created conversations pick up a real title after
 * their first turn without the user having to rename them manually.
 */
function touchConversationAfterTurn(conversationId: string, input: RunAgentInput): void {
  const meta = getConversationMeta(conversationId);
  if (meta?.title === DEFAULT_CONVERSATION_TITLE) {
    touchConversation(conversationId, { title: deriveTitle(extractFirstUserText(input)) });
  } else {
    touchConversation(conversationId);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Bridges pi's own AgentSession event stream to the AG-UI protocol so CopilotKit's
 * HttpAgent (registered as a remote agent in the CopilotRuntime) can drive the chat UI.
 * See docs/architecture.md for why this bridge exists — pi has no built-in AG-UI support.
 */
export async function handleAguiRun(req: Request, res: Response): Promise<void> {
  const input = req.body as RunAgentInput;
  const encoder = new EventEncoder({ accept: req.headers.accept as string | undefined });

  res.setHeader("Content-Type", encoder.getContentType());
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  let finished = false;
  const write = (event: BaseEvent) => {
    if (finished) return;
    res.write(encoder.encodeSSE(event));
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    res.end();
  };

  write({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId } as BaseEvent);

  const conversationId = input.threadId ?? "default";
  const session = await getOrCreateSession(conversationId).catch((error: unknown) => {
    write({ type: EventType.RUN_ERROR, message: errorMessage(error) } as BaseEvent);
    finish();
    return undefined;
  });
  if (!session) return;

  let currentMessageId: string | undefined;
  // pi's own agentic loop routinely emits an assistant message that carries only
  // "thinking"/toolcall content and zero text_delta (e.g. the turn where the model
  // decides to call a tool, before any user-visible text) — its message_start/
  // message_end pair has no text between them. Eagerly writing TEXT_MESSAGE_START on
  // message_start rendered these as a visible empty chat bubble ("empty lines in
  // chat"). Fix: defer TEXT_MESSAGE_START until the first real text_delta arrives for
  // this message, and only close it with TEXT_MESSAGE_END if it was actually opened.
  let textMessageStarted = false;

  const unsubscribe = session.subscribe((event) => {
    switch (event.type) {
      case "message_start": {
        if (event.message.role === "assistant") {
          currentMessageId = randomUUID();
          textMessageStarted = false;
        }
        break;
      }
      case "message_update": {
        if (event.assistantMessageEvent.type === "text_delta" && currentMessageId) {
          if (!textMessageStarted) {
            write({
              type: EventType.TEXT_MESSAGE_START,
              messageId: currentMessageId,
              role: "assistant",
            } as BaseEvent);
            textMessageStarted = true;
          }
          write({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: currentMessageId,
            delta: event.assistantMessageEvent.delta,
          } as BaseEvent);
        }
        break;
      }
      case "message_end": {
        if (event.message.role === "assistant" && currentMessageId) {
          if (textMessageStarted) {
            write({ type: EventType.TEXT_MESSAGE_END, messageId: currentMessageId } as BaseEvent);
          }
          currentMessageId = undefined;
          textMessageStarted = false;
        }
        break;
      }
      case "tool_execution_start": {
        write({
          type: EventType.TOOL_CALL_START,
          toolCallId: event.toolCallId,
          toolCallName: event.toolName,
        } as BaseEvent);
        write({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: event.toolCallId,
          delta: JSON.stringify(event.args ?? {}),
        } as BaseEvent);
        break;
      }
      case "tool_execution_end": {
        write({ type: EventType.TOOL_CALL_END, toolCallId: event.toolCallId } as BaseEvent);
        write({
          type: EventType.TOOL_CALL_RESULT,
          messageId: randomUUID(),
          toolCallId: event.toolCallId,
          content: typeof event.result === "string" ? event.result : JSON.stringify(event.result),
          role: "tool",
        } as BaseEvent);
        break;
      }
      case "agent_end": {
        write({ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId } as BaseEvent);
        /**
         * Task 3 fix (review finding): bookkeeping must never block stream teardown.
         * If touchConversationAfterTurn throws (e.g. registry write failure), RUN_FINISHED
         * has already reached the client — unsubscribe()/finish() still need to run so the
         * SSE connection doesn't leak.
         */
        try {
          touchConversationAfterTurn(conversationId, input);
        } catch (error) {
          console.error("[agui] touchConversationAfterTurn failed", error);
        }
        unsubscribe();
        finish();
        break;
      }
    }
  });

  try {
    await session.prompt(
      extractLatestUserText(input),
      session.isStreaming ? { streamingBehavior: "steer" } : undefined,
    );
  } catch (error) {
    write({ type: EventType.RUN_ERROR, message: errorMessage(error) } as BaseEvent);
    unsubscribe();
    finish();
  }
}
