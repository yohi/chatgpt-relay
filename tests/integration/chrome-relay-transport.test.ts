import { afterEach, describe, expect, it, vi } from "vitest"
import { createChromeRelayTransport, createChromeTabsPort } from "../../src/background/service-worker"
import type { ServiceWorkerChromeApi } from "../../src/background/service-worker"
import { RelayTransportError } from "../../src/shared/errors"
import type { AdapterSnapshot } from "../../src/shared/domain"
import type { AdapterCommandFailure, RelayMessage } from "../../src/shared/protocol"

const snapshot: AdapterSnapshot = {
  ready: true,
  generating: false,
  conversationIdentity: "conversation-a",
  latestUser: null,
  latestAssistant: null,
}

function createTransport(response: unknown) {
  const sendMessage = vi.fn(async (_tabId: number, _message: unknown): Promise<unknown> => response)
  const chromeApi = { sendMessage } satisfies Pick<ServiceWorkerChromeApi["tabs"], "sendMessage">
  return { transport: createChromeRelayTransport(chromeApi), sendMessage }
}

describe("Chrome-backed RelayTransport", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })
  it("sends AdapterInspectRequest and accepts only AdapterInspectResult", async () => {
    const response = { type: "adapter-inspect-result", snapshot } satisfies RelayMessage
    const { transport, sendMessage } = createTransport(response)

    await expect(transport.inspect(12, { type: "adapter-inspect" })).resolves.toEqual(response)
    expect(sendMessage).toHaveBeenCalledOnce()
    expect(sendMessage).toHaveBeenCalledWith(12, { type: "adapter-inspect" })
  })

  it("queries only the current window and retains the Split View tab evidence", async () => {
    const queriedTabs: chrome.tabs.Tab[] = [
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
      },
    ]
    const query = vi.fn(async (_query: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]> => queriedTabs)
    vi.stubGlobal("chrome", { tabs: { query } })
    const port = createChromeTabsPort(chrome.tabs)

    await expect(port.queryCurrentWindow()).resolves.toEqual([
      {
        id: 11,
        windowId: 3,
        active: true,
        url: "https://chatgpt.com/c/a",
        splitViewId: 8,
      },
    ])
    expect(query).toHaveBeenCalledWith({ currentWindow: true })
  })

  it("sends arm request and rejects wrong session or wait correlation", async () => {
    const expected = {
      sessionId: "session-1",
      waitId: "wait-1",
      side: "a" as const,
      tabId: 12,
      baselineMessageId: null,
    }
    const request = { type: "arm-response" as const, expected, authorizationRevision: 4 }
    const { transport } = createTransport({
      type: "arm-response-result",
      ok: true,
      sessionId: "wrong-session",
      waitId: "wait-1",
    })

    await expect(transport.armResponse(12, request)).rejects.toMatchObject({
      failure: { reason: "adapter-transport-failed" },
    })

    const wrongWait = createTransport({
      type: "arm-response-result",
      ok: true,
      sessionId: "session-1",
      waitId: "wrong-wait",
    })
    await expect(
      wrongWait.transport.armResponse(12, request),
    ).rejects.toMatchObject({ failure: { reason: "adapter-transport-failed" } })

    const correct = createTransport({
      type: "arm-response-result",
      ok: true,
      sessionId: "session-1",
      waitId: "wait-1",
    })
    await expect(correct.transport.armResponse(12, request)).resolves.toEqual({
      type: "arm-response-result",
      ok: true,
      sessionId: "session-1",
      waitId: "wait-1",
    })
  })

  it("sends prepare request and accepts matching transfer correlation", async () => {
    const request = {
      type: "prepare-peer-response" as const,
      sessionId: "session-1",
      transferId: "transfer-1",
      waitId: "wait-1",
      text: "synthetic prompt",
      authorizationRevision: 5,
    }
    const response = {
      type: "transfer-prepared" as const,
      sessionId: "session-1",
      transferId: "transfer-1",
      waitId: "wait-1",
      baselineMessageId: "assistant-before",
      conversationIdentity: "conversation-b",
    }
    const { transport, sendMessage } = createTransport(response)

    await expect(transport.prepareSubmission(12, request)).resolves.toEqual(response)
    expect(sendMessage).toHaveBeenCalledOnce()
    expect(sendMessage).toHaveBeenCalledWith(12, request)
  })

  it.each([
    ["sessionId", { sessionId: "wrong-session" }],
    ["transferId", { transferId: "wrong-transfer" }],
    ["waitId", { waitId: "wrong-wait" }],
  ])("rejects prepare when %s correlation differs", async (_name, wrongFields) => {
    const { transport } = createTransport({
      type: "transfer-prepared",
      sessionId: "session-1",
      transferId: "transfer-1",
      waitId: "wait-1",
      baselineMessageId: null,
      conversationIdentity: "conversation-b",
      ...wrongFields,
    })

    await expect(transport.prepareSubmission(12, {
      type: "prepare-peer-response",
      sessionId: "session-1",
      transferId: "transfer-1",
      waitId: "wait-1",
      text: "synthetic prompt",
      authorizationRevision: 2,
    })).rejects.toMatchObject({ failure: { reason: "adapter-transport-failed" } })
  })

  it.each([
    ["sessionId", { sessionId: "wrong-session" }],
    ["transferId", { transferId: "wrong-transfer" }],
    ["waitId", { waitId: "wrong-wait" }],
  ])("rejects commit when %s correlation differs", async (_name, wrongFields) => {
    const request = {
      type: "commit-transfer" as const,
      sessionId: "session-1",
      transferId: "transfer-1",
      waitId: "wait-1",
      authorizationRevision: 6,
      authorizedConversationIdentity: "conversation-b",
    }
    const { transport } = createTransport({
      type: "transfer-committed",
      sessionId: "session-1",
      transferId: "transfer-1",
      waitId: "wait-1",
      userMessageId: "user-1",
      conversationIdentity: "conversation-b",
      ...wrongFields,
    })

    await expect(transport.commitSubmission(12, request)).rejects.toMatchObject({
      failure: { reason: "adapter-transport-failed" },
    })
  })

  it("sends exact commit request and accepts matching committed evidence", async () => {
    const request = {
      type: "commit-transfer" as const,
      sessionId: "session-1",
      transferId: "transfer-1",
      waitId: "wait-1",
      authorizationRevision: 6,
      authorizedConversationIdentity: "conversation-b",
    }
    const response = {
      type: "transfer-committed" as const,
      sessionId: "session-1",
      transferId: "transfer-1",
      waitId: "wait-1",
      userMessageId: "user-1",
      conversationIdentity: "conversation-b",
    }
    const result = createTransport(response)

    await expect(result.transport.commitSubmission(12, request)).resolves.toEqual(response)
    expect(result.sendMessage).toHaveBeenCalledWith(12, request)
  })

  it("sends bind request and rejects a wrong wait ID", async () => {
    const request = {
      type: "bind-expected-user-turn" as const,
      sessionId: "session-1",
      waitId: "wait-1",
      userMessageId: "user-1",
      conversationIdentity: "conversation-b",
      authorizationRevision: 7,
    }
    const { transport } = createTransport({
      type: "bind-expected-user-turn-result",
      ok: true,
      sessionId: "session-1",
      waitId: "wrong-wait",
    })

    await expect(transport.bindExpectedUserTurn(12, request)).rejects.toMatchObject({
      failure: { reason: "adapter-transport-failed" },
    })

    const wrongSession = createTransport({
      type: "bind-expected-user-turn-result",
      ok: true,
      sessionId: "wrong-session",
      waitId: "wait-1",
    })
    await expect(wrongSession.transport.bindExpectedUserTurn(12, request)).rejects.toMatchObject({
      failure: { reason: "adapter-transport-failed" },
    })
  })

  it("accepts matching bind acknowledgement with the exact request", async () => {
    const request = {
      type: "bind-expected-user-turn" as const,
      sessionId: "session-1",
      waitId: "wait-1",
      userMessageId: "user-1",
      conversationIdentity: "conversation-b",
      authorizationRevision: 7,
    }
    const response = {
      type: "bind-expected-user-turn-result" as const,
      ok: true as const,
      sessionId: "session-1",
      waitId: "wait-1",
    }
    const result = createTransport(response)

    await expect(result.transport.bindExpectedUserTurn(12, request)).resolves.toEqual(response)
    expect(result.sendMessage).toHaveBeenCalledWith(12, request)
  })

  it("sends cancel request and validates both wrapper and transfer correlation", async () => {
    const request = { type: "cancel-transfer" as const, sessionId: "session-1", transferId: "transfer-1" }
    const response = {
      type: "cancel-transfer-result" as const,
      sessionId: "session-1",
      result: { status: "cancelled-before-commit" as const, transferId: "transfer-1" },
    }
    const { transport, sendMessage } = createTransport(response)

    await expect(transport.cancelSubmission(12, request)).resolves.toEqual(response)
    expect(sendMessage).toHaveBeenCalledOnce()
    expect(sendMessage).toHaveBeenCalledWith(12, request)

    const mismatched = createTransport({
      ...response,
      result: { status: "unknown", transferId: "wrong-transfer" },
    })
    await expect(mismatched.transport.cancelSubmission(12, request)).rejects.toMatchObject({
      failure: { reason: "adapter-transport-failed" },
    })

    const wrongSession = createTransport({ ...response, sessionId: "wrong-session" })
    await expect(wrongSession.transport.cancelSubmission(12, request)).rejects.toMatchObject({
      failure: { reason: "adapter-transport-failed" },
    })
  })

  it("preserves a correlated AdapterCommandFailure reason", async () => {
    const response: AdapterCommandFailure = {
      type: "adapter-command-failure",
      command: "arm-response",
      sessionId: "session-1",
      waitId: "wait-1",
      reason: "generation-in-progress",
    }
    const { transport } = createTransport(response)

    await expect(
      transport.armResponse(
        12,
        {
          type: "arm-response",
          expected: {
            sessionId: "session-1",
            waitId: "wait-1",
            side: "a",
            tabId: 12,
            baselineMessageId: null,
          },
          authorizationRevision: 1,
        },
      ),
    ).rejects.toMatchObject({
      failure: { reason: "generation-in-progress" },
    })
  })

  it("maps mismatched AdapterCommandFailure correlation to adapter-transport-failed", async () => {
    const { transport } = createTransport({
      type: "adapter-command-failure",
      command: "arm-response",
      sessionId: "another-session",
      waitId: "wait-1",
      reason: "generation-in-progress",
    })

    await expect(transport.armResponse(12, {
      type: "arm-response",
      expected: {
        sessionId: "session-1",
        waitId: "wait-1",
        side: "a",
        tabId: 12,
        baselineMessageId: null,
      },
      authorizationRevision: 1,
    })).rejects.toMatchObject({ failure: { reason: "adapter-transport-failed" } })
  })

  it("maps rejected messaging and malformed/unexpected responses to typed transport failures", async () => {
    const request = { type: "adapter-inspect" as const }
    const disconnected = vi.fn(async (_tabId: number, _message: unknown): Promise<unknown> => {
      throw new Error("closed channel")
    })
    const chromeApi = { sendMessage: disconnected } satisfies Pick<ServiceWorkerChromeApi["tabs"], "sendMessage">
    const unavailable = createChromeRelayTransport(chromeApi)
    await expect(unavailable.inspect(12, request)).rejects.toMatchObject({
      failure: { reason: "adapter-not-ready" },
    })

    const malformed = createTransport({ type: "unknown" })
    await expect(malformed.transport.inspect(12, request)).rejects.toMatchObject({
      failure: { reason: "adapter-transport-failed" },
    })

    const wrongType = createTransport({ type: "relay-status" })
    await expect(wrongType.transport.inspect(12, request)).rejects.toBeInstanceOf(RelayTransportError)
  })
})
