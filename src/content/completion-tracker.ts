import type { AssistantResponse, ExpectedResponse, RelayFailureReason } from "../shared/domain"
import type { TranscriptEntry } from "./dom-contract"
import { hashNormalizedText } from "./transcript-identity"

export const COMPLETION_STABLE_MS = 500

export type CompletionObservation =
  | { readonly kind: "pending" }
  | { readonly kind: "complete"; readonly response: AssistantResponse }
  | { readonly kind: "interference"; readonly reason: RelayFailureReason }

type BufferedCompletion = {
  readonly waitId: string
  readonly userMessageId: string
  readonly response: AssistantResponse
}

type StableCandidate = {
  readonly messageId: string
  readonly text: string
  readonly since: number
}

export class CompletionTracker {
  private expected: ExpectedResponse | null = null
  private readonly baselineMessageIds = new Set<string>()
  private baselineAssistantId: string | null = null
  private causedByUserMessageId: string | null = null
  private protectedMessageSequence: string[] | null = null
  private observedCausalUserMessageId: string | null = null
  private boundConversationIdentity: string | null = null
  private bufferedCompletion: BufferedCompletion | null = null
  private stableCandidate: StableCandidate | null = null
  private emitted = false

  arm(expected: ExpectedResponse, snapshot: readonly TranscriptEntry[]): void {
    this.expected = expected
    this.baselineMessageIds.clear()
    this.baselineAssistantId = expected.baselineMessageId
    this.causedByUserMessageId = expected.causedByUserMessageId ?? null
    this.observedCausalUserMessageId = null
    this.protectedMessageSequence = null
    this.boundConversationIdentity = null
    this.bufferedCompletion = null
    this.stableCandidate = null
    this.emitted = false

    for (const entry of snapshot) {
      if (entry.stableDomId !== null) this.baselineMessageIds.add(entry.stableDomId)
      if (entry.role === "assistant" && this.baselineAssistantId === null) {
        this.baselineAssistantId = entry.stableDomId
      }
    }
  }

  bindUserTurn(input: {
    readonly waitId: string
    readonly userMessageId: string
    readonly conversationIdentity: string
  }): void {
    if (this.expected?.waitId !== input.waitId || input.conversationIdentity.length === 0) return
    if (this.causedByUserMessageId !== null && this.causedByUserMessageId !== input.userMessageId) return
    if (
      this.boundConversationIdentity !== null &&
      this.boundConversationIdentity !== input.conversationIdentity
    ) {
      this.bufferedCompletion = null
      this.stableCandidate = null
      return
    }

    this.causedByUserMessageId = input.userMessageId
    this.observedCausalUserMessageId = input.userMessageId
    this.boundConversationIdentity = input.conversationIdentity
  }

  observe(snapshot: readonly TranscriptEntry[], generating: boolean): CompletionObservation {
    if (this.expected === null || this.emitted) return { kind: "pending" }
    if (this.observedCausalUserMessageId !== null) {
      const causalUsers = snapshot.filter(
        (entry) => entry.role === "user" && entry.stableDomId === this.observedCausalUserMessageId,
      )
      if (causalUsers.length !== 1) {
        this.clearPendingCompletion()
        return { kind: "interference", reason: "transcript-interference" }
      }
    }

    const targetUser = this.findExpectedUser(snapshot)
    if (targetUser.kind === "interference") {
      this.clearPendingCompletion()
      return { kind: "interference", reason: targetUser.reason }
    }
    if (targetUser.kind === "pending") {
      this.clearPendingCompletion()
      return { kind: "pending" }
    }
    if (targetUser.entry.stableDomId === null) {
      return { kind: "interference", reason: "message-identity-ambiguous" }
    }
    const userMessageId = targetUser.entry.stableDomId
    if (
      this.observedCausalUserMessageId !== null &&
      this.observedCausalUserMessageId !== userMessageId
    ) {
      this.clearPendingCompletion()
      return { kind: "interference", reason: "transcript-interference" }
    }
    this.observedCausalUserMessageId = userMessageId

    const protectedSequence = snapshot.slice(targetUser.index).map((entry) => entry.stableDomId)
    if (protectedSequence.some((messageId) => messageId === null)) {
      this.clearPendingCompletion()
      return { kind: "interference", reason: "message-identity-ambiguous" }
    }
    const sequence = protectedSequence.filter((messageId): messageId is string => messageId !== null)
    if (
      this.protectedMessageSequence !== null &&
      !this.protectedMessageSequence.every((messageId, index) => sequence[index] === messageId)
    ) {
      this.clearPendingCompletion()
      return { kind: "interference", reason: "transcript-interference" }
    }
    this.protectedMessageSequence = sequence

    if (generating) {
      this.stableCandidate = null
      this.bufferedCompletion = null
      return { kind: "pending" }
    }

    const assistant = this.findFollowingAssistant(snapshot, targetUser.index)
    if (assistant.kind === "interference") {
      this.clearPendingCompletion()
      return { kind: "interference", reason: assistant.reason }
    }
    if (assistant.kind === "pending") {
      this.bufferedCompletion = null
      this.stableCandidate = null
      return { kind: "pending" }
    }

    const response = this.observeStableAssistant(assistant.entry)
    if (response === null) return { kind: "pending" }
    if (this.causedByUserMessageId === null) {
      this.bufferedCompletion = {
        waitId: this.expected.waitId,
        userMessageId,
        response,
      }
      return { kind: "pending" }
    }
    if (this.causedByUserMessageId !== userMessageId) {
      this.clearPendingCompletion()
      return { kind: "interference", reason: "unexpected-user-input" }
    }

    this.emitted = true
    return { kind: "complete", response }
  }

