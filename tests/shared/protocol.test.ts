import { describe, expect, it } from "vitest"
import type { RelaySession } from "../../src/shared/domain"
import { parseRelayMessage } from "../../src/shared/protocol"

const session = {
  id: "session-1",
  revision: 1,
  splitViewId: 7,
  tabA: 11,
  tabB: 12,
  conversationA: { state: "bound", conversationIdentity: "conversation-a" },
  conversationB: { state: "unbound" },
  state: "waiting-a",
  turn: 0,
  maxTurns: 10,
  expectedResponse: {
    sessionId: "session-1",
    waitId: "wait-1",
    side: "a",
    tabId: 11,
    baselineMessageId: null,
    causedByUserMessageId: "user-1",
  },
  pendingTransfer: {
    id: "transfer-1",
    sourceTabId: 11,
    targetTabId: 12,
    sourceMessageId: "assistant-1",
    payloadHash: "hash-1",
    targetWaitId: "wait-2",
    targetUserMessageId: "user-2",
    submissionState: "committed",
  },
} satisfies RelaySession

const status = {
  pair: { valid: true, splitViewId: 7, tabA: 11, tabB: 12 },
  session: {
    sessionId: "session-1",
    state: "waiting-a",
    turn: 1,
    maxTurns: 10,
    expectedSide: "a",
    waitId: "wait-1",
    reason: null,
  },
}

const fixtures: readonly { readonly name: string; readonly message: Record<string, unknown>; readonly missing: string }[] = [
  { name: "adapter-ready", message: { type: "adapter-ready", sessionId: "session-1" }, missing: "type" },
  { name: "adapter-inspect", message: { type: "adapter-inspect" }, missing: "type" },
  {
    name: "adapter-inspect-result",
    message: {
      type: "adapter-inspect-result",
      snapshot: {
        ready: true,
        generating: false,
        conversationIdentity: "conversation-a",
        latestUser: { messageId: "user-1", role: "user", textHash: "hash-user" },
        latestAssistant: { messageId: "assistant-1", text: "answer", textHash: "hash-assistant" },
      },
    },
    missing: "snapshot",
  },
  {
    name: "adapter-command-failure-inspect",
    message: { type: "adapter-command-failure", command: "adapter-inspect", reason: "adapter-not-ready" },
    missing: "reason",
  },
  {
    name: "adapter-command-failure-arm",
    message: {
      type: "adapter-command-failure",
      command: "arm-response",
      sessionId: "session-1",
      waitId: "wait-1",
      reason: "adapter-not-ready",
    },
    missing: "waitId",
  },
  {
    name: "adapter-command-failure-prepare",
    message: {
      type: "adapter-command-failure",
      command: "prepare-peer-response",
      sessionId: "session-1",
      transferId: "transfer-1",
      waitId: "wait-2",
      reason: "submission-failed",
    },
    missing: "transferId",
  },
  {
    name: "adapter-command-failure-commit",
    message: {
      type: "adapter-command-failure",
      command: "commit-transfer",
      sessionId: "session-1",
      transferId: "transfer-1",
      waitId: "wait-2",
      reason: "submission-failed",
    },
    missing: "sessionId",
  },
  {
    name: "adapter-command-failure-bind",
    message: {
      type: "adapter-command-failure",
      command: "bind-expected-user-turn",
      sessionId: "session-1",
      waitId: "wait-2",
      reason: "relay-causality-ambiguous",
    },
    missing: "sessionId",
  },
  {
    name: "adapter-command-failure-cancel",
    message: {
      type: "adapter-command-failure",
      command: "cancel-transfer",
      sessionId: "session-1",
      transferId: "transfer-1",
      reason: "submission-failed",
    },
    missing: "transferId",
  },
  {
    name: "arm-response",
    message: {
      type: "arm-response",
      expected: {
        sessionId: "session-1",
        waitId: "wait-1",
        side: "a",
        tabId: 11,
        baselineMessageId: null,
      },
      authorizationRevision: 1,
    },
    missing: "authorizationRevision",
  },
  {
    name: "arm-response-result",
    message: { type: "arm-response-result", ok: true, sessionId: "session-1", waitId: "wait-1" },
    missing: "waitId",
  },
  {
    name: "initial-user-turn-observed",
    message: {
      type: "initial-user-turn-observed",
      sessionId: "session-1",
      waitId: "wait-1",
      userMessageId: "user-1",
      conversationIdentity: "conversation-a",
    },
    missing: "userMessageId",
  },
  {
    name: "assistant-complete",
    message: {
      type: "assistant-complete",
      sessionId: "session-1",
      waitId: "wait-1",
      causedByUserMessageId: "user-1",
      message: { messageId: "assistant-1", text: "answer", textHash: "hash-assistant" },
    },
    missing: "waitId",
  },
  {
    name: "prepare-peer-response",
    message: {
      type: "prepare-peer-response",
      sessionId: "session-1",
      transferId: "transfer-1",
      waitId: "wait-2",
      text: "answer",
      authorizationRevision: 1,
    },
    missing: "text",
  },
  {
    name: "transfer-prepared",
    message: {
      type: "transfer-prepared",
      sessionId: "session-1",
      transferId: "transfer-1",
      waitId: "wait-2",
      baselineMessageId: null,
      conversationIdentity: "conversation-b",
    },
    missing: "conversationIdentity",
  },
  {
    name: "commit-transfer",
    message: {
      type: "commit-transfer",
      sessionId: "session-1",
      transferId: "transfer-1",
      waitId: "wait-2",
      authorizationRevision: 2,
      authorizedConversationIdentity: "conversation-b",
    },
    missing: "authorizedConversationIdentity",
  },
  {
    name: "transfer-committed",
    message: {
      type: "transfer-committed",
      sessionId: "session-1",
      transferId: "transfer-1",
      waitId: "wait-2",
      userMessageId: "user-2",
      conversationIdentity: "conversation-b",
    },
    missing: "userMessageId",
  },
  {
    name: "bind-expected-user-turn",
    message: {
      type: "bind-expected-user-turn",
      sessionId: "session-1",
      waitId: "wait-2",
      userMessageId: "user-2",
      conversationIdentity: "conversation-b",
      authorizationRevision: 2,
    },
    missing: "authorizationRevision",
  },
  {
    name: "bind-expected-user-turn-result",
    message: { type: "bind-expected-user-turn-result", ok: true, sessionId: "session-1", waitId: "wait-2" },
    missing: "ok",
  },
  {
    name: "transcript-interference",
    message: {
      type: "transcript-interference",
      sessionId: "session-1",
      waitId: "wait-1",
      reason: "regenerate",
    },
    missing: "reason",
  },
  {
    name: "cancel-transfer",
    message: { type: "cancel-transfer", sessionId: "session-1", transferId: "transfer-1" },
    missing: "transferId",
  },
  {
    name: "cancel-transfer-result",
    message: {
      type: "cancel-transfer-result",
      sessionId: "session-1",
      result: { status: "already-committed", transferId: "transfer-1", userMessageId: "user-2", conversationIdentity: "conversation-b" },
    },
    missing: "result",
  },
  { name: "relay-status", message: { type: "relay-status" }, missing: "type" },
  { name: "relay-status-result", message: { type: "relay-status-result", status }, missing: "status" },
  { name: "relay-start", message: { type: "relay-start" }, missing: "type" },
  {
    name: "relay-start-result-success",
    message: { type: "relay-start-result", ok: true, status },
    missing: "status",
  },
  {
    name: "relay-start-result-failure",
    message: { type: "relay-start-result", ok: false, reason: "pair-invalid", status },
    missing: "reason",
  },
  { name: "relay-stop", message: { type: "relay-stop", sessionId: "session-1" }, missing: "sessionId" },
  {
    name: "relay-stop-result-success",
    message: { type: "relay-stop-result", ok: true, status },
    missing: "status",
  },
  {
    name: "relay-stop-result-failure",
    message: { type: "relay-stop-result", ok: false, reason: "invalid-session", status },
    missing: "reason",
  },
  { name: "relay-preferences-get", message: { type: "relay-preferences-get" }, missing: "type" },
  { name: "relay-preferences-result", message: { type: "relay-preferences-result", maxTurns: 10 }, missing: "maxTurns" },
  { name: "relay-preferences-set", message: { type: "relay-preferences-set", maxTurns: 10 }, missing: "maxTurns" },
  {
    name: "relay-preferences-set-result-success",
    message: { type: "relay-preferences-set-result", ok: true, maxTurns: 10 },
    missing: "maxTurns",
  },
  {
    name: "relay-preferences-set-result-failure",
    message: { type: "relay-preferences-set-result", ok: false, reason: "invalid-max-turns", maxTurns: 10 },
    missing: "reason",
  },
]

