import { describe, expect, it } from "vitest"
import type {
  AdapterSnapshot,
  CancelSubmissionResult,
  RelaySession,
} from "../../src/shared/domain"
import { RelayDomainError, RelayTransportError } from "../../src/shared/errors"
import type { RelayTransport } from "../../src/background/relay-controller"
import { RelayController } from "../../src/background/relay-controller"
import type { RelayPreferencesStore, RelaySessionStore } from "../../src/background/session-store"
import { TransitionQueue } from "../../src/background/transition-queue"
import type { TabSnapshot } from "../../src/background/split-view"

const tabs: readonly TabSnapshot[] = [
  { id: 11, windowId: 3, active: true, url: "https://chatgpt.com/c/a", splitViewId: 8 },
  { id: 12, windowId: 3, active: false, url: "https://chatgpt.com/c/b", splitViewId: 8 },
]

const snapshotA: AdapterSnapshot = {
  ready: true,
  generating: false,
  conversationIdentity: "conversation-a",
  latestUser: null,
  latestAssistant: { messageId: "assistant-a-before", text: "old A", textHash: "hash-a" },
}

const snapshotB: AdapterSnapshot = {
  ready: true,
  generating: false,
  conversationIdentity: "conversation-b",
  latestUser: null,
  latestAssistant: { messageId: "assistant-b-before", text: "old B", textHash: "hash-b" },
}

type HarnessOptions = {
  readonly tabs?: readonly TabSnapshot[]
  readonly snapshotA?: AdapterSnapshot
  readonly snapshotB?: AdapterSnapshot
  readonly inspectFailure?: Error
  readonly armFailure?: Error
}

function createHarness(options: HarnessOptions = {}) {
  let stored: RelaySession | null = null
  let maxTurns = 10
  const writes: RelaySession[] = []
  const operations: string[] = []
  const sessions: RelaySessionStore = {
    async read() {
      return stored
    },
    async write(session) {
      stored = session
      writes.push(session)
      operations.push("write")
    },
    async clear() {
      stored = null
    },
  }
  const preferences: RelayPreferencesStore = {
    async readMaxTurns() {
      return maxTurns
    },
    async writeMaxTurns(value) {
      maxTurns = value
    },
  }
  const transport: RelayTransport = {
    async inspect(tabId) {
      if (options.inspectFailure !== undefined) throw options.inspectFailure
      return {
        type: "adapter-inspect-result",
        snapshot: tabId === 11 ? (options.snapshotA ?? snapshotA) : (options.snapshotB ?? snapshotB),
      }
    },
    async armResponse(tabId, message) {
      operations.push("arm")
      expect(stored?.expectedResponse).toEqual(message.expected)
      if (options.armFailure !== undefined) throw options.armFailure
      return {
        type: "arm-response-result",
        ok: true,
        sessionId: message.expected.sessionId,
        waitId: message.expected.waitId,
      }
    },
    async prepareSubmission() {
      throw new Error("Task 9 does not prepare submissions")
    },
    async commitSubmission() {
      throw new Error("Task 9 does not commit submissions")
    },
    async bindExpectedUserTurn(tabId, message) {
      operations.push("bind")
      expect(stored?.expectedResponse?.causedByUserMessageId).toBe(message.userMessageId)
      return {
        type: "bind-expected-user-turn-result",
        ok: true,
        sessionId: message.sessionId,
        waitId: message.waitId,
      }
    },
    async cancelSubmission(_tabId, message): Promise<{ type: "cancel-transfer-result"; sessionId: string; result: CancelSubmissionResult }> {
      return {
        type: "cancel-transfer-result",
        sessionId: message.sessionId,
        result: { status: "unknown", transferId: message.transferId },
      }
    },
  }
  const controller = new RelayController({
    sessions,
    preferences,
    queue: new TransitionQueue(),
    tabs: {
      async queryCurrentWindow() {
        return options.tabs ?? tabs
      },
    },
    transport,
  })
  return {
    controller,
    operations,
    sessions,
    transport,
    writes,
    current: () => stored,
  }
}

