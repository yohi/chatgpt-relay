import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CompletionTracker } from "../../src/content/completion-tracker"
import type { ExpectedResponse } from "../../src/shared/domain"
import { readTranscript } from "../../src/content/dom-contract"
import type { TranscriptEntry } from "../../src/content/dom-contract"

const userBeforeWait: TranscriptEntry = {
  role: "user",
  stableDomId: "user-before",
  roleOrdinal: 1,
  text: "synthetic earlier user turn",
  branchEvidence: null,
}

const assistantBeforeWait: TranscriptEntry = {
  role: "assistant",
  stableDomId: "assistant-before",
  roleOrdinal: 1,
  text: "synthetic earlier assistant turn",
  branchEvidence: null,
}

const relayUser: TranscriptEntry = {
  role: "user",
  stableDomId: "user-relay",
  roleOrdinal: 2,
  text: "synthetic relay user turn",
  branchEvidence: null,
}

const relayAssistant: TranscriptEntry = {
  role: "assistant",
  stableDomId: "assistant-relay",
  roleOrdinal: 2,
  text: "synthetic assistant response",
  branchEvidence: null,
}

const expectedResponse: ExpectedResponse = {
  sessionId: "session-1",
  waitId: "wait-1",
  side: "b",
  tabId: 22,
  baselineMessageId: "assistant-before",
  causedByTransferId: "transfer-1",
  causedByUserMessageId: "user-relay",
}

async function readCompletedFixture(): Promise<TranscriptEntry[]> {
  const html = await readFile(
    resolve(process.cwd(), "tests/content/fixtures/completed.html"),
    "utf8",
  )
  document.body.innerHTML = html
  window.history.replaceState(null, "", "/c/conversation-123")
  return readTranscript(document)
}

