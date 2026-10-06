import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ChatGPTAdapter } from "../../src/content/chatgpt-adapter"
import type { AdapterEvent } from "../../src/content/chatgpt-adapter"
import {
  createContentRuntime,
} from "../../src/content/index"
import type { ContentChromeApi } from "../../src/content/index"
import {
  createChromeTabsPort,
  createServiceWorkerRuntime,
} from "../../src/background/service-worker"
import type {
  RelayRuntimeControllerPort,
  ServiceWorkerChromeApi,
} from "../../src/background/service-worker"
import type {
  RelaySession,
  RelayStatusSnapshot,
} from "../../src/shared/domain"
import { RelayDomainError } from "../../src/shared/errors"
import type { AdapterCommandName } from "../../src/shared/errors"
import type { TranscriptInterferenceMessage } from "../../src/shared/protocol"
import type { RelayMessage } from "../../src/shared/protocol"

afterEach(() => {
  vi.unstubAllGlobals()
})

type ChromeListener = (...args: never[]) => void

class TestChromeEvent<T extends ChromeListener> {
  private readonly listeners: T[] = []

  addListener(callback: T): void {
    this.listeners.push(callback)
  }

  removeListener(callback: T): void {
    const index = this.listeners.indexOf(callback)
    if (index >= 0) this.listeners.splice(index, 1)
  }

  hasListener(callback: T): boolean {
    return this.listeners.includes(callback)
  }

  hasListeners(): boolean {
    return this.listeners.length > 0
  }

  fire(...args: Parameters<T>): unknown {
    const listener = this.listeners[0]
    return listener === undefined ? undefined : Reflect.apply(listener, undefined, args)
  }
}

const tabs: chrome.tabs.Tab[] = [
  {
    id: 11,
    windowId: 3,
    index: 0,
    active: true,
    pinned: false,
    highlighted: true,
    frozen: false,
    incognito: false,
    selected: true,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
    lastAccessed: 1,
    splitViewId: 8,
    url: "https://chatgpt.com/c/a",
  },
  {
    id: 12,
    windowId: 3,
    index: 1,
    active: false,
    pinned: false,
    highlighted: false,
    frozen: false,
    incognito: false,
    selected: false,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
    lastAccessed: 1,
    splitViewId: 8,
    url: "https://chatgpt.com/c/b",
  },
]

const session: RelaySession = {
  id: "session-1",
  revision: 2,
  splitViewId: 8,
  tabA: 11,
  tabB: 12,
  conversationA: { state: "bound", conversationIdentity: "conversation-a" },
  conversationB: { state: "bound", conversationIdentity: "conversation-b" },
  state: "waiting-a",
  turn: 0,
  maxTurns: 10,
  expectedResponse: {
    sessionId: "session-1",
    waitId: "wait-1",
    side: "a",
    tabId: 11,
    baselineMessageId: null,
  },
}

const status: RelayStatusSnapshot = {
  pair: { valid: true, splitViewId: 8, tabA: 11, tabB: 12 },
  session: {
    sessionId: session.id,
    state: session.state,
    turn: session.turn,
    maxTurns: session.maxTurns,
    expectedSide: "a",
    waitId: "wait-1",
    reason: null,
  },
}

type AdapterFailureScenario = {
  readonly command: AdapterCommandName
  readonly request: RelayMessage
  readonly correlation: Readonly<Record<string, string>>
  readonly fail: (adapter: ChatGPTAdapter) => void
}

function createControllerPort(overrides: Partial<RelayRuntimeControllerPort> = {}) {
  const port: RelayRuntimeControllerPort = {
    getStatus: vi.fn(async () => status),
    getMaxTurns: vi.fn(async () => 10),
    setMaxTurns: vi.fn(async (value: number) => value),
    start: vi.fn(async () => session),
    stop: vi.fn(async () => session),
    recoverTab: vi.fn(async () => null),
    recoverActiveSession: vi.fn(async () => null),
    handleInitialUserTurnObserved: vi.fn(async () => {}),
    handleAssistantComplete: vi.fn(async () => {}),
    handleTranscriptInterference: vi.fn(async () => {}),
    handleTabRemoved: vi.fn(async () => {}),
    handleTabUpdated: vi.fn(async () => {}),
    ...overrides,
  }
  return port
}

