import { describe, expect, it } from "vitest"
import type { CancelSubmissionResult, RelaySession } from "../../src/shared/domain"
import { RelayDomainError, RelayTransportError } from "../../src/shared/errors"
import { RelayController } from "../../src/background/relay-controller"
import type { RelayTransport } from "../../src/background/relay-controller"
import type { RelayPreferencesStore, RelaySessionStore } from "../../src/background/session-store"
import { TransitionQueue } from "../../src/background/transition-queue"
import type { TabSnapshot } from "../../src/background/split-view"
import type {
  AssistantCompleteMessage,
  CancelTransferResult,
  InitialUserTurnObservedMessage,
  TransferCommittedMessage,
  TransferPreparedMessage,
} from "../../src/shared/protocol"

const tabs: readonly TabSnapshot[] = [
  { id: 11, windowId: 3, active: true, url: "https://chatgpt.com/c/a", splitViewId: 8 },
  { id: 12, windowId: 3, active: false, url: "https://chatgpt.com/c/b", splitViewId: 8 },
]

type StopHarnessOptions = {
  readonly cancelResult?: CancelSubmissionResult
  readonly cancelFailure?: Error
}

function createHarness(options: StopHarnessOptions = {}) {
  let stored: RelaySession | null = null
  let holdPrepare = false
  let holdArm = false
  let holdCommit = false
  let holdSourceInspect = false
  let resolvePrepare: ((result: TransferPreparedMessage) => void) | undefined
  let resolveArm: (() => void) | undefined
  let resolveCommit: ((result: TransferCommittedMessage) => void) | undefined
  let resolveSourceInspect: (() => void) | undefined
  let signalPrepare: (() => void) | undefined
  let signalArm: (() => void) | undefined
  let signalCommit: (() => void) | undefined
  let signalSourceInspect: (() => void) | undefined
  const calls: string[] = []
  const prepareStarted = new Promise<void>((resolve) => { signalPrepare = resolve })
  const armStarted = new Promise<void>((resolve) => { signalArm = resolve })
  const commitStarted = new Promise<void>((resolve) => { signalCommit = resolve })
  const sourceInspectStarted = new Promise<void>((resolve) => { signalSourceInspect = resolve })
  const deferredPrepared = new Promise<TransferPreparedMessage>((resolve) => { resolvePrepare = resolve })
  const deferredCommitted = new Promise<TransferCommittedMessage>((resolve) => { resolveCommit = resolve })
  const deferredSourceInspect = new Promise<void>((resolve) => { resolveSourceInspect = resolve })
  const sessions: RelaySessionStore = {
    async read() { return stored },
    async write(session) { stored = session },
    async clear() { stored = null },
  }
  const preferences: RelayPreferencesStore = {
    async readMaxTurns() { return 10 },
    async writeMaxTurns() {},
  }
  const transport: RelayTransport = {
    async inspect(tabId) {
      if (tabId === 11 && holdSourceInspect) {
        holdSourceInspect = false
        signalSourceInspect?.()
        await deferredSourceInspect
      }
      return {
        type: "adapter-inspect-result",
        snapshot: {
          ready: true,
          generating: false,
          conversationIdentity: tabId === 11 ? "conversation-a" : "conversation-b",
          latestUser: null,
          latestAssistant: {
            messageId: tabId === 11 ? "assistant-a-before" : "assistant-b-before",
            text: "prior response",
            textHash: "prior-hash",
          },
        },
      }
    },
    async armResponse(tabId, message) {
      if (holdArm) {
        holdArm = false
        signalArm?.()
        await new Promise<void>((resolve) => { resolveArm = resolve })
      }
      return {
        type: "arm-response-result",
        ok: true,
        sessionId: message.expected.sessionId,
        waitId: message.expected.waitId,
      }
    },
    async prepareSubmission(tabId, message) {
      calls.push("prepare")
      if (holdPrepare) {
        holdPrepare = false
        signalPrepare?.()
        return deferredPrepared
      }
      return {
        type: "transfer-prepared",
        sessionId: message.sessionId,
        transferId: message.transferId,
        waitId: message.waitId,
        baselineMessageId: "assistant-b-before",
        conversationIdentity: "conversation-b",
      }
    },
    async commitSubmission(tabId, message) {
      calls.push("commit")
      if (holdCommit) {
        holdCommit = false
        signalCommit?.()
        return deferredCommitted
      }
      return {
        type: "transfer-committed",
        sessionId: message.sessionId,
        transferId: message.transferId,
        waitId: message.waitId,
        userMessageId: "user-created-b",
        conversationIdentity: "conversation-b",
      }
    },
    async bindExpectedUserTurn(tabId, message) {
      return {
        type: "bind-expected-user-turn-result",
        ok: true,
        sessionId: message.sessionId,
        waitId: message.waitId,
      }
    },
    async cancelSubmission(tabId, message): Promise<CancelTransferResult> {
      calls.push("cancel")
      if (options.cancelFailure !== undefined) throw options.cancelFailure
      const configured = options.cancelResult
      const result: CancelSubmissionResult =
        configured === undefined
          ? { status: "cancelled-before-commit", transferId: message.transferId }
          : { ...configured, transferId: message.transferId }
      return {
        type: "cancel-transfer-result",
        sessionId: message.sessionId,
        result,
      }
    },
  }
  const controller = new RelayController({
    sessions,
    preferences,
    queue: new TransitionQueue(),
    tabs: { async queryCurrentWindow() { return tabs } },
    transport,
  })
  return {
    controller,
    calls,
    sessions,
    current: () => stored,
    holdNextPrepare: () => { holdPrepare = true },
    holdNextArm: () => { holdArm = true },
    holdNextCommit: () => { holdCommit = true },
    holdNextSourceInspect: () => { holdSourceInspect = true },
    prepareStarted,
    armStarted,
    commitStarted,
    sourceInspectStarted,
    resolvePrepare: (result: TransferPreparedMessage) => resolvePrepare?.(result),
    resolveArm: () => resolveArm?.(),
    resolveCommit: (result: TransferCommittedMessage) => resolveCommit?.(result),
    resolveSourceInspect: () => resolveSourceInspect?.(),
  }
}

