import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ChatGPTAdapter } from "../../src/content/chatgpt-adapter"
import type { AdapterEvent } from "../../src/content/chatgpt-adapter"
import { RelayDomainError } from "../../src/shared/errors"
import type { ExpectedResponse } from "../../src/shared/domain"
import type { TranscriptInterferenceMessage } from "../../src/shared/protocol"

const transferInput = {
  sessionId: "session-1",
  transferId: "transfer-1",
  waitId: "wait-1",
  text: "synthetic relay prompt",
}

const expectedResponse: ExpectedResponse = {
  sessionId: "session-1",
  waitId: "wait-1",
  side: "b",
  tabId: 22,
  baselineMessageId: "22222222-2222-4222-8222-222222222222",
  causedByTransferId: "transfer-1",
}

async function loadExistingConversation(): Promise<Document> {
  const html = await readFile(
    resolve(process.cwd(), "tests/content/fixtures/idle-existing.html"),
    "utf8",
  )
  document.body.innerHTML = html
  window.history.replaceState(null, "", "/c/conversation-123")
  return document
}

async function loadNewChat(): Promise<Document> {
  const html = await readFile(resolve(process.cwd(), "tests/content/fixtures/new-chat.html"), "utf8")
  document.body.innerHTML = html
  window.history.replaceState(null, "", "/ja-JP/")
  return document
}

function textbox(): HTMLElement {
  const element = document.getElementById("main-textbox")
  if (!(element instanceof HTMLElement)) throw new Error("missing synthetic composer")
  return element
}

function appendInitialUserTurn(messageId: string): void {
  const article = document.createElement("article")
  article.setAttribute("data-chatgpt-search-unit-key", "fallback-turn-0:0:user")
  article.setAttribute("data-chatgpt-search-message-ids", messageId)
  const bubble = document.createElement("div")
  bubble.setAttribute("data-user-message-bubble", "")
  bubble.textContent = "synthetic initial user prompt"
  article.append(bubble)
  document.getElementById("main-thread")?.append(article)
}

function installUserTurnOnSubmit(userMessageId = "77777777-7777-4777-8777-777777777777"): {
  readClicks(): number
} {
  let clicks = 0
  document.getElementById("main-submit")?.addEventListener("click", () => {
    clicks += 1
    const user = document.createElement("article")
    user.setAttribute("data-chatgpt-search-unit-key", "fallback-turn-1:0:user")
    user.setAttribute("data-chatgpt-search-message-ids", userMessageId)
    const bubble = document.createElement("div")
    bubble.setAttribute("data-user-message-bubble", "")
    bubble.textContent = textbox().textContent
    user.append(bubble)
    document.getElementById("transcript")?.append(user)
  })
  return { readClicks: () => clicks }
}

