import type {
  AdapterSnapshot,
  AssistantResponse,
  CancelSubmissionResult,
  ExpectedResponse,
  PreparedSubmission,
  RelayFailureReason,
  TranscriptMessageIdentity,
} from "../shared/domain"
import { RelayDomainError } from "../shared/errors"
import type {
  AssistantCompleteMessage,
  InitialUserTurnObservedMessage,
  TranscriptInterferenceMessage,
} from "../shared/protocol"
import { CompletionTracker, COMPLETION_STABLE_MS } from "./completion-tracker"
import {
  classifyTranscriptMutationControl,
  findSubmitControl,
  inspectChatGptDom,
  isMainComposerSubmission,
  readTranscript,
} from "./dom-contract"
import type { TranscriptEntry } from "./dom-contract"
import { hashNormalizedText, normalizeRelayText } from "./transcript-identity"

const COMMIT_EVIDENCE_TIMEOUT_MS = 5_000

export type AdapterEvent =
  | InitialUserTurnObservedMessage
  | AssistantCompleteMessage
  | TranscriptInterferenceMessage

type PreparedState = {
  readonly sessionId: string
  readonly transferId: string
  readonly waitId: string
  readonly text: string
  readonly prepared: PreparedSubmission
  readonly baselineMessageIds: ReadonlySet<string>
  commitPointCrossed: boolean
  committed: {
    readonly userMessageId: string
    readonly conversationIdentity: string
  } | null
}

type AdapterBindInput = {
  readonly sessionId: string
  readonly waitId: string
  readonly userMessageId: string
  readonly conversationIdentity: string
  readonly authorizationRevision: number
}

type CommitInput = {
  readonly sessionId: string
  readonly transferId: string
  readonly waitId: string
  readonly authorizationRevision: number
  readonly authorizedConversationIdentity: string | null
}

function transferKey(sessionId: string, transferId: string): string {
  return `${sessionId}:${transferId}`
}

function isInitialManualAWait(expected: ExpectedResponse): boolean {
  return (
    expected.side === "a" &&
    expected.causedByTransferId === undefined &&
    expected.causedByUserMessageId === undefined
  )
}

function isObservedNewChatPathname(pathname: string): boolean {
  return pathname === "/" || pathname === "/ja-JP/"
}

function toTranscriptIdentity(entry: TranscriptEntry): TranscriptMessageIdentity {
  if (entry.stableDomId === null) throw new RelayDomainError("message-identity-ambiguous")
  return {
    messageId: entry.stableDomId,
    role: entry.role,
    textHash: hashNormalizedText(entry.text),
  }
}

function latestEntry(
  entries: readonly TranscriptEntry[],
  role: TranscriptEntry["role"],
): TranscriptEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry?.role === role) return entry
  }
  return null
}

function mutationReason(reason: RelayFailureReason, entries: readonly TranscriptEntry[]): TranscriptInterferenceMessage["reason"] {
  if (reason === "unexpected-user-input") return "unexpected-user-turn"
  if (reason === "transcript-interference") {
    let evidence: string | null = null
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]
      if (entry !== undefined && entry.branchEvidence !== null) {
        evidence = entry.branchEvidence
        break
      }
    }
    if (evidence?.includes("edit")) return "edit"
    if (evidence?.includes("regenerate")) return "regenerate"
    return "causality-ambiguous"
  }
  return "causality-ambiguous"
}

export class ChatGPTAdapter {
  private readonly tracker = new CompletionTracker()
  private readonly prepared = new Map<string, PreparedState>()
  private expected: ExpectedResponse | null = null
  private boundUserMessageId: string | null = null
  private baselineMessageIds = new Set<string>()
  private initialUserTurnEmitted = false
  private initialManualSubmissionObserved = false
  private armedConversationIdentity: string | null = null
  private emittedCompletion = false
  private eventHandler: ((event: AdapterEvent) => void) | null = null
  private pendingEvents: AdapterEvent[] = []
  private mutationObserver: MutationObserver | null = null
  private completionTimer: number | null = null
  private mutationClickListener: ((event: Event) => void) | null = null
  private mainSubmitListener: ((event: Event) => void) | null = null
  private emittedInterference = false

