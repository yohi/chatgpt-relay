import { describe, expect, it } from "vitest"
import type { AdapterSnapshot, RelaySession } from "../../src/shared/domain"
import { RelayController } from "../../src/background/relay-controller"
import type { RelayTransport } from "../../src/background/relay-controller"
import type { RelayPreferencesStore, RelaySessionStore } from "../../src/background/session-store"
import { TransitionQueue } from "../../src/background/transition-queue"
import type { TabSnapshot } from "../../src/background/split-view"
import type { TranscriptInterferenceMessage } from "../../src/shared/protocol"

const pairTabs: readonly TabSnapshot[] = [
  { id: 11, windowId: 3, active: true, url: "https://chatgpt.com/c/a", splitViewId: 8 },
  { id: 12, windowId: 3, active: false, url: "https://chatgpt.com/c/b", splitViewId: 8 },
]

function activeSession(): RelaySession {
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
  }
}

type LifecycleHarnessOptions = {
  readonly identityA?: string | null
  readonly identityB?: string | null
  readonly deferInspect?: boolean
  readonly initialSession?: RelaySession
  readonly latestUserA?: AdapterSnapshot["latestUser"]
}

function createHarness(options: LifecycleHarnessOptions = {}) {
  let stored = options.initialSession ?? activeSession()
  const identityA = "identityA" in options ? options.identityA ?? null : "conversation-a"
  let identityB = "identityB" in options ? options.identityB ?? null : "conversation-b"
  let holdInspect = options.deferInspect ?? false
  let releaseInspect: (() => void) | undefined
  let signalInspect: (() => void) | undefined
  const inspectStarted = new Promise<void>((resolve) => { signalInspect = resolve })
  const deferredInspect = new Promise<void>((resolve) => { releaseInspect = resolve })
  const calls: string[] = []
  const sessions: RelaySessionStore = {
    async read() { return stored },
    async write(session) { stored = session },
    async clear() {},
  }
  const preferences: RelayPreferencesStore = {
    async readMaxTurns() { return 10 },
    async writeMaxTurns() {},
  }
  const transport: RelayTransport = {
    async inspect(tabId) {
      calls.push(`inspect-${tabId}`)
      if (holdInspect) {
        holdInspect = false
        signalInspect?.()
        await deferredInspect
      }
      return {
        type: "adapter-inspect-result",
        snapshot: {
          ready: true,
          generating: false,
          conversationIdentity: tabId === 11 ? identityA : identityB,
          latestUser: tabId === 11
            ? options.latestUserA ?? { messageId: "user-a-1", role: "user", textHash: "user-a-hash" }
            : { messageId: "user-b-1", role: "user", textHash: "user-hash" },
          latestAssistant: { messageId: "assistant-b-before", text: "prior", textHash: "prior-hash" },
        },
      }
    },
    async armResponse(tabId, message) {
      calls.push(`arm-${tabId}`)
      return {
        type: "arm-response-result",
        ok: true,
        sessionId: message.expected.sessionId,
        waitId: message.expected.waitId,
      }
    },
    async prepareSubmission() {
      calls.push("prepare")
      throw new Error("lifecycle handlers must not submit")
    },
    async commitSubmission() {
      calls.push("commit")
      throw new Error("lifecycle handlers must not commit")
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
    current: () => stored,
    inspectStarted,
    releaseInspect: () => releaseInspect?.(),
    setIdentityB: (identity: string | null) => { identityB = identity },
  }
}

function updateWithUndefinedSplitId(): { splitViewId?: number } {
  const changeInfo: { splitViewId?: number } = {}
  Object.defineProperty(changeInfo, "splitViewId", { value: undefined, enumerable: true })
  return changeInfo
}

describe("RelayController lifecycle failures", () => {
  it("allows exact first-user-turn evidence to bind an initially unbound A after route update", async () => {
    const active = activeSession()
    const { pendingTransfer: _pendingTransfer, ...retained } = active
    const initial: RelaySession = {
      ...retained,
      revision: 1,
      state: "waiting-a",
      conversationA: { state: "unbound" },
      expectedResponse: {
        sessionId: active.id,
        waitId: "initial-a-wait",
        side: "a",
        tabId: active.tabA,
        baselineMessageId: null,
      },
    }
    const harness = createHarness({
      initialSession: initial,
      identityA: "conversation-created-by-prompt",
      latestUserA: { messageId: "user-first-prompt", role: "user", textHash: "prompt-hash" },
    })

    await harness.controller.handleTabUpdated(11, { url: "https://chatgpt.com/c/conversation-created-by-prompt" })

    expect(harness.current()).toEqual(initial)
    expect(harness.calls).toEqual([])

    await harness.controller.handleInitialUserTurnObserved(11, {
      type: "initial-user-turn-observed",
      sessionId: active.id,
      waitId: "initial-a-wait",
      userMessageId: "user-first-prompt",
      conversationIdentity: "conversation-created-by-prompt",
    })

    expect(harness.current()).toMatchObject({
      state: "waiting-a",
      conversationA: { state: "bound", conversationIdentity: "conversation-created-by-prompt" },
      expectedResponse: { waitId: "initial-a-wait", causedByUserMessageId: "user-first-prompt" },
    })
  })

  it("revalidates normally when the exact initial user event arrives before the route update", async () => {
    const active = activeSession()
    const { pendingTransfer: _pendingTransfer, ...retained } = active
    const initial: RelaySession = {
      ...retained,
      revision: 1,
      state: "waiting-a",
      conversationA: { state: "unbound" },
      expectedResponse: {
        sessionId: active.id,
        waitId: "initial-a-wait",
        side: "a",
        tabId: active.tabA,
        baselineMessageId: null,
      },
    }
    const harness = createHarness({
      initialSession: initial,
      identityA: "conversation-created-by-prompt",
      latestUserA: { messageId: "user-first-prompt", role: "user", textHash: "prompt-hash" },
    })
    await harness.controller.handleInitialUserTurnObserved(11, {
      type: "initial-user-turn-observed",
      sessionId: active.id,
      waitId: "initial-a-wait",
      userMessageId: "user-first-prompt",
      conversationIdentity: "conversation-created-by-prompt",
    })
    const bound = harness.current()

    await harness.controller.handleTabUpdated(11, { url: "https://chatgpt.com/c/conversation-created-by-prompt" })

    expect(harness.current()).toEqual(bound)
    expect(harness.calls).toContain("arm-11")
  })

  it.each([11, 12])("fails closed when paired tab %i is removed", async (tabId) => {
    const harness = createHarness()

    await harness.controller.handleTabRemoved(tabId)

    expect(harness.current()).toMatchObject({ state: "error", stopReason: "tab-closed" })
    expect(harness.calls).toEqual([])
  })

  it("leaves the session unchanged when an unrelated tab is removed", async () => {
    const harness = createHarness()
    const before = harness.current()

    await harness.controller.handleTabRemoved(99)

    expect(harness.current()).toEqual(before)
  })

  it("fails closed when a paired tab navigates outside ChatGPT", async () => {
    const harness = createHarness()

    await harness.controller.handleTabUpdated(12, { url: "https://example.com/" })

    expect(harness.current()).toMatchObject({ state: "error", stopReason: "invalid-navigation" })
    expect(harness.calls).toEqual([])
  })

  it.each([
    ["none", -1],
    ["undefined after a reported change", updateWithUndefinedSplitId().splitViewId],
    ["different", 9],
  ])("fails closed when a paired Split View becomes %s", async (_name, splitViewId) => {
    const harness = createHarness()
    const changeInfo = splitViewId === undefined
      ? updateWithUndefinedSplitId()
      : { splitViewId }

    await harness.controller.handleTabUpdated(12, changeInfo)

    expect(harness.current()).toMatchObject({ state: "error", stopReason: "split-view-changed" })
  })

  it("ignores URL and Split View changes reported for an unrelated tab", async () => {
    const harness = createHarness()
    const before = harness.current()

    await harness.controller.handleTabUpdated(99, {
      url: "https://example.com/",
      splitViewId: -1,
    })

    expect(harness.current()).toEqual(before)
    expect(harness.calls).toEqual([])
  })

  it("fails closed for the exact current session and wait transcript-interference event", async () => {
    const harness = createHarness()
    const event: TranscriptInterferenceMessage = {
      type: "transcript-interference",
      sessionId: "session-1",
      waitId: "wait-b-1",
      reason: "regenerate",
    }

    await harness.controller.handleTranscriptInterference(12, event)

    expect(harness.current()).toMatchObject({ state: "error", stopReason: "transcript-interference" })
  })

  it("ignores stale session/wait and unrelated sender interference evidence", async () => {
    const harness = createHarness()
    const before = harness.current()
    const validEvent: TranscriptInterferenceMessage = {
      type: "transcript-interference",
      sessionId: "session-1",
      waitId: "wait-b-1",
      reason: "edit",
    }

    await harness.controller.handleTranscriptInterference(99, validEvent)
    await harness.controller.handleTranscriptInterference(12, { ...validEvent, sessionId: "stale-session" })
    await harness.controller.handleTranscriptInterference(12, { ...validEvent, waitId: "stale-wait" })

    expect(harness.current()).toEqual(before)
  })

  it("routes same-origin URL updates through recovery and rejects a changed conversation", async () => {
    const harness = createHarness({ identityB: "conversation-replaced" })

    await harness.controller.handleTabUpdated(12, { url: "https://chatgpt.com/c/conversation-replaced" })

    expect(harness.calls).toEqual(["inspect-12"])
    expect(harness.current()).toMatchObject({ state: "error", stopReason: "conversation-changed" })
  })

  it.each([
    "tab-closed",
    "invalid-navigation",
    "split-view-changed",
    "transcript-interference",
    "conversation-changed",
  ] as const)("does not let stale recovery overwrite a newer %s terminal error", async (reason) => {
    const harness = createHarness({
      deferInspect: true,
      ...(reason === "conversation-changed" ? { identityB: "conversation-replaced" } : {}),
    })
    const recovery = harness.controller.recoverTab(12)
    await harness.inspectStarted
    if (reason === "tab-closed") {
      await harness.controller.handleTabRemoved(12)
    } else if (reason === "invalid-navigation") {
      await harness.controller.handleTabUpdated(12, { url: "https://example.com/" })
    } else if (reason === "split-view-changed") {
      await harness.controller.handleTabUpdated(12, { splitViewId: -1 })
    } else if (reason === "transcript-interference") {
      await harness.controller.handleTranscriptInterference(12, {
        type: "transcript-interference",
        sessionId: "session-1",
        waitId: "wait-b-1",
        reason: "regenerate",
      })
    } else {
      await harness.controller.handleTabUpdated(12, { url: "https://chatgpt.com/c/other" })
    }
    harness.releaseInspect()

    await recovery

    expect(harness.current()).toMatchObject({ state: "error", stopReason: reason })
    expect(harness.calls).not.toContain("prepare")
    expect(harness.calls).not.toContain("commit")
  })
})
