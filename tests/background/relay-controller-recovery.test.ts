import { describe, expect, it } from "vitest"
import type { AdapterSnapshot, CancelSubmissionResult, RelaySession } from "../../src/shared/domain"
import { RelayController } from "../../src/background/relay-controller"
import type { RelayTransport } from "../../src/background/relay-controller"
import type { RelayPreferencesStore, RelaySessionStore } from "../../src/background/session-store"
import { TransitionQueue } from "../../src/background/transition-queue"
import type { TabSnapshot } from "../../src/background/split-view"
import type { TransferCommittedMessage } from "../../src/shared/protocol"

const tabs: readonly TabSnapshot[] = [
  { id: 11, windowId: 3, active: true, url: "https://chatgpt.com/c/a", splitViewId: 8 },
  { id: 12, windowId: 3, active: false, url: "https://chatgpt.com/c/b", splitViewId: 8 },
]

function waitingSession(overrides: Partial<RelaySession> = {}): RelaySession {
  return {
    id: "session-1",
    revision: 5,
    splitViewId: 8,
    tabA: 11,
    tabB: 12,
    conversationA: { state: "bound", conversationIdentity: "conversation-a" },
    conversationB: { state: "bound", conversationIdentity: "conversation-b" },
    state: "waiting-b",
    turn: 1,
    maxTurns: 10,
    lastMessageA: "assistant-a-1",
    expectedResponse: {
      sessionId: "session-1",
      waitId: "wait-b-1",
      side: "b",
      tabId: 12,
      baselineMessageId: "assistant-b-before",
      causedByTransferId: "transfer-1",
      causedByUserMessageId: "user-b-1",
    },
    pendingTransfer: {
      id: "transfer-1",
      sourceTabId: 11,
      targetTabId: 12,
      sourceMessageId: "assistant-a-1",
      payloadHash: "payload-hash",
      targetWaitId: "wait-b-1",
      targetBaselineMessageId: "assistant-b-before",
      targetUserMessageId: "user-b-1",
      authorizationRevision: 4,
      submissionState: "committed",
    },
    ...overrides,
  }
}

type RecoveryOptions = {
  readonly session?: RelaySession | null
  readonly identityA?: string | null
  readonly identityB?: string | null
  readonly latestUserA?: AdapterSnapshot["latestUser"]
  readonly latestUserB?: AdapterSnapshot["latestUser"]
  readonly cancelResult?: CancelSubmissionResult
  readonly deferInspect?: boolean
}

function createHarness(options: RecoveryOptions = {}) {
  let stored = options.session === undefined ? waitingSession() : options.session
  let identityA = "identityA" in options ? options.identityA ?? null : "conversation-a"
  let identityB = "identityB" in options ? options.identityB ?? null : "conversation-b"
  let releaseInspect: (() => void) | undefined
  let signalInspect: (() => void) | undefined
  const inspectStarted = new Promise<void>((resolve) => { signalInspect = resolve })
  const deferredInspect = new Promise<void>((resolve) => { releaseInspect = resolve })
  let inspectionHeld = options.deferInspect ?? false
  const calls: string[] = []
  const armed: unknown[] = []
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
      calls.push(`inspect-${tabId}`)
      if (inspectionHeld) {
        inspectionHeld = false
        signalInspect?.()
        await deferredInspect
      }
      return {
        type: "adapter-inspect-result",
        snapshot: {
          ready: true,
          generating: false,
          conversationIdentity: tabId === 11 ? identityA : identityB,
          latestUser:
            tabId === 11
              ? options.latestUserA ?? { messageId: "user-a-1", role: "user", textHash: "user-a-hash" }
              : options.latestUserB ?? { messageId: "user-b-1", role: "user", textHash: "user-b-hash" },
          latestAssistant:
            tabId === 11
              ? { messageId: "assistant-a-1", text: "assistant A", textHash: "assistant-a-hash" }
              : { messageId: "assistant-b-before", text: "assistant B", textHash: "assistant-b-hash" },
        },
      }
    },
    async armResponse(tabId, message) {
      calls.push(`arm-${tabId}`)
      armed.push(message.expected)
      return {
        type: "arm-response-result",
        ok: true,
        sessionId: message.expected.sessionId,
        waitId: message.expected.waitId,
      }
    },
    async prepareSubmission() {
      calls.push("prepare")
      throw new Error("recovery must never resend")
    },
    async commitSubmission() {
      calls.push("commit")
      throw new Error("recovery must never commit")
    },
    async bindExpectedUserTurn(tabId, message) {
      calls.push(`bind-${tabId}`)
      return {
        type: "bind-expected-user-turn-result",
        ok: true,
        sessionId: message.sessionId,
        waitId: message.waitId,
      }
    },
    async cancelSubmission(tabId, message) {
      calls.push("cancel")
      const result = options.cancelResult ?? { status: "unknown", transferId: message.transferId }
      return {
        type: "cancel-transfer-result",
        sessionId: message.sessionId,
        result: { ...result, transferId: message.transferId },
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
    armed,
    current: () => stored,
    inspectStarted,
    releaseInspect: () => releaseInspect?.(),
    setIdentityA: (value: string | null) => { identityA = value },
    setIdentityB: (value: string | null) => { identityB = value },
  }
}

