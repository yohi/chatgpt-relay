import { describe, expect, it } from "vitest"
import type { RelaySession } from "../../src/shared/domain"
import { RelayDomainError, RelayTransportError } from "../../src/shared/errors"
import { RelayController } from "../../src/background/relay-controller"
import type { RelayTransport } from "../../src/background/relay-controller"
import type { RelayPreferencesStore, RelaySessionStore } from "../../src/background/session-store"
import { TransitionQueue } from "../../src/background/transition-queue"
import type { TabSnapshot } from "../../src/background/split-view"
import type {
  AssistantCompleteMessage,
  CommitTransferMessage,
  TransferCommittedMessage,
  TransferPreparedMessage,
} from "../../src/shared/protocol"

const pairTabs: readonly TabSnapshot[] = [
  { id: 11, windowId: 3, active: true, url: "https://chatgpt.com/c/a", splitViewId: 8 },
  { id: 12, windowId: 3, active: false, url: "https://chatgpt.com/c/b", splitViewId: 8 },
]

type TransferHarnessOptions = {
  readonly targetConversationAtStart?: string | null
  readonly preparedConversationIdentity?: string | null
  readonly committedConversationIdentity?: string
  readonly beforeCommit?: (message: CommitTransferMessage) => void
  readonly deferPrepare?: boolean
  readonly deferCommit?: boolean
  readonly onPrepare?: (session: RelaySession | null) => void
}

function createTransferHarness(options: TransferHarnessOptions = {}) {
  let stored: RelaySession | null = null
  let currentAIdentity = "conversation-a"
  let currentTargetIdentity = "targetConversationAtStart" in options
    ? options.targetConversationAtStart ?? null
    : "conversation-b"
  const writes: RelaySession[] = []
  const calls: string[] = []
  let inspectCalls = 0
  let commitEffects = 0
  let deferredCommitUsed = false
  let resolveDeferredPrepare: ((prepared: TransferPreparedMessage) => void) | undefined
  let resolveDeferredCommit: ((committed: TransferCommittedMessage) => void) | undefined
  let signalPrepareStarted: (() => void) | undefined
  let signalCommitStarted: (() => void) | undefined
  const prepareStarted = new Promise<void>((resolve) => {
    signalPrepareStarted = resolve
  })
  const deferredPrepared = new Promise<TransferPreparedMessage>((resolve) => {
    resolveDeferredPrepare = resolve
  })
  const commitStarted = new Promise<void>((resolve) => {
    signalCommitStarted = resolve
  })
  const deferredCommitted = new Promise<TransferCommittedMessage>((resolve) => {
    resolveDeferredCommit = resolve
  })
  const sessions: RelaySessionStore = {
    async read() {
      return stored
    },
    async write(session) {
      stored = session
      writes.push(session)
    },
    async clear() {
      stored = null
    },
  }
  const preferences: RelayPreferencesStore = {
    async readMaxTurns() {
      return 10
    },
    async writeMaxTurns() {},
  }
  const transport: RelayTransport = {
    async inspect(tabId) {
      inspectCalls += 1
      const identity = tabId === 11 ? "conversation-a" : currentTargetIdentity
      return {
        type: "adapter-inspect-result",
        snapshot: {
          ready: true,
          generating: false,
          conversationIdentity: identity,
          latestUser: null,
          latestAssistant:
            tabId === 11
              ? { messageId: "assistant-a-before", text: "old A", textHash: "hash-a" }
              : { messageId: "assistant-b-before", text: "old B", textHash: "hash-b" },
        },
      }
    },
    async armResponse(tabId, message) {
      calls.push("arm")
      expect(stored?.expectedResponse).toEqual(message.expected)
      return {
        type: "arm-response-result",
        ok: true,
        sessionId: message.expected.sessionId,
        waitId: message.expected.waitId,
      }
    },
    async prepareSubmission(tabId, message) {
      calls.push("prepare")
      options.onPrepare?.(stored)
      signalPrepareStarted?.()
      if (options.deferPrepare) return deferredPrepared
      return {
        type: "transfer-prepared",
        sessionId: message.sessionId,
        transferId: message.transferId,
        waitId: message.waitId,
        baselineMessageId: "assistant-b-before",
        conversationIdentity:
          "preparedConversationIdentity" in options
            ? options.preparedConversationIdentity ?? null
            : tabId === 11
              ? currentAIdentity
              : currentTargetIdentity,
      }
    },
    async commitSubmission(tabId, message) {
      calls.push("commit")
      options.beforeCommit?.(message)
      const targetIdentity = tabId === 11 ? currentAIdentity : currentTargetIdentity
      if (message.authorizedConversationIdentity !== targetIdentity) {
        throw new RelayTransportError({
          command: "commit-transfer",
          tabId,
          sessionId: message.sessionId,
          transferId: message.transferId,
          waitId: message.waitId,
          reason: "conversation-changed",
        })
      }
      if (options.deferCommit && !deferredCommitUsed) {
        deferredCommitUsed = true
        signalCommitStarted?.()
        const committed = await deferredCommitted
        currentTargetIdentity = committed.conversationIdentity
        commitEffects += 1
        return committed
      }
      commitEffects += 1
      const conversationIdentity =
        options.committedConversationIdentity ?? targetIdentity ?? "conversation-created-b"
      if (tabId === 11) currentAIdentity = conversationIdentity
      else currentTargetIdentity = conversationIdentity
      return {
        type: "transfer-committed",
        sessionId: message.sessionId,
        transferId: message.transferId,
        waitId: message.waitId,
        userMessageId: "user-created-b",
        conversationIdentity,
      }
    },
    async bindExpectedUserTurn(tabId, message) {
      calls.push("bind")
      expect(stored?.expectedResponse?.causedByUserMessageId).toBe(message.userMessageId)
      return {
        type: "bind-expected-user-turn-result",
        ok: true,
        sessionId: message.sessionId,
        waitId: message.waitId,
      }
    },
    async cancelSubmission(tabId, message) {
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
    tabs: { async queryCurrentWindow() { return pairTabs } },
    transport,
  })
  return {
    controller,
    calls,
    sessions,
    writes,
    prepareStarted,
    commitStarted,
    commitEffects: () => commitEffects,
    current: () => stored,
    inspectCalls: () => inspectCalls,
    setCurrentTargetIdentity: (identity: string | null) => {
      currentTargetIdentity = identity
    },
    resolvePrepared: (prepared: TransferPreparedMessage) => resolveDeferredPrepare?.(prepared),
    resolveCommitted: (committed: TransferCommittedMessage) => resolveDeferredCommit?.(committed),
  }
}