function createServiceWorkerChromeApi() {
  const onMessage = new TestChromeEvent<Parameters<typeof chrome.runtime.onMessage.addListener>[0]>()
  const onRemoved = new TestChromeEvent<Parameters<typeof chrome.tabs.onRemoved.addListener>[0]>()
  const onUpdated = new TestChromeEvent<Parameters<typeof chrome.tabs.onUpdated.addListener>[0]>()
  const query = vi.fn(async (_query: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]> => tabs)
  const sendMessage = vi.fn(async (_tabId: number, _message: unknown): Promise<unknown> => undefined)
  vi.stubGlobal("chrome", {
    runtime: { onMessage },
    tabs: { query, sendMessage, onRemoved, onUpdated },
  })
  const chromeApi: ServiceWorkerChromeApi = {
    runtime: { onMessage: chrome.runtime.onMessage },
    tabs: {
      query: chrome.tabs.query,
      sendMessage: chrome.tabs.sendMessage,
      onRemoved: chrome.tabs.onRemoved,
      onUpdated: chrome.tabs.onUpdated,
    },
  }
  return { chromeApi, onMessage, onRemoved, onUpdated, query, sendMessage }
}

function createContentChromeApi() {
  const onMessage = new TestChromeEvent<Parameters<typeof chrome.runtime.onMessage.addListener>[0]>()
  const sendMessage = vi.fn(async (_message: unknown): Promise<unknown> => undefined)
  vi.stubGlobal("chrome", { runtime: { onMessage, sendMessage } })
  const chromeApi: ContentChromeApi = {
    runtime: {
      onMessage: chrome.runtime.onMessage,
      sendMessage: chrome.runtime.sendMessage,
    },
  }
  return { chromeApi, onMessage, sendMessage }
}

function request(
  event: TestChromeEvent<Parameters<typeof chrome.runtime.onMessage.addListener>[0]>,
  message: unknown,
  sender: chrome.runtime.MessageSender = {},
): Promise<unknown> {
  return new Promise((resolveResponse) => {
    event.fire(message, sender, resolveResponse)
  })
}

function senderFor(tabId: number): chrome.runtime.MessageSender {
  const tab = tabs.find((candidate) => candidate.id === tabId)
  if (tab === undefined) throw new Error("missing fixture tab")
  return { tab }
}