describe("relay protocol parser", () => {
  it.each(fixtures)("accepts the valid $name message shape", ({ message }) => {
    expect(parseRelayMessage(message)).toEqual(message)
  })

  it.each(fixtures)("rejects $name when $missing is absent", ({ message, missing }) => {
    const invalid = Object.fromEntries(Object.entries(message).filter(([key]) => key !== missing))

    expect(parseRelayMessage(invalid)).toBeNull()
  })

  it("rejects unknown message types and incompatible required-field types", () => {
    expect(parseRelayMessage({ type: "unknown-message" })).toBeNull()
    expect(parseRelayMessage({ type: "relay-preferences-set", maxTurns: "10" })).toBeNull()
  })

  it.each([0, -1, 1.5])(
    "accepts structurally valid numeric maxTurns value %s for runtime validation",
    (maxTurns) => {
      const message = { type: "relay-preferences-set", maxTurns }

      expect(parseRelayMessage(message)).toEqual(message)
    },
  )

  it("recognizes only the approved machine-readable failure reasons", () => {
    expect(parseRelayMessage({ type: "relay-start-result", ok: false, reason: "invented", status })).toBeNull()
  })

  it("preserves session revision, binding, wait, and transfer causal identities", () => {
    expect(session.expectedResponse?.causedByUserMessageId).toBe("user-1")
    expect(session.pendingTransfer?.targetUserMessageId).toBe("user-2")
    expect(session.conversationA).toEqual({ state: "bound", conversationIdentity: "conversation-a" })
  })
})