  private clearPendingCompletion(): void {
    this.bufferedCompletion = null
    this.stableCandidate = null
  }

  takeBufferedCompletion(waitId: string): AssistantResponse | null {
    const buffered = this.bufferedCompletion
    if (
      buffered === null ||
      this.expected?.waitId !== waitId ||
      buffered.waitId !== waitId ||
      this.causedByUserMessageId !== buffered.userMessageId
    ) {
      return null
    }

    this.bufferedCompletion = null
    this.emitted = true
    return buffered.response
  }

  private findExpectedUser(
    snapshot: readonly TranscriptEntry[],
  ):
    | { readonly kind: "found"; readonly entry: TranscriptEntry; readonly index: number }
    | { readonly kind: "pending" }
    | { readonly kind: "interference"; readonly reason: RelayFailureReason } {
    const candidates = snapshot
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.role === "user" && !this.baselineMessageIds.has(entry.stableDomId ?? ""))

    if (this.causedByUserMessageId !== null) {
      const matches = snapshot
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry.role === "user" && entry.stableDomId === this.causedByUserMessageId)
      if (matches.length > 1) {
        return { kind: "interference", reason: "message-identity-ambiguous" }
      }
      const match = matches[0]
      if (match !== undefined) {
        const unexpected = candidates.some(({ index }) => index > match.index)
        return unexpected
          ? { kind: "interference", reason: "unexpected-user-input" }
          : { kind: "found", ...match }
      }
      return candidates.length > 0
        ? { kind: "interference", reason: "unexpected-user-input" }
        : { kind: "pending" }
    }

    if (candidates.length > 1) {
      return { kind: "interference", reason: "unexpected-user-input" }
    }
    const candidate = candidates[0]
    if (candidate === undefined) return { kind: "pending" }
    if (candidate.entry.stableDomId === null) {
      return { kind: "interference", reason: "message-identity-ambiguous" }
    }
    return { kind: "found", ...candidate }
  }

  private findFollowingAssistant(
    snapshot: readonly TranscriptEntry[],
    userIndex: number,
  ):
    | { readonly kind: "found"; readonly entry: TranscriptEntry }
    | { readonly kind: "pending" }
    | { readonly kind: "interference"; readonly reason: RelayFailureReason } {
    let baselineIndex = -1
    if (this.baselineAssistantId !== null) {
      baselineIndex = snapshot.findIndex((entry) => entry.stableDomId === this.baselineAssistantId)
      if (baselineIndex < 0) return { kind: "pending" }
    }

    const assistantEntries = snapshot
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry, index }) => entry.role === "assistant" && index > userIndex && index > baselineIndex)
    const assistant = assistantEntries[0]
    if (assistant === undefined) return { kind: "pending" }

    if (snapshot.slice(userIndex + 1, assistant.index).some((entry) => entry.role === "user")) {
      return { kind: "interference", reason: "unexpected-user-input" }
    }
    if (
      snapshot
        .slice(userIndex, assistant.index + 1)
        .some((entry) => entry.branchEvidence !== null)
    ) {
      return { kind: "interference", reason: "transcript-interference" }
    }
    if (assistant.entry.stableDomId === null) {
      return { kind: "interference", reason: "message-identity-ambiguous" }
    }
    if (this.baselineMessageIds.has(assistant.entry.stableDomId)) {
      return { kind: "pending" }
    }
    return { kind: "found", entry: assistant.entry }
  }

  private observeStableAssistant(entry: TranscriptEntry): AssistantResponse | null {
    const messageId = entry.stableDomId
    if (messageId === null) return null
    const previous = this.stableCandidate
    if (previous === null || previous.messageId !== messageId || previous.text !== entry.text) {
      this.bufferedCompletion = null
      this.stableCandidate = { messageId, text: entry.text, since: Date.now() }
      return null
    }
    if (Date.now() - previous.since < COMPLETION_STABLE_MS) return null

    return {
      messageId,
      text: entry.text,
      textHash: hashNormalizedText(entry.text),
    }
  }
}