  constructor(private readonly pageDocument: Document) {}

  async inspect(): Promise<AdapterSnapshot> {
    const inspection = inspectChatGptDom(this.pageDocument)
    const transcript = inspection.transcript
    const user = latestEntry(transcript, "user")
    const assistant = latestEntry(transcript, "assistant")
    return {
      ready: inspection.ready,
      generating: inspection.generating,
      conversationIdentity: inspection.conversationIdentity,
      latestUser: user === null ? null : toTranscriptIdentity(user),
      latestAssistant:
        assistant === null
          ? null
          : {
              messageId: toTranscriptIdentity(assistant).messageId,
              text: assistant.text,
              textHash: hashNormalizedText(assistant.text),
            },
    }
  }

  async armExpectedResponse(expected: ExpectedResponse): Promise<void> {
    const inspection = inspectChatGptDom(this.pageDocument)
    if (!inspection.ready) throw new RelayDomainError("adapter-not-ready")
    if (inspection.generating) throw new RelayDomainError("generation-in-progress")
    this.expected = expected
    this.boundUserMessageId = expected.causedByUserMessageId ?? null
    this.initialUserTurnEmitted = false
    this.initialManualSubmissionObserved = false
    this.armedConversationIdentity = inspection.conversationIdentity
    this.emittedCompletion = false
    this.emittedInterference = false
    this.baselineMessageIds = new Set(
      inspection.transcript.flatMap((entry) => (entry.stableDomId === null ? [] : [entry.stableDomId])),
    )
    this.tracker.arm(expected, inspection.transcript)
  }

  async prepareSubmission(input: {
    readonly sessionId: string
    readonly transferId: string
    readonly waitId: string
    readonly text: string
  }): Promise<PreparedSubmission> {
    const key = transferKey(input.sessionId, input.transferId)
    if (this.prepared.has(key) || normalizeRelayText(input.text).length === 0) {
      throw new RelayDomainError("submission-failed")
    }
    const inspection = inspectChatGptDom(this.pageDocument)
    if (!inspection.ready) throw new RelayDomainError("adapter-not-ready")
    if (inspection.generating) throw new RelayDomainError("generation-in-progress")
    if (normalizeRelayText(inspection.composer.textContent ?? "").length > 0) {
      throw new RelayDomainError("unexpected-user-input")
    }

    const prepared: PreparedSubmission = {
      transferId: input.transferId,
      waitId: input.waitId,
      baselineMessageId: latestEntry(inspection.transcript, "assistant")?.stableDomId ?? null,
      conversationIdentity: inspection.conversationIdentity,
    }
    const state: PreparedState = {
      ...input,
      prepared,
      baselineMessageIds: new Set(
        inspection.transcript.flatMap((entry) => (entry.stableDomId === null ? [] : [entry.stableDomId])),
      ),
      commitPointCrossed: false,
      committed: null,
    }

    inspection.composer.textContent = input.text
    const inputEvent = this.pageDocument.defaultView?.Event
    if (inputEvent === undefined) {
      inspection.composer.textContent = ""
      throw new RelayDomainError("adapter-not-ready")
    }
    inspection.composer.dispatchEvent(new inputEvent("input", { bubbles: true }))
    if (inspection.composer.textContent !== input.text) {
      throw new RelayDomainError("submission-failed")
    }
    this.prepared.set(key, state)
    return prepared
  }

