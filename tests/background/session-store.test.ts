import { afterEach, describe, expect, it, vi } from "vitest"
import type { RelaySession } from "../../src/shared/domain"
import {
  assertCurrentSession,
  createChromePreferencesStore,
  createChromeSessionStore,
} from "../../src/background/session-store"

function createMemoryStorageArea(): {
  readonly values: Record<string, unknown>
  readonly area: {
    get(key: string): Promise<Record<string, unknown>>
    set(items: Record<string, unknown>): Promise<void>
    remove(key: string): Promise<void>
  }
} {
  const values: Record<string, unknown> = {}
  return {
    values,
    area: {
      async get(key) {
        return { [key]: values[key] }
      },
      async set(items) {
        Object.assign(values, items)
      },
      async remove(key) {
        delete values[key]
      },
    },
  }
}

const sessionFixture = {
  id: "session-1",
  revision: 4,
  splitViewId: 9,
  tabA: 21,
  tabB: 22,
  conversationA: { state: "bound", conversationIdentity: "conversation-a" },
  conversationB: { state: "unbound" },
  state: "dispatching-b",
  turn: 2,
  maxTurns: 10,
  expectedResponse: {
    sessionId: "session-1",
    waitId: "wait-2",
    side: "b",
    tabId: 22,
    baselineMessageId: "assistant-b-1",
    causedByTransferId: "transfer-2",
    causedByUserMessageId: "user-b-2",
  },
  lastMessageA: "assistant-a-2",
  pendingTransfer: {
    id: "transfer-2",
    sourceTabId: 21,
    targetTabId: 22,
    sourceMessageId: "assistant-a-2",
    payloadHash: "payload-hash",
    targetWaitId: "wait-2",
    targetBaselineMessageId: "assistant-b-1",
    targetUserMessageId: "user-b-2",
    authorizationRevision: 4,
    submissionState: "committed",
  },
} satisfies RelaySession

describe("Chrome-backed relay stores", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("defaults maxTurns to 10 and persists preferences", async () => {
    const sessionStorage = createMemoryStorageArea()
    const localStorage = createMemoryStorageArea()
    vi.stubGlobal("chrome", { storage: { session: sessionStorage.area, local: localStorage.area } })

    const preferences = createChromePreferencesStore()

    await expect(preferences.readMaxTurns()).resolves.toBe(10)
    await preferences.writeMaxTurns(5)
    await expect(preferences.readMaxTurns()).resolves.toBe(5)
  })

  it("round-trips revision, conversation bindings, causal wait, and pending transfer", async () => {
    const sessionStorage = createMemoryStorageArea()
    const localStorage = createMemoryStorageArea()
    vi.stubGlobal("chrome", { storage: { session: sessionStorage.area, local: localStorage.area } })

    const sessions = createChromeSessionStore()
    await sessions.write(sessionFixture)

    await expect(sessions.read()).resolves.toEqual(sessionFixture)
    await sessions.clear()
    await expect(sessions.read()).resolves.toBeNull()
  })

  it.each([
    ["session", { sessionId: "stale-session" }],
    ["revision", { sessionId: "session-1", revision: 3 }],
    ["wait", { sessionId: "session-1", waitId: "stale-wait" }],
    ["transfer", { sessionId: "session-1", transferId: "stale-transfer" }],
  ])("rejects stale %s before state can be used", (_name, expected) => {
    expect(() => assertCurrentSession(sessionFixture, expected)).toThrow()
  })
})