describe("extension runtime routing", () => {
  it("starts one active-session recovery and waits for it before runtime commands", async () => {
    let finishRecovery: () => void = () => {}
    const recovery = new Promise<RelaySession | null>((resolveRecovery) => {
      finishRecovery = () => resolveRecovery(null)
    })
    const controller = createControllerPort({
      recoverActiveSession: vi.fn(() => recovery),
    })
    const { chromeApi, onMessage } = createServiceWorkerChromeApi()
    const runtime = createServiceWorkerRuntime({ chromeApi, controller })
    const response = request(onMessage, { type: "relay-start" })

    expect(controller.recoverActiveSession).toHaveBeenCalledOnce()
    expect(controller.start).not.toHaveBeenCalled()
    finishRecovery()

    await expect(response).resolves.toEqual({ type: "relay-start-result", ok: true, status })
    runtime.dispose()
  })

  it("routes adapter-ready using sender tab metadata and not payload tabId", async () => {
    const controller = createControllerPort()
    const { chromeApi, onMessage } = createServiceWorkerChromeApi()
    const runtime = createServiceWorkerRuntime({ chromeApi, controller })

    await request(
      onMessage,
      { type: "adapter-ready", tabId: 99 },
      senderFor(12),
    )

    expect(controller.recoverTab).toHaveBeenCalledWith(12)
    expect(controller.recoverTab).not.toHaveBeenCalledWith(99)

    const existingTab = senderFor(12).tab
    if (existingTab === undefined) throw new Error("missing sender tab fixture")
    await request(onMessage, { type: "adapter-ready", tabId: 12 }, { tab: { ...existingTab, id: 99 } })
    expect(controller.recoverTab).toHaveBeenCalledWith(99)
    runtime.dispose()
  })

  it("routes each adapter event using the Chrome sender tab ID", async () => {
    const controller = createControllerPort()
    const { chromeApi, onMessage } = createServiceWorkerChromeApi()
    const runtime = createServiceWorkerRuntime({ chromeApi, controller })

    await request(
      onMessage,
      {
        type: "initial-user-turn-observed",
        sessionId: "session-1",
        waitId: "wait-1",
        userMessageId: "user-1",
        conversationIdentity: "conversation-b",
        tabId: 99,
      },
      senderFor(12),
    )
    await request(
      onMessage,
      {
        type: "assistant-complete",
        sessionId: "session-1",
        waitId: "wait-1",
        causedByUserMessageId: "user-1",
        message: { messageId: "assistant-1", text: "synthetic", textHash: "hash" },
      },
      senderFor(11),
    )
    const interference: TranscriptInterferenceMessage = {
      type: "transcript-interference",
      sessionId: "session-1",
      waitId: "wait-1",
      reason: "regenerate",
    }
    await request(onMessage, interference, senderFor(12))

    expect(controller.handleInitialUserTurnObserved).toHaveBeenCalledWith(12, expect.objectContaining({ userMessageId: "user-1" }))
    expect(controller.handleAssistantComplete).toHaveBeenCalledWith(11, expect.objectContaining({ message: expect.objectContaining({ messageId: "assistant-1" }) }))
    expect(controller.handleTranscriptInterference).toHaveBeenCalledWith(12, interference)
    runtime.dispose()
  })

  it("returns undefined without mutation for malformed messages and missing adapter sender tab", async () => {
    const controller = createControllerPort()
    const { chromeApi, onMessage } = createServiceWorkerChromeApi()
    const runtime = createServiceWorkerRuntime({ chromeApi, controller })
    let malformedResponse: unknown = "not-responded"
    onMessage.fire(
      { type: "relay-preferences-set", maxTurns: "10" },
      {},
      (value) => { malformedResponse = value },
    )

    expect(malformedResponse).toBe("not-responded")
    expect(controller.setMaxTurns).not.toHaveBeenCalled()

    expect(() =>
      onMessage.fire({ type: "adapter-ready" }, {}, () => undefined),
    ).toThrow(TypeError)
    expect(() =>
      onMessage.fire({
        type: "assistant-complete",
        sessionId: "session-1",
        waitId: "wait-1",
        message: { messageId: "assistant-1", text: "synthetic", textHash: "hash" },
      }, {}, () => undefined),
    ).toThrow(TypeError)
    expect(controller.recoverTab).not.toHaveBeenCalled()
    runtime.dispose()
  })

  it("routes tab removal and only URL/Split View fields from updates", async () => {
    const controller = createControllerPort()
    const { chromeApi, onRemoved, onUpdated } = createServiceWorkerChromeApi()
    const runtime = createServiceWorkerRuntime({ chromeApi, controller })
    const removed = onRemoved.fire(12, { windowId: 3, isWindowClosing: false })
    if (removed instanceof Promise) await removed
    const activeTab = senderFor(12).tab
    if (activeTab === undefined) throw new Error("missing sender tab fixture")
    const updated = onUpdated.fire(
      12,
      { url: "https://chatgpt.com/c/b", splitViewId: 8, title: "ignored" },
      activeTab,
    )
    if (updated instanceof Promise) await updated

    expect(controller.handleTabRemoved).toHaveBeenCalledWith(12)
    expect(controller.handleTabUpdated).toHaveBeenCalledWith(12, {
      url: "https://chatgpt.com/c/b",
      splitViewId: 8,
    })
    runtime.dispose()
    expect(onRemoved.hasListeners()).toBe(false)
    expect(onUpdated.hasListeners()).toBe(false)
  })

  it("returns invalid-max-turns for numeric domain-invalid values without calling setMaxTurns", async () => {
    const controller = createControllerPort()
    const { chromeApi, onMessage } = createServiceWorkerChromeApi()
    const runtime = createServiceWorkerRuntime({ chromeApi, controller })

    for (const maxTurns of [0, -1, 1.5]) {
      await expect(
        request(onMessage, { type: "relay-preferences-set", maxTurns }),
      ).resolves.toEqual({
        type: "relay-preferences-set-result",
        ok: false,
        reason: "invalid-max-turns",
        maxTurns: 10,
      })
    }
    expect(controller.getMaxTurns).toHaveBeenCalledTimes(3)
    expect(controller.setMaxTurns).not.toHaveBeenCalled()

    await expect(
      request(onMessage, { type: "relay-preferences-set", maxTurns: 1 }),
    ).resolves.toEqual({ type: "relay-preferences-set-result", ok: true, maxTurns: 1 })
    expect(controller.setMaxTurns).toHaveBeenCalledOnce()
    runtime.dispose()
  })

  it("returns Start and accepted Stop results without converting their session status", async () => {
    const erroredStop = { ...session, state: "error" as const, stopReason: "recovery-ambiguous" as const }
    const errorStatus: RelayStatusSnapshot = {
      ...status,
      session: {
        sessionId: session.id,
        state: "error",
        turn: session.turn,
        maxTurns: session.maxTurns,
        expectedSide: null,
        waitId: null,
        reason: "recovery-ambiguous",
      },
    }
    let statusReads = 0
    const controller = createControllerPort({
      stop: vi.fn(async () => erroredStop),
      getStatus: vi.fn(async () => {
        statusReads += 1
        return statusReads === 1 ? status : errorStatus
      }),
    })
    const { chromeApi, onMessage } = createServiceWorkerChromeApi()
    const runtime = createServiceWorkerRuntime({ chromeApi, controller })

    await expect(request(onMessage, { type: "relay-start" })).resolves.toEqual({
      type: "relay-start-result",
      ok: true,
      status,
    })
    await expect(
      request(onMessage, { type: "relay-stop", sessionId: "session-1" }),
    ).resolves.toEqual({
      type: "relay-stop-result",
      ok: true,
      status: errorStatus,
    })
    runtime.dispose()
  })

  it.each(["pair-invalid", "generation-in-progress"] as const)(
    "returns relay-start-result failure for %s",
    async (reason) => {
      const controller = createControllerPort({
        start: vi.fn(async () => { throw new RelayDomainError(reason) }),
      })
      const { chromeApi, onMessage } = createServiceWorkerChromeApi()
      const runtime = createServiceWorkerRuntime({ chromeApi, controller })

      await expect(request(onMessage, { type: "relay-start" })).resolves.toEqual({
        type: "relay-start-result",
        ok: false,
        reason,
        status,
      })
      runtime.dispose()
    },
  )

  it("returns invalid-session for a rejected Stop request", async () => {
    const controller = createControllerPort({
      stop: vi.fn(async () => { throw new RelayDomainError("invalid-session") }),
    })
    const { chromeApi, onMessage } = createServiceWorkerChromeApi()
    const runtime = createServiceWorkerRuntime({ chromeApi, controller })

    await expect(
      request(onMessage, { type: "relay-stop", sessionId: "wrong-session" }),
    ).resolves.toEqual({
      type: "relay-stop-result",
      ok: false,
      reason: "invalid-session",
      status,
    })
    runtime.dispose()
  })

  it("queries current-window tabs through the tabs port without widening tab access", async () => {
    const { chromeApi, query } = createServiceWorkerChromeApi()
    const port = createChromeTabsPort(chromeApi.tabs)

    await expect(port.queryCurrentWindow()).resolves.toMatchObject([
      { id: 11, windowId: 3, active: true, url: "https://chatgpt.com/c/a", splitViewId: 8 },
      { id: 12, windowId: 3, active: false, url: "https://chatgpt.com/c/b", splitViewId: 8 },
    ])
    expect(query).toHaveBeenCalledWith({ currentWindow: true })
  })
})

