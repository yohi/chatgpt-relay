import { describe, expect, it } from "vitest"
import { RelayDomainError } from "../../src/shared/errors"
import {
  assertBoundConversation,
  deriveTranscriptMessageIdentity,
  hashNormalizedText,
  initializeConversationBinding,
  normalizeRelayText,
  reconcileConversationBinding,
} from "../../src/content/transcript-identity"

describe("transcript identity", () => {
  it("gives repeated same-text assistant turns distinct ordinal identities", () => {
    const first = deriveTranscriptMessageIdentity({
      conversationIdentity: "conversation-a",
      role: "assistant",
      roleOrdinal: 1,
      text: "OK",
    })
    const second = deriveTranscriptMessageIdentity({
      conversationIdentity: "conversation-a",
      role: "assistant",
      roleOrdinal: 2,
      text: "OK",
    })

    expect(first.messageId).not.toBe(second.messageId)
    expect(first.textHash).toBe(second.textHash)
  })

  it("prefers a verified stable DOM identity over fallback fields", () => {
    const identity = deriveTranscriptMessageIdentity({
      stableDomId: "message-42",
      conversationIdentity: null,
      role: "user",
      roleOrdinal: null,
      text: "same prompt",
    })

    expect(identity.messageId).toBe("dom:user:message-42")
  })

  it("fails closed when fallback conversation or ordinal identity is missing", () => {
    expect(() =>
      deriveTranscriptMessageIdentity({
        conversationIdentity: null,
        role: "assistant",
        roleOrdinal: null,
        text: "response",
      }),
    ).toThrow(new RelayDomainError("message-identity-ambiguous"))
  })

  it("normalizes line endings before hashing relay text", () => {
    expect(normalizeRelayText(" line one\r\nline two \r" )).toBe("line one\nline two")
    expect(hashNormalizedText("answer\r\nbody")).toBe(hashNormalizedText("answer\nbody"))
  })
})

describe("conversation binding", () => {
  it("initializes stable and unidentified conversations distinctly", () => {
    expect(initializeConversationBinding("conversation-a")).toEqual({
      state: "bound",
      conversationIdentity: "conversation-a",
    })
    expect(initializeConversationBinding(null)).toEqual({ state: "unbound" })
  })

  it("does not adopt an unbound conversation during ordinary revalidation", () => {
    expect(() =>
      reconcileConversationBinding({ state: "unbound" }, "conversation-a", "revalidation"),
    ).toThrow(new RelayDomainError("conversation-changed"))
  })

  it("binds an unbound conversation only under first-allowed-prompt authority", () => {
    expect(
      reconcileConversationBinding({ state: "unbound" }, "conversation-a", "first-allowed-prompt"),
    ).toEqual({ state: "bound", conversationIdentity: "conversation-a" })
    expect(
      reconcileConversationBinding({ state: "unbound" }, null, "first-allowed-prompt"),
    ).toEqual({ state: "unbound" })
  })

  it("preserves the same bound identity and rejects replacement or loss", () => {
    const bound = { state: "bound", conversationIdentity: "conversation-a" } as const

    expect(reconcileConversationBinding(bound, "conversation-a", "revalidation")).toEqual(bound)
    expect(assertBoundConversation(bound, "conversation-a")).toBe("conversation-a")
    expect(() => reconcileConversationBinding(bound, "conversation-b", "revalidation")).toThrow(
      new RelayDomainError("conversation-changed"),
    )
    expect(() => assertBoundConversation(bound, null)).toThrow(
      new RelayDomainError("conversation-changed"),
    )
  })
})
