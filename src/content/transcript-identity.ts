import type { ConversationBinding, TranscriptMessageIdentity } from "../shared/domain"
import { RelayDomainError } from "../shared/errors"

export function normalizeRelayText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim()
}

export function hashNormalizedText(text: string): string {
  let hash = 0x811c9dc5
  for (const character of normalizeRelayText(text)) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

export function deriveTranscriptMessageIdentity(input: {
  readonly stableDomId?: string | null
  readonly conversationIdentity: string | null
  readonly role: "user" | "assistant"
  readonly roleOrdinal: number | null
  readonly text: string
}): TranscriptMessageIdentity {
  const textHash = hashNormalizedText(input.text)
  let messageId: string

  if (input.stableDomId !== undefined && input.stableDomId !== null && input.stableDomId.length > 0) {
    messageId = `dom:${input.role}:${input.stableDomId}`
  } else if (
    input.conversationIdentity !== null &&
    input.roleOrdinal !== null &&
    Number.isInteger(input.roleOrdinal) &&
    input.roleOrdinal >= 1
  ) {
    messageId = `fallback:${JSON.stringify([
      input.conversationIdentity,
      input.role,
      input.roleOrdinal,
      textHash,
    ])}`
  } else {
    throw new RelayDomainError("message-identity-ambiguous")
  }

  return { messageId, role: input.role, textHash }
}

export function initializeConversationBinding(observed: string | null): ConversationBinding {
  return observed === null ? { state: "unbound" } : { state: "bound", conversationIdentity: observed }
}

export function reconcileConversationBinding(
  binding: ConversationBinding,
  observed: string | null,
  authority: "revalidation" | "first-allowed-prompt",
): ConversationBinding {
  if (binding.state === "bound") {
    if (observed !== binding.conversationIdentity) throw new RelayDomainError("conversation-changed")
    return binding
  }

  if (observed === null) return binding
  if (authority === "revalidation") throw new RelayDomainError("conversation-changed")
  return { state: "bound", conversationIdentity: observed }
}

export function assertBoundConversation(
  binding: ConversationBinding,
  observed: string | null,
): string {
  if (binding.state !== "bound" || observed !== binding.conversationIdentity) {
    throw new RelayDomainError("conversation-changed")
  }
  return binding.conversationIdentity
}