  async commitSubmission(input: CommitInput): Promise<{
    readonly transferId: string
    readonly waitId: string
    readonly userMessageId: string
    readonly conversationIdentity: string
  }> {
    const key = transferKey(input.sessionId, input.transferId)
    const state = this.prepared.get(key)
    if (
      state === undefined ||
      state.waitId !== input.waitId ||
      input.authorizationRevision < 1 ||
      state.commitPointCrossed
    ) {
      throw new RelayDomainError("submission-failed")
    }
    const inspection = inspectChatGptDom(this.pageDocument)
    if (inspection.generating) throw new RelayDomainError("generation-in-progress")
    if (
      inspection.conversationIdentity !== state.prepared.conversationIdentity ||
      inspection.conversationIdentity !== input.authorizedConversationIdentity
    ) {
      throw new RelayDomainError("conversation-changed")
    }
    if (inspection.composer.textContent !== state.text) {
      throw new RelayDomainError("unexpected-user-input")
    }

    const submit = findSubmitControl(this.pageDocument)
    state.commitPointCrossed = true
    submit.click()
    const committed = await this.waitForCommittedUserTurn(state)
    state.committed = committed
    return {
      transferId: state.transferId,
      waitId: state.waitId,
      userMessageId: committed.userMessageId,
      conversationIdentity: committed.conversationIdentity,
    }
  }

  async bindExpectedUserTurn(input: AdapterBindInput): Promise<void> {
    const expected = this.expected
    if (expected === null || expected.sessionId !== input.sessionId || expected.waitId !== input.waitId) {
      throw new RelayDomainError("invalid-session")
    }
    if (
      (expected.causedByUserMessageId !== undefined &&
        expected.causedByUserMessageId !== input.userMessageId) ||
      (this.boundUserMessageId !== null && this.boundUserMessageId !== input.userMessageId)
    ) {
      throw new RelayDomainError("relay-causality-ambiguous")
    }
    const inspection = inspectChatGptDom(this.pageDocument)
    if (inspection.conversationIdentity !== input.conversationIdentity) {
      throw new RelayDomainError("conversation-changed")
    }
    const transcript = readTranscript(this.pageDocument)
    const matchingUsers = transcript.filter(
      (entry) => entry.role === "user" && entry.stableDomId === input.userMessageId,
    )
    if (matchingUsers.length !== 1) throw new RelayDomainError("relay-causality-ambiguous")
    this.tracker.bindUserTurn({
      waitId: input.waitId,
      userMessageId: input.userMessageId,
      conversationIdentity: input.conversationIdentity,
    })
    this.boundUserMessageId = input.userMessageId
    const buffered = this.tracker.takeBufferedCompletion(input.waitId)
    if (buffered !== null) {
      this.emittedCompletion = true
      this.emit(this.completeEvent(expected, buffered, input.userMessageId))
    }
    this.observePage()
  }

  async cancelSubmission(input: {
    readonly sessionId: string
    readonly transferId: string
  }): Promise<CancelSubmissionResult> {
    const key = transferKey(input.sessionId, input.transferId)
    const state = this.prepared.get(key)
    if (state === undefined) return { status: "unknown", transferId: input.transferId }
    if (state.commitPointCrossed) {
      if (state.committed === null) return { status: "unknown", transferId: input.transferId }
      return {
        status: "already-committed",
        transferId: state.transferId,
        userMessageId: state.committed.userMessageId,
        conversationIdentity: state.committed.conversationIdentity,
      }
    }

    const inspection = inspectChatGptDom(this.pageDocument)
    if (inspection.composer.textContent === state.text) inspection.composer.textContent = ""
    this.prepared.delete(key)
    return { status: "cancelled-before-commit", transferId: input.transferId }
  }