describe("content runtime command routing", () => {
  it("announces readiness once and routes all six adapter commands", async () => {
    const adapter = new ChatGPTAdapter(document)
    const adapterSnapshot = {
      ready: true,
      generating: false,
      conversationIdentity: "conversation-a",
      latestUser: null,
      latestAssistant: null,
    }
    vi.spyOn(adapter, "inspect").mockResolvedValue(adapterSnapshot)
    const arm = vi.spyOn(adapter, "armExpectedResponse").mockResolvedValue()
    const prepare = vi.spyOn(adapter, "prepareSubmission").mockResolvedValue({
      transferId: "transfer-1",
      waitId: "wait-1",
      baselineMessageId: null,
      conversationIdentity: "conversation-b",
    })
    const commit = vi.spyOn(adapter, "commitSubmission").mockResolvedValue({
      transferId: "transfer-1",
      waitId: "wait-1",
      userMessageId: "user-1",
      conversationIdentity: "conversation-b",
    })
    const bind = vi.spyOn(adapter, "bindExpectedUserTurn").mockResolvedValue()
    const cancel = vi.spyOn(adapter, "cancelSubmission").mockResolvedValue({
      status: "cancelled-before-commit",
      transferId: "transfer-1",
    })
    const { chromeApi, onMessage, sendMessage } = createContentChromeApi()
    const runtime = createContentRuntime({ chromeApi, adapter })

    await runtime.ready
    expect(sendMessage).toHaveBeenCalledOnce()
    expect(sendMessage).toHaveBeenCalledWith({ type: "adapter-ready" })
    await expect(request(onMessage, { type: "adapter-inspect" })).resolves.toEqual({
      type: "adapter-inspect-result",
      snapshot: adapterSnapshot,
    })
    const expected = {
      sessionId: "session-1",
      waitId: "wait-1",
      side: "a",
      tabId: 11,
      baselineMessageId: null,
    }
    await expect(request(onMessage, { type: "arm-response", expected, authorizationRevision: 1 })).resolves.toEqual({
      type: "arm-response-result",
      ok: true,
      sessionId: "session-1",
      waitId: "wait-1",
    })
    await expect(request(onMessage, {
      type: "prepare-peer-response",
      sessionId: "session-1",
      transferId: "transfer-1",
      waitId: "wait-1",
      text: "synthetic prompt",
      authorizationRevision: 2,
    })).resolves.toMatchObject({ type: "transfer-prepared", conversationIdentity: "conversation-b" })
    await expect(request(onMessage, {
      type: "commit-transfer",
      sessionId: "session-1",
      transferId: "transfer-1",
      waitId: "wait-1",
      authorizationRevision: 3,
      authorizedConversationIdentity: "conversation-b",
    })).resolves.toMatchObject({ type: "transfer-committed", userMessageId: "user-1" })
    await expect(request(onMessage, {
      type: "bind-expected-user-turn",
      sessionId: "session-1",
      waitId: "wait-1",
      userMessageId: "user-1",
      conversationIdentity: "conversation-b",
      authorizationRevision: 4,
    })).resolves.toEqual({
      type: "bind-expected-user-turn-result",
      ok: true,
      sessionId: "session-1",
      waitId: "wait-1",
    })
    await expect(request(onMessage, {
      type: "cancel-transfer",
      sessionId: "session-1",
      transferId: "transfer-1",
    })).resolves.toEqual({
      type: "cancel-transfer-result",
      sessionId: "session-1",
      result: { status: "cancelled-before-commit", transferId: "transfer-1" },
    })

    expect(arm).toHaveBeenCalledOnce()
    expect(prepare).toHaveBeenCalledOnce()
    expect(prepare).toHaveBeenCalledWith({
      sessionId: "session-1",
      transferId: "transfer-1",
      waitId: "wait-1",
      text: "synthetic prompt",
    })
    expect(commit).toHaveBeenCalledOnce()
    expect(commit).toHaveBeenCalledWith({
      sessionId: "session-1",
      transferId: "transfer-1",
      waitId: "wait-1",
      authorizationRevision: 3,
      authorizedConversationIdentity: "conversation-b",
    })
    expect(bind).toHaveBeenCalledOnce()
    expect(bind).toHaveBeenCalledWith({
      sessionId: "session-1",
      waitId: "wait-1",
      userMessageId: "user-1",
      conversationIdentity: "conversation-b",
      authorizationRevision: 4,
    })
    expect(cancel).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledWith({ sessionId: "session-1", transferId: "transfer-1" })
    runtime.dispose()
    expect(onMessage.hasListeners()).toBe(false)
  })

  it("serializes known adapter errors and maps unexpected adapter exceptions", async () => {
    const adapter = new ChatGPTAdapter(document)
    vi.spyOn(adapter, "prepareSubmission").mockRejectedValue(new RelayDomainError("unexpected-user-input"))
    const { chromeApi, onMessage } = createContentChromeApi()
    const runtime = createContentRuntime({ chromeApi, adapter })
    await runtime.ready

    await expect(request(onMessage, {
      type: "prepare-peer-response",
      sessionId: "session-1",
      transferId: "transfer-1",
      waitId: "wait-1",
      text: "synthetic prompt",
      authorizationRevision: 2,
    })).resolves.toEqual({
      type: "adapter-command-failure",
      command: "prepare-peer-response",
      sessionId: "session-1",
      transferId: "transfer-1",
      waitId: "wait-1",
      reason: "unexpected-user-input",
    })

    vi.spyOn(adapter, "inspect").mockRejectedValue(new TypeError("unexpected implementation fault"))
    await expect(request(onMessage, { type: "adapter-inspect" })).resolves.toEqual({
      type: "adapter-command-failure",
      command: "adapter-inspect",
      reason: "adapter-command-failed",
    })
    runtime.dispose()
  })

  it("correlates known RelayDomainError responses for every adapter command", async () => {
    const failure = new RelayDomainError("submission-failed")
    const scenarios: readonly AdapterFailureScenario[] = [
      {
        command: "adapter-inspect",
        request: { type: "adapter-inspect" },
        correlation: {},
        fail(adapter) { vi.spyOn(adapter, "inspect").mockRejectedValue(failure) },
      },
      {
        command: "arm-response",
        request: {
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
        correlation: { sessionId: "session-1", waitId: "wait-1" },
        fail(adapter) { vi.spyOn(adapter, "armExpectedResponse").mockRejectedValue(failure) },
      },
      {
        command: "prepare-peer-response",
        request: {
          type: "prepare-peer-response",
          sessionId: "session-1",
          transferId: "transfer-1",
          waitId: "wait-1",
          text: "synthetic prompt",
          authorizationRevision: 2,
        },
        correlation: { sessionId: "session-1", transferId: "transfer-1", waitId: "wait-1" },
        fail(adapter) { vi.spyOn(adapter, "prepareSubmission").mockRejectedValue(failure) },
      },
      {
        command: "commit-transfer",
        request: {
          type: "commit-transfer",
          sessionId: "session-1",
          transferId: "transfer-1",
          waitId: "wait-1",
          authorizationRevision: 3,
          authorizedConversationIdentity: "conversation-b",
        },
        correlation: { sessionId: "session-1", transferId: "transfer-1", waitId: "wait-1" },
        fail(adapter) { vi.spyOn(adapter, "commitSubmission").mockRejectedValue(failure) },
      },
      {
        command: "bind-expected-user-turn",
        request: {
          type: "bind-expected-user-turn",
          sessionId: "session-1",
          waitId: "wait-1",
          userMessageId: "user-1",
          conversationIdentity: "conversation-b",
          authorizationRevision: 4,
        },
        correlation: { sessionId: "session-1", waitId: "wait-1" },
        fail(adapter) { vi.spyOn(adapter, "bindExpectedUserTurn").mockRejectedValue(failure) },
      },
      {
        command: "cancel-transfer",
        request: { type: "cancel-transfer", sessionId: "session-1", transferId: "transfer-1" },
        correlation: { sessionId: "session-1", transferId: "transfer-1" },
        fail(adapter) { vi.spyOn(adapter, "cancelSubmission").mockRejectedValue(failure) },
      },
    ]

    for (const scenario of scenarios) {
      const adapter = new ChatGPTAdapter(document)
      scenario.fail(adapter)
      const { chromeApi, onMessage } = createContentChromeApi()
      const runtime = createContentRuntime({ chromeApi, adapter })
      await runtime.ready

      await expect(request(onMessage, scenario.request)).resolves.toMatchObject({
        type: "adapter-command-failure",
        command: scenario.command,
        reason: "submission-failed",
        ...scenario.correlation,
      })
      runtime.dispose()
    }
  })

  it("maps correlated RelayDomainError failures for each adapter command", async () => {
    const error = new RelayDomainError("adapter-not-ready")
    const failureCases: readonly {
      readonly command: AdapterCommandName
      readonly request: RelayMessage
      readonly correlation: Readonly<Record<string, string>>
      readonly reject: (adapter: ChatGPTAdapter) => void
    }[] = [
      {
        command: "adapter-inspect",
        request: { type: "adapter-inspect" },
        correlation: {},
        reject(adapter) { vi.spyOn(adapter, "inspect").mockRejectedValue(error) },
      },
      {
        command: "arm-response",
        request: {
          type: "arm-response",
          expected: { sessionId: "session-1", waitId: "wait-1", side: "a", tabId: 11, baselineMessageId: null },
          authorizationRevision: 1,
        },
        correlation: { sessionId: "session-1", waitId: "wait-1" },
        reject(adapter) { vi.spyOn(adapter, "armExpectedResponse").mockRejectedValue(error) },
      },
      {
        command: "prepare-peer-response",
        request: {
          type: "prepare-peer-response",
          sessionId: "session-1",
          transferId: "transfer-1",
          waitId: "wait-1",
          text: "synthetic prompt",
          authorizationRevision: 2,
        },
        correlation: { sessionId: "session-1", transferId: "transfer-1", waitId: "wait-1" },
        reject(adapter) {
          vi.spyOn(adapter, "prepareSubmission").mockRejectedValue(error)
        },
      },
      {
        command: "commit-transfer",
        request: {
          type: "commit-transfer",
          sessionId: "session-1",
          transferId: "transfer-1",
          waitId: "wait-1",
          authorizationRevision: 3,
          authorizedConversationIdentity: "conversation-b",
        },
        correlation: { sessionId: "session-1", transferId: "transfer-1", waitId: "wait-1" },
        reject(adapter) { vi.spyOn(adapter, "commitSubmission").mockRejectedValue(error) },
      },
      {
        command: "bind-expected-user-turn",
        request: {
          type: "bind-expected-user-turn",
          sessionId: "session-1",
          waitId: "wait-1",
          userMessageId: "user-1",
          conversationIdentity: "conversation-b",
          authorizationRevision: 4,
        },
        correlation: { sessionId: "session-1", waitId: "wait-1" },
        reject(adapter) { vi.spyOn(adapter, "bindExpectedUserTurn").mockRejectedValue(error) },
      },
      {
        command: "cancel-transfer",
        request: { type: "cancel-transfer", sessionId: "session-1", transferId: "transfer-1" },
        correlation: { sessionId: "session-1", transferId: "transfer-1" },
        reject(adapter) { vi.spyOn(adapter, "cancelSubmission").mockRejectedValue(error) },
      },
    ]

    for (const testCase of failureCases) {
      const adapter = new ChatGPTAdapter(document)
      testCase.reject(adapter)
      const { chromeApi, onMessage } = createContentChromeApi()
      const runtime = createContentRuntime({ chromeApi, adapter })
      const response = await request(onMessage, testCase.request)
      expect(response).toMatchObject({
        type: "adapter-command-failure",
        command: testCase.command,
        reason: "adapter-not-ready",
        ...testCase.correlation,
      })
      runtime.dispose()
    }
  })

  it("forwards adapter events through runtime messaging and removes listeners on dispose", async () => {
    const adapter = new ChatGPTAdapter(document)
    let publish: ((event: AdapterEvent) => void) | undefined
    vi.spyOn(adapter, "startObserving").mockImplementation((handler) => {
      publish = handler
      return () => { publish = undefined }
    })
    const { chromeApi, onMessage, sendMessage } = createContentChromeApi()
    const runtime = createContentRuntime({ chromeApi, adapter })
    await runtime.ready
    const interference: TranscriptInterferenceMessage = {
      type: "transcript-interference",
      sessionId: "session-1",
      waitId: "wait-1",
      reason: "edit",
    }

    publish?.(interference)
    await Promise.resolve()
    expect(sendMessage).toHaveBeenCalledWith(interference)
    runtime.dispose()
    expect(onMessage.hasListeners()).toBe(false)
    expect(publish).toBeUndefined()
  })
})