describe("CompletionTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-06T12:00:00.000Z"))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("does not emit a completion before arming", () => {
    const tracker = new CompletionTracker()

    expect(tracker.observe([userBeforeWait, relayAssistant], false)).toEqual({ kind: "pending" })
  })

  it("ignores assistants that were present at the wait baseline", () => {
    const tracker = new CompletionTracker()
    tracker.arm(expectedResponse, [userBeforeWait, assistantBeforeWait])

    expect(tracker.observe([userBeforeWait, assistantBeforeWait], false)).toEqual({ kind: "pending" })
  })

  it("accepts a stable assistant only after the exact expected user turn", () => {
    const tracker = new CompletionTracker()
    tracker.arm(expectedResponse, [userBeforeWait, assistantBeforeWait])
    const transcript = [userBeforeWait, assistantBeforeWait, relayUser, relayAssistant]

    expect(tracker.observe(transcript, false)).toEqual({ kind: "pending" })
    vi.advanceTimersByTime(500)

    expect(tracker.observe(transcript, false)).toEqual({
      kind: "complete",
      response: {
        messageId: "assistant-relay",
        text: "synthetic assistant response",
        textHash: expect.any(String),
      },
    })
  })

  it("accepts the completed DOM fixture while edit and regenerate controls are visible", async () => {
    const transcript = await readCompletedFixture()
    const user = transcript[0]
    if (user === undefined || user.stableDomId === null) throw new Error("missing fixture user identity")
    const tracker = new CompletionTracker()
    tracker.arm(
      { ...expectedResponse, baselineMessageId: null, causedByUserMessageId: user.stableDomId },
      [user],
    )

    expect(tracker.observe(transcript, false)).toEqual({ kind: "pending" })
    vi.advanceTimersByTime(500)
    expect(tracker.observe(transcript, false)).toMatchObject({
      kind: "complete",
      response: { messageId: "44444444-4444-4444-8444-444444444444" },
    })
  })

  it("fails closed when a previously observed causal user identity disappears", () => {
    const tracker = new CompletionTracker()
    tracker.arm(expectedResponse, [userBeforeWait, assistantBeforeWait])
    expect(
      tracker.observe([userBeforeWait, assistantBeforeWait, relayUser], false),
    ).toEqual({ kind: "pending" })

    expect(tracker.observe([userBeforeWait, assistantBeforeWait], false)).toEqual({
      kind: "interference",
      reason: "transcript-interference",
    })
  })

  it("fails closed when a previously observed causal user identity is replaced", () => {
    const tracker = new CompletionTracker()
    tracker.arm(expectedResponse, [userBeforeWait, assistantBeforeWait])
    tracker.observe([userBeforeWait, assistantBeforeWait, relayUser], false)
    const replacement = { ...relayUser, stableDomId: "user-replacement" }

    expect(
      tracker.observe([userBeforeWait, assistantBeforeWait, replacement], false),
    ).toEqual({ kind: "interference", reason: "transcript-interference" })
  })

  it("fails closed when a protected assistant identity is replaced", () => {
    const tracker = new CompletionTracker()
    tracker.arm(expectedResponse, [userBeforeWait, assistantBeforeWait])
    const first = [userBeforeWait, assistantBeforeWait, relayUser, relayAssistant]
    expect(tracker.observe(first, false)).toEqual({ kind: "pending" })
    const replacement = { ...relayAssistant, stableDomId: "assistant-replacement" }

    expect(
      tracker.observe([userBeforeWait, assistantBeforeWait, relayUser, replacement], false),
    ).toEqual({ kind: "interference", reason: "transcript-interference" })
  })

  it("fails closed when protected transcript order changes", () => {
    const tracker = new CompletionTracker()
    tracker.arm(expectedResponse, [userBeforeWait, assistantBeforeWait])
    tracker.observe([userBeforeWait, assistantBeforeWait, relayUser, relayAssistant], false)

    expect(
      tracker.observe([userBeforeWait, assistantBeforeWait, relayAssistant, relayUser], false),
    ).toEqual({ kind: "interference", reason: "transcript-interference" })
  })

  it("buffers an automated completion until controller user-turn binding", () => {
    const tracker = new CompletionTracker()
    const { causedByUserMessageId: _causedByUserMessageId, ...unboundExpected } = expectedResponse
    tracker.arm(unboundExpected, [userBeforeWait, assistantBeforeWait])
    const transcript = [userBeforeWait, assistantBeforeWait, relayUser, relayAssistant]

    expect(tracker.observe(transcript, false)).toEqual({ kind: "pending" })
    vi.advanceTimersByTime(500)
    expect(tracker.observe(transcript, false)).toEqual({ kind: "pending" })
    expect(tracker.takeBufferedCompletion("wait-1")).toBeNull()

    tracker.bindUserTurn({
      waitId: "wait-1",
      userMessageId: "user-relay",
      conversationIdentity: "conversation-b",
    })

    expect(tracker.takeBufferedCompletion("wait-1")).toMatchObject({
      messageId: "assistant-relay",
      text: "synthetic assistant response",
    })
    expect(tracker.takeBufferedCompletion("wait-1")).toBeNull()
  })

  it("rejects a matching transfer with assistant ancestry under the wrong user turn", () => {
    const tracker = new CompletionTracker()
    tracker.arm(expectedResponse, [userBeforeWait, assistantBeforeWait])
    const wrongUser = { ...relayUser, stableDomId: "different-user" }

    expect(
      tracker.observe([userBeforeWait, assistantBeforeWait, wrongUser, relayAssistant], false),
    ).toEqual({ kind: "interference", reason: "unexpected-user-input" })
  })

  it("treats an intervening user turn as interference", () => {
    const tracker = new CompletionTracker()
    tracker.arm(expectedResponse, [userBeforeWait, assistantBeforeWait])
    const secondUser = { ...relayUser, stableDomId: "user-unexpected", roleOrdinal: 3 }

    expect(
      tracker.observe(
        [userBeforeWait, assistantBeforeWait, relayUser, secondUser, relayAssistant],
        false,
      ),
    ).toEqual({ kind: "interference", reason: "unexpected-user-input" })
  })

  it.each(["edit", "regenerate", "branch"])(
    "fails closed when transcript ancestry carries %s mutation evidence",
    (evidence) => {
      const tracker = new CompletionTracker()
      tracker.arm(expectedResponse, [userBeforeWait, assistantBeforeWait])
      const mutatedAssistant = { ...relayAssistant, branchEvidence: evidence }

      expect(
        tracker.observe([userBeforeWait, assistantBeforeWait, relayUser, mutatedAssistant], false),
      ).toEqual({ kind: "interference", reason: "transcript-interference" })
    },
  )

  it("does not emit a buffered result for a stale wait", () => {
    const tracker = new CompletionTracker()
    tracker.arm(expectedResponse, [userBeforeWait, assistantBeforeWait])
    tracker.arm({ ...expectedResponse, waitId: "wait-2" }, [userBeforeWait, assistantBeforeWait])

    tracker.bindUserTurn({
      waitId: "wait-1",
      userMessageId: "user-relay",
      conversationIdentity: "conversation-b",
    })
    expect(tracker.takeBufferedCompletion("wait-1")).toBeNull()
  })

  it("requires an unchanged assistant body for the full stable interval", () => {
    const tracker = new CompletionTracker()
    tracker.arm(expectedResponse, [userBeforeWait, assistantBeforeWait])
    const initial = [userBeforeWait, assistantBeforeWait, relayUser, relayAssistant]
    expect(tracker.observe(initial, false)).toEqual({ kind: "pending" })
    vi.advanceTimersByTime(499)
    const changedAssistant = { ...relayAssistant, text: "synthetic changed response" }
    expect(
      tracker.observe([userBeforeWait, assistantBeforeWait, relayUser, changedAssistant], false),
    ).toEqual({ kind: "pending" })
    vi.advanceTimersByTime(499)
    expect(
      tracker.observe([userBeforeWait, assistantBeforeWait, relayUser, changedAssistant], false),
    ).toEqual({ kind: "pending" })
    vi.advanceTimersByTime(1)
    expect(
      tracker.observe([userBeforeWait, assistantBeforeWait, relayUser, changedAssistant], false).kind,
    ).toBe("complete")
  })

  it("does not complete while the main assistant is generating", () => {
    const tracker = new CompletionTracker()
    tracker.arm(expectedResponse, [userBeforeWait, assistantBeforeWait])
    const transcript = [userBeforeWait, assistantBeforeWait, relayUser, relayAssistant]

    expect(tracker.observe(transcript, true)).toEqual({ kind: "pending" })
    vi.advanceTimersByTime(1000)
    expect(tracker.observe(transcript, true)).toEqual({ kind: "pending" })
  })

  it("treats same-ID assistant body changes during generation as normal streaming", () => {
    const tracker = new CompletionTracker()
    tracker.arm(expectedResponse, [userBeforeWait, assistantBeforeWait])
    const initial = [userBeforeWait, assistantBeforeWait, relayUser, relayAssistant]
    expect(tracker.observe(initial, true)).toEqual({ kind: "pending" })

    const streamedAssistant = { ...relayAssistant, text: "synthetic assistant response grows" }
    expect(
      tracker.observe([userBeforeWait, assistantBeforeWait, relayUser, streamedAssistant], true),
    ).toEqual({ kind: "pending" })
  })
})