describe("ChatGPTAdapter", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-06T12:00:00.000Z"))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("inspects the current conversation, generation state, and latest stable identities", async () => {
    await loadExistingConversation()
    const adapter = new ChatGPTAdapter(document)

    await expect(adapter.inspect()).resolves.toMatchObject({
      ready: true,
      generating: false,
      conversationIdentity: "conversation-123",
      latestUser: {
        messageId: "11111111-1111-4111-8111-111111111111",
        role: "user",
      },
      latestAssistant: {
        messageId: "22222222-2222-4222-8222-222222222222",
      },
    })
  })

  it("binds the initial user only after a main composer submission and localized route commit", async () => {
    const page = await loadNewChat()
    const adapter = new ChatGPTAdapter(page)
    await adapter.armExpectedResponse({
      sessionId: "session-initial-a",
      waitId: "initial-a-wait",
      side: "a",
      tabId: 11,
      baselineMessageId: null,
    })
    const received: AdapterEvent[] = []
    const dispose = adapter.startObserving((event) => received.push(event))
    const composer = document.getElementById("main-composer")
    if (!(composer instanceof HTMLFormElement)) throw new Error("missing main composer fixture")
    textbox().textContent = "synthetic approved initial prompt"
    composer.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    appendInitialUserTurn("15151515-1515-4151-8151-151515151515")
    await Promise.resolve()

    expect(received.some((event) => event.type === "initial-user-turn-observed")).toBe(false)
    expect(received.some((event) => event.type === "transcript-interference")).toBe(false)

    window.history.replaceState(null, "", "/c/first-allowed-conversation")
    const routeChange = document.createElement("span")
    document.getElementById("main-thread")?.append(routeChange)
    await Promise.resolve()

    expect(received).toContainEqual({
      type: "initial-user-turn-observed",
      sessionId: "session-initial-a",
      waitId: "initial-a-wait",
      userMessageId: "15151515-1515-4151-8151-151515151515",
      conversationIdentity: "first-allowed-conversation",
    })
    dispose()
  })

  it("fails closed instead of adopting an unrelated one-turn navigation without submit evidence", async () => {
    const page = await loadNewChat()
    const adapter = new ChatGPTAdapter(page)
    await adapter.armExpectedResponse({
      sessionId: "session-initial-a",
      waitId: "initial-a-wait",
      side: "a",
      tabId: 11,
      baselineMessageId: null,
    })
    const received: AdapterEvent[] = []
    const dispose = adapter.startObserving((event) => received.push(event))
    window.history.replaceState(null, "", "/c/unrelated-conversation")
    appendInitialUserTurn("16161616-1616-4161-8161-161616161616")
    await Promise.resolve()

    expect(received.some((event) => event.type === "initial-user-turn-observed")).toBe(false)
    expect(received.some((event) => event.type === "transcript-interference")).toBe(true)
    dispose()
  })

  it("does not treat Quick Chat submit as the allowed initial A prompt", async () => {
    const page = await loadNewChat()
    const adapter = new ChatGPTAdapter(page)
    await adapter.armExpectedResponse({
      sessionId: "session-initial-a",
      waitId: "initial-a-wait",
      side: "a",
      tabId: 11,
      baselineMessageId: null,
    })
    const received: AdapterEvent[] = []
    const dispose = adapter.startObserving((event) => received.push(event))
    const quickChat = document.getElementById("quick-chat-composer")
    if (!(quickChat instanceof HTMLFormElement)) throw new Error("missing Quick Chat fixture")
    quickChat.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    window.history.replaceState(null, "", "/c/unrelated-conversation")
    appendInitialUserTurn("17171717-1717-4171-8171-171717171717")
    await Promise.resolve()

    expect(received.some((event) => event.type === "initial-user-turn-observed")).toBe(false)
    expect(received.some((event) => event.type === "transcript-interference")).toBe(true)
    dispose()
  })

  it("prepares the observed conversation and stages without submitting", async () => {
    await loadExistingConversation()
    const clicks = installUserTurnOnSubmit()
    const adapter = new ChatGPTAdapter(document)

    await expect(adapter.prepareSubmission(transferInput)).resolves.toEqual({
      transferId: "transfer-1",
      waitId: "wait-1",
      baselineMessageId: "22222222-2222-4222-8222-222222222222",
      conversationIdentity: "conversation-123",
    })
    expect(textbox().textContent).toBe("synthetic relay prompt")
    expect(clicks.readClicks()).toBe(0)
  })

  it("rejects preparation over unexpected user composer text without changing it", async () => {
    await loadExistingConversation()
    textbox().textContent = "synthetic user-owned text"
    const adapter = new ChatGPTAdapter(document)

    await expect(adapter.prepareSubmission(transferInput)).rejects.toThrow(
      new RelayDomainError("unexpected-user-input"),
    )
    expect(textbox().textContent).toBe("synthetic user-owned text")
  })

  it("rejects preparation while the main target composer is generating", async () => {
    const html = await readFile(
      resolve(process.cwd(), "tests/content/fixtures/generating.html"),
      "utf8",
    )
    document.body.innerHTML = html
    window.history.replaceState(null, "", "/c/conversation-123")
    const adapter = new ChatGPTAdapter(document)

    await expect(adapter.prepareSubmission(transferInput)).rejects.toThrow(
      new RelayDomainError("generation-in-progress"),
    )
  })

  it("does not own a persisted ConversationBinding", async () => {
    await loadExistingConversation()
    const adapter = new ChatGPTAdapter(document)

    expect(adapter).not.toHaveProperty("conversationBinding")
  })

  it("commits only when the controller-authorized current conversation still matches", async () => {
    await loadExistingConversation()
    const clicks = installUserTurnOnSubmit()
    const adapter = new ChatGPTAdapter(document)
    await adapter.prepareSubmission(transferInput)

    await expect(
      adapter.commitSubmission({
        ...transferInput,
        authorizationRevision: 2,
        authorizedConversationIdentity: "conversation-123",
      }),
    ).resolves.toEqual({
      transferId: "transfer-1",
      waitId: "wait-1",
      userMessageId: "77777777-7777-4777-8777-777777777777",
      conversationIdentity: "conversation-123",
    })
    expect(clicks.readClicks()).toBe(1)
  })

  it("does not cross the UI submission commit point after conversation replacement", async () => {
    await loadExistingConversation()
    const clicks = installUserTurnOnSubmit()
    const adapter = new ChatGPTAdapter(document)
    await adapter.prepareSubmission(transferInput)
    window.history.replaceState(null, "", "/c/conversation-replaced")

    await expect(
      adapter.commitSubmission({
        ...transferInput,
        authorizationRevision: 2,
        authorizedConversationIdentity: "conversation-123",
      }),
    ).rejects.toThrow(new RelayDomainError("conversation-changed"))
    expect(clicks.readClicks()).toBe(0)
  })

  it("fails causally when the UI send activation cannot be tied to one new user message", async () => {
    await loadExistingConversation()
    const adapter = new ChatGPTAdapter(document)
    await adapter.prepareSubmission(transferInput)

    const commit = adapter.commitSubmission({
      ...transferInput,
      authorizationRevision: 2,
      authorizedConversationIdentity: "conversation-123",
    })
    const expectedFailure = expect(commit).rejects.toThrow(
      new RelayDomainError("relay-causality-ambiguous"),
    )
    await vi.advanceTimersByTimeAsync(5000)
    await expectedFailure
  })

  it("cancels before commit and clears only unchanged extension-owned staged text", async () => {
    await loadExistingConversation()
    const adapter = new ChatGPTAdapter(document)
    await adapter.prepareSubmission(transferInput)

    await expect(adapter.cancelSubmission({ sessionId: "session-1", transferId: "transfer-1" })).resolves.toEqual({
      status: "cancelled-before-commit",
      transferId: "transfer-1",
    })
    expect(textbox().textContent).toBe("")
  })

  it("preserves composer text changed by the user after preparation", async () => {
    await loadExistingConversation()
    const adapter = new ChatGPTAdapter(document)
    await adapter.prepareSubmission(transferInput)
    textbox().textContent = "synthetic user edited text"

    await adapter.cancelSubmission({ sessionId: "session-1", transferId: "transfer-1" })

    expect(textbox().textContent).toBe("synthetic user edited text")
  })

  it("reports committed transfer evidence during cancellation after UI submission", async () => {
    await loadExistingConversation()
    installUserTurnOnSubmit()
    const adapter = new ChatGPTAdapter(document)
    await adapter.prepareSubmission(transferInput)
    await adapter.commitSubmission({
      ...transferInput,
      authorizationRevision: 2,
      authorizedConversationIdentity: "conversation-123",
    })

    await expect(adapter.cancelSubmission({ sessionId: "session-1", transferId: "transfer-1" })).resolves.toEqual({
      status: "already-committed",
      transferId: "transfer-1",
      userMessageId: "77777777-7777-4777-8777-777777777777",
      conversationIdentity: "conversation-123",
    })
  })

  it("returns unknown for a transfer whose commit state cannot be reconciled", async () => {
    await loadExistingConversation()
    const adapter = new ChatGPTAdapter(document)

    await expect(adapter.cancelSubmission({ sessionId: "session-1", transferId: "unknown" })).resolves.toEqual({
      status: "unknown",
      transferId: "unknown",
    })
  })

  it("fails closed for ambiguous critical DOM targets", async () => {
    const html = await readFile(
      resolve(process.cwd(), "tests/content/fixtures/ambiguous-composer.html"),
      "utf8",
    )
    document.body.innerHTML = html
    window.history.replaceState(null, "", "/c/conversation-123")
    const adapter = new ChatGPTAdapter(document)

    await expect(adapter.inspect()).rejects.toThrow(new RelayDomainError("dom-contract-ambiguous"))
  })

  it("binds a persisted user turn and routes mutation/completion observations", async () => {
    await loadExistingConversation()
    const adapter = new ChatGPTAdapter(document)
    await adapter.armExpectedResponse({
      ...expectedResponse,
      causedByUserMessageId: "77777777-7777-4777-8777-777777777777",
    })
    const received: AdapterEvent[] = []
    const dispose = adapter.startObserving((event) => received.push(event))
    const user = document.createElement("article")
    user.setAttribute("data-chatgpt-search-unit-key", "fallback-turn-1:0:user")
    user.setAttribute("data-chatgpt-search-message-ids", "77777777-7777-4777-8777-777777777777")
    const bubble = document.createElement("div")
    bubble.setAttribute("data-user-message-bubble", "")
    bubble.textContent = "synthetic relay prompt"
    user.append(bubble)
    document.getElementById("transcript")?.append(user)
    await Promise.resolve()
    await adapter.bindExpectedUserTurn({
      sessionId: "session-1",
      waitId: "wait-1",
      userMessageId: "77777777-7777-4777-8777-777777777777",
      conversationIdentity: "conversation-123",
      authorizationRevision: 2,
    })
    const assistant = document.createElement("article")
    assistant.setAttribute("data-chatgpt-search-unit-key", "fallback-turn-1:2:assistant")
    assistant.setAttribute(
      "data-chatgpt-search-message-ids",
      "88888888-8888-4888-8888-888888888888 88888888-8888-4888-8888-888888888888",
    )
    const heading = document.createElement("h4")
    heading.setAttribute("data-conversation-role", "assistant")
    heading.textContent = "synthetic response"
    assistant.append(heading)
    document.getElementById("transcript")?.append(assistant)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(500)
    expect(received.some((event) => event.type === "assistant-complete")).toBe(true)
    dispose()
  })

  it("types transcript interference events with the active wait identity", async () => {
    await loadExistingConversation()
    const adapter = new ChatGPTAdapter(document)
    await adapter.armExpectedResponse({
      ...expectedResponse,
      causedByUserMessageId: "77777777-7777-4777-8777-777777777777",
    })
    const received: AdapterEvent[] = []
    const dispose = adapter.startObserving((event) => received.push(event))
    const expectedUser = document.createElement("article")
    expectedUser.setAttribute("data-chatgpt-search-unit-key", "fallback-turn-1:0:user")
    expectedUser.setAttribute("data-chatgpt-search-message-ids", "77777777-7777-4777-8777-777777777777")
    const expectedBubble = document.createElement("div")
    expectedBubble.setAttribute("data-user-message-bubble", "")
    expectedUser.append(expectedBubble)
    const editedUser = document.createElement("button")
    editedUser.setAttribute("aria-label", "メッセージを編集")
    expectedUser.append(editedUser)
    document.getElementById("transcript")?.append(expectedUser)
    const assistant = document.createElement("article")
    assistant.setAttribute("data-chatgpt-search-unit-key", "fallback-turn-1:2:assistant")
    assistant.setAttribute(
      "data-chatgpt-search-message-ids",
      "88888888-8888-4888-8888-888888888888",
    )
    const heading = document.createElement("h4")
    heading.setAttribute("data-conversation-role", "assistant")
    assistant.append(heading)
    document.getElementById("transcript")?.append(assistant)
    await Promise.resolve()

    expect(received.some((event) => event.type === "transcript-interference")).toBe(false)
    editedUser.click()
    await Promise.resolve()

    const interference = received.find((event) => event.type === "transcript-interference")
    expect(interference).toMatchObject<Partial<TranscriptInterferenceMessage>>({
      type: "transcript-interference",
      sessionId: "session-1",
      waitId: "wait-1",
    })
    dispose()
  })

  it("treats visible regenerate control as inert until actually clicked", async () => {
    await loadExistingConversation()
    const adapter = new ChatGPTAdapter(document)
    await adapter.armExpectedResponse({
      ...expectedResponse,
      causedByUserMessageId: "11111111-1111-4111-8111-111111111111",
    })
    const received: AdapterEvent[] = []
    const dispose = adapter.startObserving((event) => received.push(event))

    expect(received.some((event) => event.type === "transcript-interference")).toBe(false)
    document.getElementById("regenerate-control")?.click()
    await Promise.resolve()

    expect(received.find((event) => event.type === "transcript-interference")).toMatchObject({
      type: "transcript-interference",
      reason: "regenerate",
    })
    dispose()
  })

  it("does not emit transcript interference for mutation controls without an armed wait", async () => {
    await loadExistingConversation()
    const adapter = new ChatGPTAdapter(document)
    const received: AdapterEvent[] = []
    const dispose = adapter.startObserving((event) => received.push(event))

    document.getElementById("edit-control")?.click()
    document.getElementById("regenerate-control")?.click()
    await Promise.resolve()

    expect(received.some((event) => event.type === "transcript-interference")).toBe(false)
    dispose()
  })

  it("stops routing mutation clicks after the active wait observer is disposed", async () => {
    await loadExistingConversation()
    const adapter = new ChatGPTAdapter(document)
    await adapter.armExpectedResponse({
      ...expectedResponse,
      causedByUserMessageId: "11111111-1111-4111-8111-111111111111",
    })
    const received: AdapterEvent[] = []
    const dispose = adapter.startObserving((event) => received.push(event))
    dispose()

    document.getElementById("edit-control")?.click()
    document.getElementById("regenerate-control")?.click()
    await Promise.resolve()

    expect(received.some((event) => event.type === "transcript-interference")).toBe(false)
  })

  it("detects causal user identity removal as structural interference", async () => {
    await loadExistingConversation()
    const adapter = new ChatGPTAdapter(document)
    await adapter.armExpectedResponse({
      ...expectedResponse,
      causedByUserMessageId: "11111111-1111-4111-8111-111111111111",
    })
    const received: AdapterEvent[] = []
    const dispose = adapter.startObserving((event) => received.push(event))
    document.getElementById("user-turn")?.remove()
    await Promise.resolve()

    expect(received.find((event) => event.type === "transcript-interference")).toMatchObject({
      type: "transcript-interference",
      reason: "causality-ambiguous",
    })
    dispose()
  })
})