async function startAndBindA(harness: ReturnType<typeof createTransferHarness>): Promise<RelaySession> {
  const started = await harness.controller.start()
  const expected = started.expectedResponse
  if (expected === undefined) throw new Error("missing start wait")
  await harness.controller.handleInitialUserTurnObserved(11, {
    type: "initial-user-turn-observed",
    sessionId: started.id,
    waitId: expected.waitId,
    userMessageId: "user-start-a",
    conversationIdentity: "conversation-a",
  })
  const bound = harness.current()
  if (bound === null) throw new Error("missing bound relay session")
  harness.calls.splice(0)
  return bound
}

function sourceCompletion(session: RelaySession): AssistantCompleteMessage {
  const expected = session.expectedResponse
  if (expected === undefined || expected.causedByUserMessageId === undefined) {
    throw new Error("missing source causal wait")
  }
  return {
    type: "assistant-complete",
    sessionId: session.id,
    waitId: expected.waitId,
    causedByUserMessageId: expected.causedByUserMessageId,
    message: { messageId: "assistant-a-next", text: "synthetic response", textHash: "response-hash" },
  }
}

describe("RelayController automated transfer", () => {
  it("persists PendingTransfer before target prepare and commits a bound target", async () => {
    const harness = createTransferHarness({
      onPrepare(session) {
        expect(session?.state).toBe("dispatching-b")
        expect(session?.pendingTransfer?.submissionState).toBe("preparing")
      },
    })
    const active = await startAndBindA(harness)

    await harness.controller.handleAssistantComplete(11, sourceCompletion(active))

    expect(harness.calls).toEqual(["prepare", "arm", "commit", "bind"])
    expect(harness.commitEffects()).toBe(1)
    expect(harness.current()).toMatchObject({
      state: "waiting-b",
      turn: 1,
      conversationB: { state: "bound", conversationIdentity: "conversation-b" },
      expectedResponse: {
        side: "b",
        causedByTransferId: expect.any(String),
        causedByUserMessageId: "user-created-b",
      },
      pendingTransfer: {
        sourceMessageId: "assistant-a-next",
        targetUserMessageId: "user-created-b",
        submissionState: "committed",
      },
    })
  })

  it("rejects target conversation replacement before commit authorization", async () => {
    const harness = createTransferHarness({ preparedConversationIdentity: "conversation-other" })
    const active = await startAndBindA(harness)

    await harness.controller.handleAssistantComplete(11, sourceCompletion(active))

    expect(harness.current()).toMatchObject({ state: "error", stopReason: "conversation-changed" })
    expect(harness.calls).toEqual(["prepare"])
    expect(harness.commitEffects()).toBe(0)
  })

  it("does not adopt an unbound target observed during revalidation", async () => {
    const harness = createTransferHarness({
      targetConversationAtStart: null,
      preparedConversationIdentity: "unrelated-conversation",
    })
    const active = await startAndBindA(harness)

    await harness.controller.handleAssistantComplete(11, sourceCompletion(active))

    expect(harness.current()).toMatchObject({
      state: "error",
      stopReason: "conversation-changed",
      conversationB: { state: "unbound" },
    })
    expect(harness.calls).toEqual(["prepare"])
    expect(harness.commitEffects()).toBe(0)
  })

  it("authorizes the prepared identity but blocks commit if the page changes before UI send", async () => {
    const harness = createTransferHarness({
      beforeCommit() {
        harness.setCurrentTargetIdentity("conversation-changed-before-send")
      },
    })
    const active = await startAndBindA(harness)

    await expect(harness.controller.handleAssistantComplete(11, sourceCompletion(active))).rejects.toThrow(
      new RelayDomainError("conversation-changed"),
    )

    expect(harness.current()).toMatchObject({ state: "error", stopReason: "conversation-changed" })
    expect(harness.calls).toEqual(["prepare", "arm", "commit"])
    expect(harness.commitEffects()).toBe(0)
  })

  it("persists causedByTransferId and target wait before requesting commit", async () => {
    const harness = createTransferHarness({
      onPrepare(session) {
        expect(session?.state).toBe("dispatching-b")
        expect(session?.expectedResponse).toBeUndefined()
      },
      beforeCommit(message) {
        expect(harness.current()?.expectedResponse).toMatchObject({
          sessionId: message.sessionId,
          waitId: message.waitId,
          causedByTransferId: message.transferId,
        })
        expect(harness.current()?.pendingTransfer?.submissionState).toBe("authorized")
      },
    })
    const active = await startAndBindA(harness)

    await harness.controller.handleAssistantComplete(11, sourceCompletion(active))

    expect(harness.current()?.expectedResponse?.causedByTransferId).toBe(
      harness.current()?.pendingTransfer?.id,
    )
  })

  it("binds an unbound target only to its first committed relay prompt", async () => {
    const harness = createTransferHarness({
      targetConversationAtStart: null,
      preparedConversationIdentity: null,
      committedConversationIdentity: "conversation-created-by-relay",
    })
    const active = await startAndBindA(harness)

    await harness.controller.handleAssistantComplete(11, sourceCompletion(active))

    expect(harness.current()?.conversationB).toEqual({
      state: "bound",
      conversationIdentity: "conversation-created-by-relay",
    })
    expect(harness.current()?.pendingTransfer?.targetUserMessageId).toBe("user-created-b")
    expect(harness.current()?.expectedResponse?.causedByUserMessageId).toBe("user-created-b")
  })

  it("rejects assistant completion with wrong ancestry despite the correct transfer ID", async () => {
    const harness = createTransferHarness()
    const active = await startAndBindA(harness)
    await harness.controller.handleAssistantComplete(11, sourceCompletion(active))
    const waitingB = harness.current()
    if (waitingB === null || waitingB.expectedResponse === undefined) throw new Error("missing B wait")

    await harness.controller.handleAssistantComplete(12, {
      type: "assistant-complete",
      sessionId: waitingB.id,
      waitId: waitingB.expectedResponse.waitId,
      ...(waitingB.expectedResponse.causedByTransferId === undefined
        ? {}
        : { causedByTransferId: waitingB.expectedResponse.causedByTransferId }),
      causedByUserMessageId: "wrong-user-ancestry",
      message: { messageId: "assistant-b-wrong", text: "wrong", textHash: "wrong-hash" },
    })

    expect(harness.current()).toMatchObject({ state: "error", stopReason: "relay-causality-ambiguous" })
    expect(harness.current()?.turn).toBe(1)
  })

  it("ignores stale source session and wait identities", async () => {
    const harness = createTransferHarness()
    const active = await startAndBindA(harness)
    const before = harness.current()
    const completion = sourceCompletion(active)

    await harness.controller.handleAssistantComplete(11, { ...completion, sessionId: "stale-session" })
    await harness.controller.handleAssistantComplete(11, { ...completion, waitId: "stale-wait" })

    expect(harness.current()).toEqual(before)
    expect(harness.calls).toEqual([])
  })

  it("accepts a buffered early target completion only after committed user binding", async () => {
    const harness = createTransferHarness({ deferCommit: true })
    const active = await startAndBindA(harness)
    const dispatching = harness.controller.handleAssistantComplete(11, sourceCompletion(active))
    await harness.commitStarted
    const waitingB = harness.current()
    if (waitingB === null || waitingB.expectedResponse === undefined) throw new Error("missing B wait")
    const earlyEvent: AssistantCompleteMessage = {
      type: "assistant-complete",
      sessionId: waitingB.id,
      waitId: waitingB.expectedResponse.waitId,
      ...(waitingB.expectedResponse.causedByTransferId === undefined
        ? {}
        : { causedByTransferId: waitingB.expectedResponse.causedByTransferId }),
      causedByUserMessageId: "user-created-b",
      message: { messageId: "assistant-b-early", text: "early", textHash: "early-hash" },
    }

    await harness.controller.handleAssistantComplete(12, earlyEvent)
    expect(harness.current()?.turn).toBe(0)
    expect(harness.current()?.lastMessageB).toBeUndefined()

    harness.resolveCommitted({
      type: "transfer-committed",
      sessionId: waitingB.id,
      transferId: waitingB.pendingTransfer?.id ?? "missing-transfer",
      waitId: waitingB.expectedResponse.waitId,
      userMessageId: "user-created-b",
      conversationIdentity: "conversation-b",
    })
    await dispatching

    await harness.controller.handleAssistantComplete(12, earlyEvent)

    expect(harness.current()?.turn).toBe(2)
    expect(harness.current()?.lastMessageB).toBe("assistant-b-early")
  })

  it("increments turn only after target commit acknowledgement", async () => {
    const harness = createTransferHarness({
      onPrepare(session) {
        expect(session?.turn).toBe(0)
      },
      beforeCommit() {
        expect(harness.current()?.turn).toBe(0)
      },
    })
    const active = await startAndBindA(harness)

    await harness.controller.handleAssistantComplete(11, sourceCompletion(active))

    expect(harness.current()?.turn).toBe(1)
  })

  it("stops before creating transfer 11 when maxTurns is 10", async () => {
    const harness = createTransferHarness()
    const active = await startAndBindA(harness)
    const atLimit = harness.current()
    if (atLimit === null) throw new Error("missing active session")
    await harness.sessions.write({ ...atLimit, revision: atLimit.revision + 1, turn: 10 })
    const beforeCalls = [...harness.calls]
    const beforeInspectCalls = harness.inspectCalls()

    await harness.controller.handleAssistantComplete(
      11,
      sourceCompletion({ ...atLimit, revision: atLimit.revision + 1, turn: 10 }),
    )

    const stopped = harness.current()
    expect(stopped).toMatchObject({ state: "stopped", stopReason: "max-turns-reached", turn: 10 })
    expect(stopped === null || "pendingTransfer" in stopped).toBe(false)
    expect(harness.calls).toEqual(beforeCalls)
    expect(harness.inspectCalls()).toBe(beforeInspectCalls)

    if (stopped === null) throw new Error("missing max-turn terminal session")
    await harness.controller.handleAssistantComplete(11, sourceCompletion(active))
    await harness.controller.handleTransferPrepared(12, {
      type: "transfer-prepared",
      sessionId: stopped.id,
      transferId: "stale-transfer",
      waitId: "stale-wait",
      baselineMessageId: null,
      conversationIdentity: "conversation-b",
    })
    await harness.controller.handleTransferCommitted(12, {
      type: "transfer-committed",
      sessionId: stopped.id,
      transferId: "stale-transfer",
      waitId: "stale-wait",
      userMessageId: "stale-user",
      conversationIdentity: "conversation-b",
    })
    expect(harness.current()).toEqual(stopped)
  })

  it("does not let stale deferred prepare completion restore a newer terminal state", async () => {
    const harness = createTransferHarness({ deferPrepare: true })
    const active = await startAndBindA(harness)
    const inFlight = harness.controller.handleAssistantComplete(11, sourceCompletion(active))
    await harness.prepareStarted
    const dispatching = harness.current()
    if (dispatching === null || dispatching.pendingTransfer === undefined) throw new Error("missing transfer")
    await harness.controller.withTransition(
      {
        sessionId: dispatching.id,
        revision: dispatching.revision,
        transferId: dispatching.pendingTransfer.id,
      },
      (current) => {
        const { expectedResponse: _expectedResponse, pendingTransfer: _pendingTransfer, ...retained } = current
        return {
          nextSession: { ...retained, state: "stopped", turn: 10, stopReason: "max-turns-reached" },
          result: undefined,
        }
      },
    )
    harness.resolvePrepared({
      type: "transfer-prepared",
      sessionId: dispatching.id,
      transferId: dispatching.pendingTransfer.id,
      waitId: dispatching.pendingTransfer.targetWaitId,
      baselineMessageId: "assistant-b-before",
      conversationIdentity: "conversation-b",
    })

    await inFlight

    expect(harness.current()).toMatchObject({ state: "stopped", stopReason: "max-turns-reached", turn: 10 })
    expect(harness.calls).toEqual(["prepare"])
  })

  it("does not let a deferred committed acknowledgement restore max-turn terminal state", async () => {
    const harness = createTransferHarness({ deferCommit: true })
    const active = await startAndBindA(harness)
    const inFlight = harness.controller.handleAssistantComplete(11, sourceCompletion(active))
    await harness.commitStarted
    const dispatching = harness.current()
    if (
      dispatching === null ||
      dispatching.pendingTransfer === undefined ||
      dispatching.expectedResponse === undefined
    ) {
      throw new Error("missing authorized transfer")
    }
    await harness.controller.withTransition(
      {
        sessionId: dispatching.id,
        revision: dispatching.revision,
        transferId: dispatching.pendingTransfer.id,
        waitId: dispatching.expectedResponse.waitId,
      },
      (current) => {
        const { expectedResponse: _expectedResponse, pendingTransfer: _pendingTransfer, ...retained } = current
        return {
          nextSession: { ...retained, state: "stopped", turn: 10, stopReason: "max-turns-reached" },
          result: undefined,
        }
      },
    )
    harness.resolveCommitted({
      type: "transfer-committed",
      sessionId: dispatching.id,
      transferId: dispatching.pendingTransfer.id,
      waitId: dispatching.pendingTransfer.targetWaitId,
      userMessageId: "user-created-b",
      conversationIdentity: "conversation-b",
    })

    await inFlight
    await harness.controller.handleAssistantComplete(11, sourceCompletion(active))

    expect(harness.current()).toMatchObject({
      state: "stopped",
      turn: 10,
      stopReason: "max-turns-reached",
    })
  })

  it("ignores stale transfer identifiers without advancing the session", async () => {
    const harness = createTransferHarness({ deferPrepare: true })
    const active = await startAndBindA(harness)
    const inFlight = harness.controller.handleAssistantComplete(11, sourceCompletion(active))
    await harness.prepareStarted
    const dispatching = harness.current()
    if (dispatching === null || dispatching.pendingTransfer === undefined) throw new Error("missing transfer")
    const before = dispatching

    await harness.controller.handleTransferPrepared(12, {
      type: "transfer-prepared",
      sessionId: dispatching.id,
      transferId: "stale-transfer",
      waitId: dispatching.pendingTransfer.targetWaitId,
      baselineMessageId: null,
      conversationIdentity: "conversation-b",
    })

    expect(harness.current()).toEqual(before)
    harness.resolvePrepared({
      type: "transfer-prepared",
      sessionId: dispatching.id,
      transferId: dispatching.pendingTransfer.id,
      waitId: dispatching.pendingTransfer.targetWaitId,
      baselineMessageId: "assistant-b-before",
      conversationIdentity: "conversation-b",
    })
    await inFlight
  })
})
