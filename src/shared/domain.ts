export type Side = "a" | "b"

export type ConversationBinding =
  | { readonly state: "unbound" }
  | { readonly state: "bound"; readonly conversationIdentity: string }

export type TranscriptMessageIdentity = {
  readonly messageId: string
  readonly role: "user" | "assistant"
  readonly textHash: string
}

export type AssistantResponse = {
  readonly messageId: string
  readonly text: string
  readonly textHash: string
}

export type RelayState =
  | "idle"
  | "waiting-a"
  | "dispatching-b"
  | "waiting-b"
  | "dispatching-a"
  | "stopping"
  | "stopped"
  | "error"

export type ExpectedResponse = {
  readonly sessionId: string
  readonly waitId: string
  readonly side: Side
  readonly tabId: number
  readonly baselineMessageId: string | null
  readonly causedByTransferId?: string
  readonly causedByUserMessageId?: string
}

export type PendingTransfer = {
  readonly id: string
  readonly sourceTabId: number
  readonly targetTabId: number
  readonly sourceMessageId: string
  readonly payloadHash: string
  readonly targetWaitId: string
  readonly targetBaselineMessageId?: string | null
  readonly targetUserMessageId?: string
  readonly authorizationRevision?: number
  readonly submissionState: "preparing" | "authorized" | "committed"
}

export type RelaySession = {
  readonly id: string
  readonly revision: number
  readonly splitViewId: number
  readonly tabA: number
  readonly tabB: number
  readonly conversationA: ConversationBinding
  readonly conversationB: ConversationBinding
  readonly state: RelayState
  readonly turn: number
  readonly maxTurns: number
  readonly expectedResponse?: ExpectedResponse
  readonly lastMessageA?: string
  readonly lastMessageB?: string
  readonly pendingTransfer?: PendingTransfer
  readonly stopReason?: RelayFailureReason
}

export type AdapterSnapshot = {
  readonly ready: boolean
  readonly generating: boolean
  readonly conversationIdentity: string | null
  readonly latestUser: TranscriptMessageIdentity | null
  readonly latestAssistant: AssistantResponse | null
}

export type PreparedSubmission = {
  readonly transferId: string
  readonly waitId: string
  readonly baselineMessageId: string | null
  readonly conversationIdentity: string | null
}

export type CommittedSubmission = {
  readonly transferId: string
  readonly waitId: string
  readonly userMessageId: string
  readonly conversationIdentity: string
}

export type CancelSubmissionResult =
  | { readonly status: "cancelled-before-commit"; readonly transferId: string }
  | {
      readonly status: "already-committed"
      readonly transferId: string
      readonly userMessageId: string | null
      readonly conversationIdentity: string | null
    }
  | { readonly status: "unknown"; readonly transferId: string }

export type RelayFailureReason =
  | "pair-invalid"
  | "adapter-not-ready"
  | "adapter-command-failed"
  | "adapter-transport-failed"
  | "generation-in-progress"
  | "dom-contract-ambiguous"
  | "conversation-changed"
  | "relay-causality-ambiguous"
  | "message-identity-ambiguous"
  | "transcript-interference"
  | "unexpected-user-input"
  | "submission-failed"
  | "split-view-changed"
  | "tab-closed"
  | "invalid-navigation"
  | "invalid-session"
  | "recovery-ambiguous"
  | "max-turns-reached"
  | "stopped-by-user"

export type RelayPairStatus =
  | { readonly valid: false; readonly reason: "pair-invalid" }
  | { readonly valid: true; readonly splitViewId: number; readonly tabA: number; readonly tabB: number }

export type RelayStatusSnapshot = {
  readonly pair: RelayPairStatus
  readonly session:
    | null
    | {
        readonly sessionId: string
        readonly state: RelayState
        readonly turn: number
        readonly maxTurns: number
        readonly expectedSide: Side | null
        readonly waitId: string | null
        readonly reason: RelayFailureReason | null
      }
}