describe("RelayController recovery", () => {
  it("returns persisted active state without resending or inspecting", async () => {
    const original = waitingSession()
    const harness = createHarness({ session: original })

    await expect(harness.controller.recoverActiveSession()).resolves.toEqual(original)

    expect(harness.calls).toEqual([])
  })

  it("rearms only the persisted wait when bound conversation and causal user match", async () => {
    const original = waitingSession()
    const harness = createHarness({ session: original, latestUserB: { messageId: "user-b-1", role: "user", textHash: "new-hash" } })

    await expect(harness.controller.recoverTab(12)).resolves.toMatchObject({
      id: original.id,
      revision: original.revision,
      expectedResponse: { waitId: "wait-b-1", causedByUserMessageId: "user-b-1" },
    })

    expect(harness.armed).toEqual([original.expectedResponse])
    expect(harness.calls).toEqual(["inspect-12", "arm-12"])
  })

  it("fails closed on a different bound conversation without arming a new wait", async () => {
    const harness = createHarness({ identityB: "conversation-replaced" })

    const recovered = await harness.controller.recoverTab(12)
    expect(recovered).toMatchObject({
      state: "error",
      stopReason: "conversation-changed",
    })
    expect(recovered === null || "expectedResponse" in recovered).toBe(false)
    expect(recovered === null || "pendingTransfer" in recovered).toBe(false)
    expect(harness.armed).toEqual([])
    expect(harness.calls).toEqual(["inspect-12"])
  })

  it("fails closed when a bound conversation identity is unavailable", async () => {
    const harness = createHarness({ identityB: null })

    await expect(harness.controller.recoverTab(12)).resolves.toMatchObject({
      state: "error",
      stopReason: "conversation-changed",
    })
    expect(harness.armed).toEqual([])
  })

  it("does not bind an unbound new chat during reload-only recovery", async () => {
    const sessionWithPending = waitingSession({
      conversationA: { state: "unbound" },
      conversationB: { state: "unbound" },
      state: "waiting-a",
      expectedResponse: {
        sessionId: "session-1",
        waitId: "wait-a-new",
        side: "a",
        tabId: 11,
        baselineMessageId: null,
      },
    })
    const { pendingTransfer: _pendingTransfer, ...original } = sessionWithPending
    const harness = createHarness({
      session: original,
      identityA: null,
      latestUserA: null,
    })

    await expect(harness.controller.recoverTab(11)).resolves.toMatchObject({
      conversationA: { state: "unbound" },
      expectedResponse: { waitId: "wait-a-new" },
    })
    expect(harness.armed).toEqual([original.expectedResponse])

    harness.setIdentityA("unrelated-navigation")
    await expect(harness.controller.recoverTab(11)).resolves.toMatchObject({
      state: "error",
      stopReason: "conversation-changed",
    })
  })

  it("reconciles an interrupted committed transfer with the exact target user evidence once", async () => {
    const original = waitingSession({
      state: "dispatching-b",
      expectedResponse: {
        sessionId: "session-1",
        waitId: "wait-b-1",
        side: "b",
        tabId: 12,
        baselineMessageId: "assistant-b-before",
        causedByTransferId: "transfer-1",
      },
      pendingTransfer: {
        id: "transfer-1",
        sourceTabId: 11,
        targetTabId: 12,
        sourceMessageId: "assistant-a-1",
        payloadHash: "payload-hash",
        targetWaitId: "wait-b-1",
        targetBaselineMessageId: "assistant-b-before",
        authorizationRevision: 4,
        submissionState: "authorized",
      },
    })
    const harness = createHarness({
      session: original,
      cancelResult: {
        status: "already-committed",
        transferId: "transfer-1",
        userMessageId: "user-reconciled-b",
        conversationIdentity: "conversation-b",
      },
      latestUserB: { messageId: "user-reconciled-b", role: "user", textHash: "user-hash" },
    })

    await harness.controller.recoverTab(12)

    expect(harness.current()).toMatchObject({
      state: "waiting-b",
      turn: 2,
      expectedResponse: {
        waitId: "wait-b-1",
        causedByTransferId: "transfer-1",
        causedByUserMessageId: "user-reconciled-b",
      },
      pendingTransfer: {
        targetUserMessageId: "user-reconciled-b",
        submissionState: "committed",
      },
    })
    expect(harness.calls).toEqual(["inspect-12", "cancel", "bind-12", "arm-12"])
  })

  it("fails closed on ambiguous interrupted transfer without retrying", async () => {
    const original = waitingSession({
      state: "dispatching-b",
      expectedResponse: {
        sessionId: "session-1",
        waitId: "wait-b-1",
        side: "b",
        tabId: 12,
        baselineMessageId: "assistant-b-before",
        causedByTransferId: "transfer-1",
      },
      pendingTransfer: {
        id: "transfer-1",
        sourceTabId: 11,
        targetTabId: 12,
        sourceMessageId: "assistant-a-1",
        payloadHash: "payload-hash",
        targetWaitId: "wait-b-1",
        authorizationRevision: 4,
        submissionState: "authorized",
      },
    })
    const harness = createHarness({ session: original, cancelResult: { status: "unknown", transferId: "transfer-1" } })

    await expect(harness.controller.recoverTab(12)).resolves.toMatchObject({
      state: "error",
      stopReason: "recovery-ambiguous",
    })
    expect(harness.calls).toEqual(["inspect-12", "cancel"])
  })

  it("does not let a stale recovery inspection overwrite a newer revision", async () => {
    const original = waitingSession()
    const harness = createHarness({ session: original, deferInspect: true })
    const recovery = harness.controller.recoverTab(12)
    await harness.inspectStarted
    await harness.controller.withTransition(
      { sessionId: original.id, revision: original.revision },
      (current) => ({
        nextSession: (() => {
          const { expectedResponse: _expectedResponse, pendingTransfer: _pendingTransfer, ...retained } = current
          return { ...retained, state: "error", stopReason: "conversation-changed" }
        })(),
        result: undefined,
      }),
    )
    harness.releaseInspect()

    await expect(recovery).resolves.toMatchObject({
      state: "error",
      stopReason: "conversation-changed",
    })
    expect(harness.armed).toEqual([])
  })
})