async function startAndBind(harness: ReturnType<typeof createHarness>): Promise<RelaySession> {
  const started = await harness.controller.start()
  const expected = started.expectedResponse
  if (expected === undefined) throw new Error("missing initial wait")
  const event: InitialUserTurnObservedMessage = {
    type: "initial-user-turn-observed",
    sessionId: started.id,
    waitId: expected.waitId,
    userMessageId: "user-initial-a",
    conversationIdentity: "conversation-a",
  }
  await harness.controller.handleInitialUserTurnObserved(11, event)
  const active = harness.current()
  if (active === null) throw new Error("missing active session")
  return active
}

function sourceCompletion(session: RelaySession): AssistantCompleteMessage {
  const expected = session.expectedResponse
  if (expected === undefined || expected.causedByUserMessageId === undefined) {
    throw new Error("missing causal wait")
  }
  return {
    type: "assistant-complete",
    sessionId: session.id,
    waitId: expected.waitId,
    causedByUserMessageId: expected.causedByUserMessageId,
    message: { messageId: "assistant-a-complete", text: "synthetic", textHash: "hash" },
  }
}

describe("RelayController Stop linearization", () => {
  it("stops immediately when there is no in-flight transfer", async () => {
    const harness = createHarness()
    const active = await startAndBind(harness)

    const stopped = await harness.controller.stop(active.id)

    expect(stopped.state).toBe("stopped")
    expect(stopped.stopReason).toBe("stopped-by-user")
    expect(harness.calls).toEqual([])
  })

  it("cancels a transfer during prepare before commit authorization", async () => {
    const harness = createHarness()
    const active = await startAndBind(harness)
    harness.holdNextPrepare()
    const dispatch = harness.controller.handleAssistantComplete(11, sourceCompletion(active))
    await harness.prepareStarted
    const pending = harness.current()?.pendingTransfer
    if (pending === undefined) throw new Error("missing pending transfer fixture")

    const stopped = await harness.controller.stop(active.id)
    expect(stopped.state).toBe("stopped")
    expect(harness.calls).toEqual(["prepare", "cancel"])

    harness.resolvePrepare({
      type: "transfer-prepared",
      sessionId: active.id,
      transferId: pending.id,
      waitId: pending.targetWaitId,
      baselineMessageId: "assistant-b-before",
      conversationIdentity: "conversation-b",
    })
    await dispatch
    expect(harness.current()?.state).toBe("stopped")
    expect(harness.calls).not.toContain("commit")
  })

  it("cancels after authorization but before commit activation", async () => {
    const harness = createHarness()
    const active = await startAndBind(harness)
    harness.holdNextArm()
    const dispatch = harness.controller.handleAssistantComplete(11, sourceCompletion(active))
    await harness.armStarted

    const stopped = await harness.controller.stop(active.id)
    expect(stopped.state).toBe("stopped")
    expect(harness.calls).toEqual(["prepare", "cancel"])

    harness.resolveArm()
    await dispatch
    expect(harness.current()?.state).toBe("stopped")
    expect(harness.calls).not.toContain("commit")
  })

  it("reconciles one committed transfer after Stop and never starts its peer transfer", async () => {
    const harness = createHarness({
      cancelResult: {
        status: "already-committed",
        transferId: "placeholder",
        userMessageId: "user-created-b",
        conversationIdentity: "conversation-b",
      },
    })
    const active = await startAndBind(harness)
    harness.holdNextCommit()
    const dispatch = harness.controller.handleAssistantComplete(11, sourceCompletion(active))
    await harness.commitStarted
    const inFlight = harness.current()
    if (inFlight?.pendingTransfer === undefined) throw new Error("missing authorized transfer")

    const stopped = await harness.controller.stop(active.id)

    expect(stopped.state).toBe("stopped")
    expect(stopped.stopReason).toBe("stopped-by-user")
    expect(stopped.turn).toBe(1)
    expect(stopped.expectedResponse).toBeUndefined()
    expect(stopped.pendingTransfer?.targetUserMessageId).toBe("user-created-b")
    expect(harness.calls).toEqual(["prepare", "commit", "cancel"])

    harness.resolveCommit({
      type: "transfer-committed",
      sessionId: active.id,
      transferId: inFlight.pendingTransfer.id,
      waitId: inFlight.pendingTransfer.targetWaitId,
      userMessageId: "user-created-b",
      conversationIdentity: "conversation-b",
    })
    await dispatch
    expect(harness.current()?.state).toBe("stopped")
    expect(harness.calls.filter((call) => call === "prepare")).toHaveLength(1)
  })

  it("fails closed on ambiguous commit status and returns the accepted Stop state", async () => {
    const harness = createHarness({
      cancelResult: { status: "unknown", transferId: "placeholder" },
    })
    const active = await startAndBind(harness)
    harness.holdNextCommit()
    const dispatch = harness.controller.handleAssistantComplete(11, sourceCompletion(active))
    await harness.commitStarted

    const result = await harness.controller.stop(active.id)

    expect(result.state).toBe("error")
    expect(result.stopReason).toBe("recovery-ambiguous")
    harness.resolveCommit({
      type: "transfer-committed",
      sessionId: active.id,
      transferId: "stale-transfer",
      waitId: "stale-wait",
      userMessageId: "user-created-b",
      conversationIdentity: "conversation-b",
    })
    await dispatch
    expect(harness.current()?.state).toBe("error")
  })

  it("linearizes Stop before an in-flight assistant-complete continuation", async () => {
    const harness = createHarness()
    const active = await startAndBind(harness)
    harness.holdNextSourceInspect()
    const completion = harness.controller.handleAssistantComplete(11, sourceCompletion(active))
    await harness.sourceInspectStarted

    const stopped = await harness.controller.stop(active.id)
    harness.resolveSourceInspect()
    await completion

    expect(stopped.state).toBe("stopped")
    expect(harness.current()?.state).toBe("stopped")
    expect(harness.calls).toEqual([])
  })

  it("rejects Stop without a current session or with a stale session ID", async () => {
    const empty = createHarness()
    await expect(empty.controller.stop("missing")).rejects.toThrow(new RelayDomainError("invalid-session"))

    const harness = createHarness()
    const active = await startAndBind(harness)
    await expect(harness.controller.stop("stale-session")).rejects.toThrow(
      new RelayDomainError("invalid-session"),
    )
    expect(harness.current()?.id).toBe(active.id)
  })

  it.each(["stopped", "error"] as const)(
    "returns the current %s session unchanged for an idempotent Stop",
    async (state) => {
      const harness = createHarness()
      const active = await startAndBind(harness)
      const ended = await harness.controller.withTransition(
        { sessionId: active.id, revision: active.revision },
        (current) => ({
          nextSession: { ...current, state, stopReason: "stopped-by-user" },
          result: undefined,
        }),
      )
      void ended
      const terminal = harness.current()
      if (terminal === null) throw new Error("missing terminal session")

      await expect(harness.controller.stop(active.id)).resolves.toEqual(terminal)
      expect(harness.current()).toEqual(terminal)
    },
  )

  it("returns the persisted error session if accepted Stop cancellation throws a transport error", async () => {
    const failure = new RelayTransportError({
      command: "cancel-transfer",
      tabId: 12,
      sessionId: "session",
      transferId: "transfer",
      reason: "adapter-not-ready",
    })
    const harness = createHarness({ cancelFailure: failure })
    const active = await startAndBind(harness)
    harness.holdNextCommit()
    const dispatch = harness.controller.handleAssistantComplete(11, sourceCompletion(active))
    await harness.commitStarted

    const result = await harness.controller.stop(active.id)

    expect(result.state).toBe("error")
    expect(result.stopReason).toBe("adapter-not-ready")
    harness.resolveCommit({
      type: "transfer-committed",
      sessionId: active.id,
      transferId: "late",
      waitId: "late",
      userMessageId: "user-created-b",
      conversationIdentity: "conversation-b",
    })
    await dispatch
  })

  it("propagates an unexpected cancellation exception unchanged after Stop acceptance", async () => {
    const unexpected = new TypeError("unexpected cancellation bug")
    const harness = createHarness({ cancelFailure: unexpected })
    const active = await startAndBind(harness)
    harness.holdNextCommit()
    const dispatch = harness.controller.handleAssistantComplete(11, sourceCompletion(active))
    await harness.commitStarted

    await expect(harness.controller.stop(active.id)).rejects.toBe(unexpected)
    expect(harness.current()?.state).toBe("stopping")
    harness.resolveCommit({
      type: "transfer-committed",
      sessionId: active.id,
      transferId: "late",
      waitId: "late",
      userMessageId: "user-created-b",
      conversationIdentity: "conversation-b",
    })
    await dispatch
  })
})