describe("RelayController Start and initial causal binding", () => {
  it("assigns the active Split View tab to A and persists the wait before arming", async () => {
    const harness = createHarness()

    const started = await harness.controller.start()

    expect(started.tabA).toBe(11)
    expect(started.tabB).toBe(12)
    expect(started.conversationA).toEqual({ state: "bound", conversationIdentity: "conversation-a" })
    expect(started.conversationB).toEqual({ state: "bound", conversationIdentity: "conversation-b" })
    expect(started.state).toBe("waiting-a")
    expect(started.expectedResponse).toMatchObject({
      sessionId: started.id,
      side: "a",
      tabId: 11,
      baselineMessageId: "assistant-a-before",
    })
    expect(harness.operations).toEqual(["write", "arm"])
  })

  it("starts a genuinely new conversation as unbound", async () => {
    const harness = createHarness({
      snapshotA: { ...snapshotA, conversationIdentity: null, latestAssistant: null },
      snapshotB: { ...snapshotB, conversationIdentity: null, latestAssistant: null },
    })

    const started = await harness.controller.start()

    expect(started.conversationA).toEqual({ state: "unbound" })
    expect(started.conversationB).toEqual({ state: "unbound" })
    expect(started.expectedResponse?.baselineMessageId).toBeNull()
  })

  it("rejects an invalid Split View pair without creating a session", async () => {
    const harness = createHarness({
      tabs: [
        { id: 11, windowId: 3, active: true, url: "https://chatgpt.com/c/a", splitViewId: 8 },
      ],
    })

    await expect(harness.controller.start()).rejects.toThrow(new RelayDomainError("pair-invalid"))
    expect(harness.current()).toBeNull()
    expect(harness.operations).not.toContain("arm")
  })

  it("rejects generating A without creating a session", async () => {
    const harness = createHarness({ snapshotA: { ...snapshotA, generating: true } })

    await expect(harness.controller.start()).rejects.toThrow(
      new RelayDomainError("generation-in-progress"),
    )
    expect(harness.current()).toBeNull()
  })

  it("maps transport failure before persistence without synthesizing a session", async () => {
    const failure = new RelayTransportError({
      command: "adapter-inspect",
      tabId: 11,
      reason: "adapter-not-ready",
    })
    const harness = createHarness({ inspectFailure: failure })

    await expect(harness.controller.start()).rejects.toThrow(
      new RelayDomainError("adapter-not-ready"),
    )
    expect(harness.current()).toBeNull()
  })

  it("persists an arm failure as the same terminal reason before rejecting Start", async () => {
    const failure = new RelayTransportError({
      command: "arm-response",
      tabId: 11,
      sessionId: "session-placeholder",
      waitId: "wait-placeholder",
      reason: "adapter-not-ready",
    })
    const harness = createHarness({ armFailure: failure })

    await expect(harness.controller.start()).rejects.toThrow(
      new RelayDomainError("adapter-not-ready"),
    )
    const terminal = harness.current()
    expect(terminal).toMatchObject({ state: "error", stopReason: "adapter-not-ready" })
    expect(terminal === null || "expectedResponse" in terminal).toBe(false)
    expect(terminal === null || "pendingTransfer" in terminal).toBe(false)
  })

  it("propagates unexpected programming exceptions unchanged", async () => {
    const unexpected = new TypeError("fixture programming failure")
    const harness = createHarness({ inspectFailure: unexpected })

    await expect(harness.controller.start()).rejects.toBe(unexpected)
    expect(harness.current()).toBeNull()
  })

  it("ignores a pre-Start assistant because no initial user cause is persisted", async () => {
    const harness = createHarness()
    const started = await harness.controller.start()
    const expected = started.expectedResponse
    if (expected === undefined) throw new Error("missing initial expected response")

    await harness.controller.handleAssistantComplete(11, {
      type: "assistant-complete",
      sessionId: started.id,
      waitId: expected.waitId,
      causedByUserMessageId: "pre-start-user",
      message: { messageId: "pre-start-assistant", text: "old", textHash: "old-hash" },
    })

    expect(harness.current()?.lastMessageA).toBeUndefined()
    expect(harness.current()?.expectedResponse).toEqual(expected)
  })

  it("persists the exact allowed initial user cause before confirming it to A", async () => {
    const harness = createHarness({ snapshotA: { ...snapshotA, conversationIdentity: null } })
    const started = await harness.controller.start()
    const expected = started.expectedResponse
    if (expected === undefined) throw new Error("missing initial expected response")

    await harness.controller.handleInitialUserTurnObserved(11, {
      type: "initial-user-turn-observed",
      sessionId: started.id,
      waitId: expected.waitId,
      userMessageId: "user-first-prompt",
      conversationIdentity: "conversation-created-by-prompt",
    })

    expect(harness.current()?.conversationA).toEqual({
      state: "bound",
      conversationIdentity: "conversation-created-by-prompt",
    })
    expect(harness.current()?.expectedResponse?.causedByUserMessageId).toBe("user-first-prompt")
    expect(harness.operations.slice(-2)).toEqual(["write", "bind"])
  })

  it("does not adopt an unrelated conversation from an assistant observation before user binding", async () => {
    const harness = createHarness({ snapshotA: { ...snapshotA, conversationIdentity: null } })
    const started = await harness.controller.start()
    const expected = started.expectedResponse
    if (expected === undefined) throw new Error("missing initial expected response")

    await harness.controller.handleAssistantComplete(11, {
      type: "assistant-complete",
      sessionId: started.id,
      waitId: expected.waitId,
      causedByUserMessageId: "unrelated-user",
      message: { messageId: "unrelated-assistant", text: "unrelated", textHash: "hash" },
    })

    expect(harness.current()?.conversationA).toEqual({ state: "unbound" })
    expect(harness.current()?.expectedResponse?.causedByUserMessageId).toBeUndefined()
  })

  it("fails closed on a second manual A turn", async () => {
    const harness = createHarness()
    const started = await harness.controller.start()
    const expected = started.expectedResponse
    if (expected === undefined) throw new Error("missing initial expected response")
    const firstTurn = {
      type: "initial-user-turn-observed" as const,
      sessionId: started.id,
      waitId: expected.waitId,
      userMessageId: "user-first",
      conversationIdentity: "conversation-a",
    }
    await harness.controller.handleInitialUserTurnObserved(11, firstTurn)

    await harness.controller.handleInitialUserTurnObserved(11, {
      ...firstTurn,
      userMessageId: "user-second",
    })

    expect(harness.current()).toMatchObject({ state: "error", stopReason: "unexpected-user-input" })
  })

  it("ignores initial-user events from a non-A tab and stale session", async () => {
    const harness = createHarness()
    const started = await harness.controller.start()
    const before = harness.current()
    const expected = started.expectedResponse
    if (expected === undefined) throw new Error("missing initial expected response")
    const event = {
      type: "initial-user-turn-observed" as const,
      sessionId: started.id,
      waitId: expected.waitId,
      userMessageId: "user-first",
      conversationIdentity: "conversation-a",
    }

    await harness.controller.handleInitialUserTurnObserved(12, event)
    await harness.controller.handleInitialUserTurnObserved(11, { ...event, sessionId: "stale-session" })

    expect(harness.current()).toEqual(before)
  })
})