  startObserving(onEvent: (event: AdapterEvent) => void): () => void {
    const view = this.pageDocument.defaultView
    const Observer = view?.MutationObserver
    if (Observer === undefined || this.pageDocument.body === null) {
      throw new RelayDomainError("adapter-not-ready")
    }
    this.stopObserving()
    this.eventHandler = onEvent
    for (const event of this.pendingEvents) onEvent(event)
    this.pendingEvents = []
    this.mutationObserver = new Observer(() => {
      this.observePage()
      this.scheduleCompletionCheck()
    })
    this.mutationClickListener = (event) => {
      const expected = this.expected
      if (expected === null || this.emittedCompletion || this.emittedInterference) return
      const mutation = classifyTranscriptMutationControl(this.pageDocument, event.target)
      if (mutation !== null) this.emitInterference(expected, mutation)
    }
    this.mainSubmitListener = (event) => {
      const expected = this.expected
      if (expected === null || !isInitialManualAWait(expected)) return
      try {
        if (isMainComposerSubmission(this.pageDocument, event.target)) {
          this.initialManualSubmissionObserved = true
        }
      } catch (error) {
        if (!(error instanceof RelayDomainError)) throw error
        this.emitInterference(expected, "causality-ambiguous")
      }
    }
    this.pageDocument.addEventListener("click", this.mutationClickListener, true)
    this.pageDocument.addEventListener("submit", this.mainSubmitListener, true)
    this.mutationObserver.observe(this.pageDocument.body, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    })
    this.observePage()
    return () => this.stopObserving()
  }

  private observePage(): void {
    const expected = this.expected
    if (expected === null) return
    let inspection: ReturnType<typeof inspectChatGptDom>
    let transcript: TranscriptEntry[]
    try {
      inspection = inspectChatGptDom(this.pageDocument)
      transcript = inspection.transcript
    } catch (error) {
      if (!(error instanceof RelayDomainError)) throw error
      if (
        error.reason === "dom-contract-ambiguous" &&
        isObservedNewChatPathname(this.pageDocument.location.pathname) &&
        isInitialManualAWait(expected)
      ) {
        if (this.initialManualSubmissionObserved) return
        this.emitInterference(expected, "causality-ambiguous")
        return
      }
      this.emitInterference(expected, "causality-ambiguous")
      return
    }

    if (isInitialManualAWait(expected) && !this.initialUserTurnEmitted) {
      const newUsers = transcript.filter(
        (entry) => entry.role === "user" && entry.stableDomId !== null && !this.baselineMessageIds.has(entry.stableDomId),
      )
      if (
        !this.initialManualSubmissionObserved &&
        ((this.armedConversationIdentity === null && inspection.conversationIdentity !== null) ||
          newUsers.length > 0)
      ) {
        this.emitInterference(
          expected,
          newUsers.length > 0 ? "unexpected-user-turn" : "causality-ambiguous",
        )
        return
      }
      if (newUsers.length > 1) {
        this.emitInterference(expected, "unexpected-user-turn")
      } else if (newUsers.length === 1 && inspection.conversationIdentity !== null) {
        const user = newUsers[0]
        if (user !== undefined && user.stableDomId !== null) {
          this.initialUserTurnEmitted = true
          this.emit({
            type: "initial-user-turn-observed",
            sessionId: expected.sessionId,
            waitId: expected.waitId,
            userMessageId: user.stableDomId,
            conversationIdentity: inspection.conversationIdentity,
          })
        }
      }
    }

    const observation = this.tracker.observe(transcript, inspection.generating)
    if (observation.kind === "interference") {
      this.emitInterference(expected, mutationReason(observation.reason, transcript))
    } else if (observation.kind === "complete" && !this.emittedCompletion) {
      this.emittedCompletion = true
      const userMessageId = this.boundUserMessageId
      if (userMessageId !== null) {
        this.emittedCompletion = true
        this.emit(this.completeEvent(expected, observation.response, userMessageId))
      }
    }
  }

  private completeEvent(
    expected: ExpectedResponse,
    response: AssistantResponse,
    causedByUserMessageId: string,
  ): AssistantCompleteMessage {
    return {
      type: "assistant-complete",
      sessionId: expected.sessionId,
      waitId: expected.waitId,
      ...(expected.causedByTransferId === undefined
        ? {}
        : { causedByTransferId: expected.causedByTransferId }),
      causedByUserMessageId,
      message: response,
    }
  }

  private emit(event: AdapterEvent): void {
    if (this.eventHandler === null) {
      this.pendingEvents.push(event)
    } else {
      this.eventHandler(event)
    }
  }

  private emitInterference(
    expected: ExpectedResponse,
    reason: TranscriptInterferenceMessage["reason"],
  ): void {
    if (this.emittedInterference) return
    this.emittedInterference = true
    this.emit({
      type: "transcript-interference",
      sessionId: expected.sessionId,
      waitId: expected.waitId,
      reason,
    })
  }

  private scheduleCompletionCheck(): void {
    const view = this.pageDocument.defaultView
    if (view === null) return
    if (this.completionTimer !== null) view.clearTimeout(this.completionTimer)
    this.completionTimer = view.setTimeout(() => {
      this.completionTimer = null
      this.observePage()
    }, COMPLETION_STABLE_MS)
  }

  private stopObserving(): void {
    this.mutationObserver?.disconnect()
    this.mutationObserver = null
    if (this.mutationClickListener !== null) {
      this.pageDocument.removeEventListener("click", this.mutationClickListener, true)
    }
    this.mutationClickListener = null
    if (this.mainSubmitListener !== null) {
      this.pageDocument.removeEventListener("submit", this.mainSubmitListener, true)
    }
    this.mainSubmitListener = null
    if (this.completionTimer !== null) this.pageDocument.defaultView?.clearTimeout(this.completionTimer)
    this.completionTimer = null
    this.eventHandler = null
  }

  private waitForCommittedUserTurn(state: PreparedState): Promise<{
    readonly userMessageId: string
    readonly conversationIdentity: string
  }> {
    const view = this.pageDocument.defaultView
    const Observer = view?.MutationObserver
    if (view === null || view === undefined || Observer === undefined || this.pageDocument.body === null) {
      return Promise.reject(new RelayDomainError("relay-causality-ambiguous"))
    }

    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (
        result:
          | { readonly userMessageId: string; readonly conversationIdentity: string }
          | RelayDomainError,
      ) => {
        if (settled) return
        settled = true
        observer.disconnect()
        view.clearTimeout(timeout)
        if (result instanceof RelayDomainError) reject(result)
        else resolve(result)
      }
      const check = () => {
        try {
          const inspection = inspectChatGptDom(this.pageDocument)
          const transcript = inspection.transcript
          const candidates = transcript.filter(
            (entry) =>
              entry.role === "user" &&
              entry.stableDomId !== null &&
              !state.baselineMessageIds.has(entry.stableDomId) &&
              normalizeRelayText(entry.text) === normalizeRelayText(state.text),
          )
          if (candidates.length > 1) {
            finish(new RelayDomainError("relay-causality-ambiguous"))
            return
          }
          const candidate = candidates[0]
          if (candidate === undefined || candidate.stableDomId === null) return
          if (
            inspection.conversationIdentity === null ||
            (state.prepared.conversationIdentity !== null &&
              inspection.conversationIdentity !== state.prepared.conversationIdentity)
          ) {
            finish(new RelayDomainError("conversation-changed"))
            return
          }
          finish({
            userMessageId: candidate.stableDomId,
            conversationIdentity: inspection.conversationIdentity,
          })
        } catch (error) {
          if (error instanceof RelayDomainError) {
            const reason =
              error.reason === "message-identity-ambiguous" ? "relay-causality-ambiguous" : error.reason
            finish(new RelayDomainError(reason))
            return
          }
          throw error
        }
      }
      const observer = new Observer(check)
      const timeout = view.setTimeout(
        () => finish(new RelayDomainError("relay-causality-ambiguous")),
        COMMIT_EVIDENCE_TIMEOUT_MS,
      )
      observer.observe(this.pageDocument.body, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      })
      check()
    })
  }
}
