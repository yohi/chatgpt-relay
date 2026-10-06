import type {
  AdapterSnapshot,
  AssistantResponse,
  CancelSubmissionResult,
  ConversationBinding,
  ExpectedResponse,
  PendingTransfer,
  RelayFailureReason,
  RelaySession,
  RelayState,
  RelayStatusSnapshot,
  Side,
} from "./domain"
import type { AdapterCommandName } from "./errors"

export type AdapterReadyMessage = { readonly type: "adapter-ready"; readonly sessionId?: string }
export type AdapterInspectRequest = { readonly type: "adapter-inspect" }
export type AdapterInspectResult = { readonly type: "adapter-inspect-result"; readonly snapshot: AdapterSnapshot }

export type AdapterCommandFailure =
  | { readonly type: "adapter-command-failure"; readonly command: "adapter-inspect"; readonly reason: RelayFailureReason }
  | {
      readonly type: "adapter-command-failure"
      readonly command: "arm-response"
      readonly sessionId: string
      readonly waitId: string
      readonly reason: RelayFailureReason
    }
  | {
      readonly type: "adapter-command-failure"
      readonly command: "prepare-peer-response" | "commit-transfer"
      readonly sessionId: string
      readonly transferId: string
      readonly waitId: string
      readonly reason: RelayFailureReason
    }
  | {
      readonly type: "adapter-command-failure"
      readonly command: "bind-expected-user-turn"
      readonly sessionId: string
      readonly waitId: string
      readonly reason: RelayFailureReason
    }
  | {
      readonly type: "adapter-command-failure"
      readonly command: "cancel-transfer"
      readonly sessionId: string
      readonly transferId: string
      readonly reason: RelayFailureReason
    }

export type ArmResponseMessage = {
  readonly type: "arm-response"
  readonly expected: ExpectedResponse
  readonly authorizationRevision: number
}
export type ArmResponseResult = {
  readonly type: "arm-response-result"
  readonly ok: true
  readonly sessionId: string
  readonly waitId: string
}
export type InitialUserTurnObservedMessage = {
  readonly type: "initial-user-turn-observed"
  readonly sessionId: string
  readonly waitId: string
  readonly userMessageId: string
  readonly conversationIdentity: string
}
export type AssistantCompleteMessage = {
  readonly type: "assistant-complete"
  readonly sessionId: string
  readonly waitId: string
  readonly causedByTransferId?: string
  readonly causedByUserMessageId?: string
  readonly message: AssistantResponse
}
export type PreparePeerResponseMessage = {
  readonly type: "prepare-peer-response"
  readonly sessionId: string
  readonly transferId: string
  readonly waitId: string
  readonly text: string
  readonly authorizationRevision: number
}
export type TransferPreparedMessage = {
  readonly type: "transfer-prepared"
  readonly sessionId: string
  readonly transferId: string
  readonly waitId: string
  readonly baselineMessageId: string | null
  readonly conversationIdentity: string | null
}
export type CommitTransferMessage = {
  readonly type: "commit-transfer"
  readonly sessionId: string
  readonly transferId: string
  readonly waitId: string
  readonly authorizationRevision: number
  readonly authorizedConversationIdentity: string | null
}
export type TransferCommittedMessage = {
  readonly type: "transfer-committed"
  readonly sessionId: string
  readonly transferId: string
  readonly waitId: string
  readonly userMessageId: string
  readonly conversationIdentity: string
}
export type BindExpectedUserTurnMessage = {
  readonly type: "bind-expected-user-turn"
  readonly sessionId: string
  readonly waitId: string
  readonly userMessageId: string
  readonly conversationIdentity: string
  readonly authorizationRevision: number
}
export type BindExpectedUserTurnResult = {
  readonly type: "bind-expected-user-turn-result"
  readonly ok: true
  readonly sessionId: string
  readonly waitId: string
}
export type TranscriptInterferenceMessage = {
  readonly type: "transcript-interference"
  readonly sessionId: string
  readonly waitId: string
  readonly reason: "unexpected-user-turn" | "regenerate" | "edit" | "branch" | "causality-ambiguous"
}
export type CancelTransferMessage = {
  readonly type: "cancel-transfer"
  readonly sessionId: string
  readonly transferId: string
}
export type CancelTransferResult = {
  readonly type: "cancel-transfer-result"
  readonly sessionId: string
  readonly result: CancelSubmissionResult
}
export type AdapterInspectResponse = AdapterInspectResult | AdapterCommandFailure
export type ArmResponseResponse = ArmResponseResult | AdapterCommandFailure
export type PreparePeerResponseResponse = TransferPreparedMessage | AdapterCommandFailure
export type CommitTransferResponse = TransferCommittedMessage | AdapterCommandFailure
export type BindExpectedUserTurnResponse = BindExpectedUserTurnResult | AdapterCommandFailure
export type CancelTransferResponse = CancelTransferResult | AdapterCommandFailure

export type RelayStatusRequest = { readonly type: "relay-status" }
export type RelayStatusResult = { readonly type: "relay-status-result"; readonly status: RelayStatusSnapshot }
export type RelayStartRequest = { readonly type: "relay-start" }
export type RelayStartResult =
  | { readonly type: "relay-start-result"; readonly ok: true; readonly status: RelayStatusSnapshot }
  | {
      readonly type: "relay-start-result"
      readonly ok: false
      readonly reason: RelayFailureReason
      readonly status: RelayStatusSnapshot
    }
export type RelayStopRequest = { readonly type: "relay-stop"; readonly sessionId: string }
export type RelayStopResult =
  | { readonly type: "relay-stop-result"; readonly ok: true; readonly status: RelayStatusSnapshot }
  | {
      readonly type: "relay-stop-result"
      readonly ok: false
      readonly reason: RelayFailureReason
      readonly status: RelayStatusSnapshot
    }
export type RelayPreferencesGet = { readonly type: "relay-preferences-get" }
export type RelayPreferencesResult = { readonly type: "relay-preferences-result"; readonly maxTurns: number }
export type RelayPreferencesSet = { readonly type: "relay-preferences-set"; readonly maxTurns: number }
export type RelayPreferencesSetResult =
  | { readonly type: "relay-preferences-set-result"; readonly ok: true; readonly maxTurns: number }
  | {
      readonly type: "relay-preferences-set-result"
      readonly ok: false
      readonly reason: "invalid-max-turns"
      readonly maxTurns: number
    }

export type RelayMessage =
  | AdapterReadyMessage
  | AdapterCommandFailure
  | AdapterInspectRequest
  | AdapterInspectResult
  | ArmResponseMessage
  | ArmResponseResult
  | InitialUserTurnObservedMessage
  | AssistantCompleteMessage
  | PreparePeerResponseMessage
  | TransferPreparedMessage
  | CommitTransferMessage
  | TransferCommittedMessage
  | BindExpectedUserTurnMessage
  | BindExpectedUserTurnResult
  | TranscriptInterferenceMessage
  | CancelTransferMessage
  | CancelTransferResult
  | RelayStatusRequest
  | RelayStatusResult
  | RelayStartRequest
  | RelayStartResult
  | RelayStopRequest
  | RelayStopResult
  | RelayPreferencesGet
  | RelayPreferencesResult
  | RelayPreferencesSet
  | RelayPreferencesSetResult

const relayFailureReasons = [
  "pair-invalid",
  "adapter-not-ready",
  "adapter-command-failed",
  "adapter-transport-failed",
  "generation-in-progress",
  "dom-contract-ambiguous",
  "conversation-changed",
  "relay-causality-ambiguous",
  "message-identity-ambiguous",
  "transcript-interference",
  "unexpected-user-input",
  "submission-failed",
  "split-view-changed",
  "tab-closed",
  "invalid-navigation",
  "invalid-session",
  "recovery-ambiguous",
  "max-turns-reached",
  "stopped-by-user",
] as const

const relayStates = [
  "idle",
  "waiting-a",
  "dispatching-b",
  "waiting-b",
  "dispatching-a",
  "stopping",
  "stopped",
  "error",
] as const

const sides = ["a", "b"] as const
const adapterCommands = [
  "adapter-inspect",
  "arm-response",
  "prepare-peer-response",
  "commit-transfer",
  "bind-expected-user-turn",
  "cancel-transfer",
] as const satisfies readonly AdapterCommandName[]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean"
}

function isOptionalString(value: Record<string, unknown>, key: string): boolean {
  return !(key in value) || isString(value[key])
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value)
}

function isSide(value: unknown): value is Side {
  return value === sides[0] || value === sides[1]
}

function isRelayState(value: unknown): value is RelayState {
  return relayStates.some((state) => state === value)
}

export function isRelayFailureReason(value: unknown): value is RelayFailureReason {
  return relayFailureReasons.some((reason) => reason === value)
}

function isConversationBinding(value: unknown): value is ConversationBinding {
  if (!isRecord(value)) return false
  if (value["state"] === "unbound") return true
  return value["state"] === "bound" && isString(value["conversationIdentity"])
}

function isTranscriptMessageIdentity(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value["messageId"]) &&
    (value["role"] === "user" || value["role"] === "assistant") &&
    isString(value["textHash"])
  )
}

function isAssistantResponse(value: unknown): value is AssistantResponse {
  return (
    isRecord(value) &&
    isString(value["messageId"]) &&
    isString(value["text"]) &&
    isString(value["textHash"])
  )
}

function isExpectedResponse(value: unknown): value is ExpectedResponse {
  return (
    isRecord(value) &&
    isString(value["sessionId"]) &&
    isString(value["waitId"]) &&
    isSide(value["side"]) &&
    isNumber(value["tabId"]) &&
    isNullableString(value["baselineMessageId"]) &&
    isOptionalString(value, "causedByTransferId") &&
    isOptionalString(value, "causedByUserMessageId")
  )
}

function isPendingTransfer(value: unknown): value is PendingTransfer {
  return (
    isRecord(value) &&
    isString(value["id"]) &&
    isNumber(value["sourceTabId"]) &&
    isNumber(value["targetTabId"]) &&
    isString(value["sourceMessageId"]) &&
    isString(value["payloadHash"]) &&
    isString(value["targetWaitId"]) &&
    (!("targetBaselineMessageId" in value) || isNullableString(value["targetBaselineMessageId"])) &&
    isOptionalString(value, "targetUserMessageId") &&
    (!("authorizationRevision" in value) || isNumber(value["authorizationRevision"])) &&
    (value["submissionState"] === "preparing" ||
      value["submissionState"] === "authorized" ||
      value["submissionState"] === "committed")
  )
}

function isRelaySession(value: unknown): value is RelaySession {
  return (
    isRecord(value) &&
    isString(value["id"]) &&
    isNumber(value["revision"]) &&
    isNumber(value["splitViewId"]) &&
    isNumber(value["tabA"]) &&
    isNumber(value["tabB"]) &&
    isConversationBinding(value["conversationA"]) &&
    isConversationBinding(value["conversationB"]) &&
    isRelayState(value["state"]) &&
    isNumber(value["turn"]) &&
    isNumber(value["maxTurns"]) &&
    (!("expectedResponse" in value) || isExpectedResponse(value["expectedResponse"])) &&
    isOptionalString(value, "lastMessageA") &&
    isOptionalString(value, "lastMessageB") &&
    (!("pendingTransfer" in value) || isPendingTransfer(value["pendingTransfer"])) &&
    (!("stopReason" in value) || isRelayFailureReason(value["stopReason"]))
  )
}

function isCancelSubmissionResult(value: unknown): value is CancelSubmissionResult {
  if (!isRecord(value) || !isString(value["transferId"])) return false
  if (value["status"] === "cancelled-before-commit" || value["status"] === "unknown") return true
  return (
    value["status"] === "already-committed" &&
    isNullableString(value["userMessageId"]) &&
    isNullableString(value["conversationIdentity"])
  )
}

function isAdapterSnapshot(value: unknown): value is AdapterSnapshot {
  return (
    isRecord(value) &&
    isBoolean(value["ready"]) &&
    isBoolean(value["generating"]) &&
    isNullableString(value["conversationIdentity"]) &&
    (value["latestUser"] === null || isTranscriptMessageIdentity(value["latestUser"])) &&
    (value["latestAssistant"] === null || isAssistantResponse(value["latestAssistant"]))
  )
}

function isRelayStatusSnapshot(value: unknown): value is RelayStatusSnapshot {
  if (!isRecord(value) || !isRecord(value["pair"])) return false
  const pair = value["pair"]
  const validPair =
    (pair["valid"] === false && pair["reason"] === "pair-invalid") ||
    (pair["valid"] === true &&
      isNumber(pair["splitViewId"]) &&
      isNumber(pair["tabA"]) &&
      isNumber(pair["tabB"]))
  if (!validPair) return false

  const session = value["session"]
  if (session === null) return true
  return (
    isRecord(session) &&
    isString(session["sessionId"]) &&
    isRelayState(session["state"]) &&
    isNumber(session["turn"]) &&
    isNumber(session["maxTurns"]) &&
    (session["expectedSide"] === null || isSide(session["expectedSide"])) &&
    isNullableString(session["waitId"]) &&
    (session["reason"] === null || isRelayFailureReason(session["reason"]))
  )
}

function isAdapterCommandFailure(value: Record<string, unknown>): boolean {
  if (value["type"] !== "adapter-command-failure" || !isRelayFailureReason(value["reason"])) return false
  const command = value["command"]
  if (!adapterCommands.some((candidate) => candidate === command)) return false
  if (command === "adapter-inspect") return true
  if (!isString(value["sessionId"])) return false
  if (command === "arm-response" || command === "bind-expected-user-turn") {
    return isString(value["waitId"])
  }
  if (command === "prepare-peer-response" || command === "commit-transfer") {
    return isString(value["transferId"]) && isString(value["waitId"])
  }
  return command === "cancel-transfer" && isString(value["transferId"])
}

function isRelayMessage(value: unknown): value is RelayMessage {
  if (!isRecord(value) || !isString(value["type"])) return false
  switch (value["type"]) {
    case "adapter-ready":
      return isOptionalString(value, "sessionId")
    case "adapter-command-failure":
      return isAdapterCommandFailure(value)
    case "adapter-inspect":
    case "relay-status":
    case "relay-start":
    case "relay-preferences-get":
      return true
    case "adapter-inspect-result":
      return isAdapterSnapshot(value["snapshot"])
    case "arm-response":
      return isExpectedResponse(value["expected"]) && isNumber(value["authorizationRevision"])
    case "arm-response-result":
    case "bind-expected-user-turn-result":
      return (
        value["ok"] === true && isString(value["sessionId"]) && isString(value["waitId"])
      )
    case "initial-user-turn-observed":
      return (
        isString(value["sessionId"]) &&
        isString(value["waitId"]) &&
        isString(value["userMessageId"]) &&
        isString(value["conversationIdentity"])
      )
    case "assistant-complete":
      return (
        isString(value["sessionId"]) &&
        isString(value["waitId"]) &&
        isOptionalString(value, "causedByTransferId") &&
        isOptionalString(value, "causedByUserMessageId") &&
        isAssistantResponse(value["message"])
      )
    case "prepare-peer-response":
      return (
        isString(value["sessionId"]) &&
        isString(value["transferId"]) &&
        isString(value["waitId"]) &&
        isString(value["text"]) &&
        isNumber(value["authorizationRevision"])
      )
    case "transfer-prepared":
      return (
        isString(value["sessionId"]) &&
        isString(value["transferId"]) &&
        isString(value["waitId"]) &&
        isNullableString(value["baselineMessageId"]) &&
        isNullableString(value["conversationIdentity"])
      )
    case "commit-transfer":
      return (
        isString(value["sessionId"]) &&
        isString(value["transferId"]) &&
        isString(value["waitId"]) &&
        isNumber(value["authorizationRevision"]) &&
        isNullableString(value["authorizedConversationIdentity"])
      )
    case "transfer-committed":
      return (
        isString(value["sessionId"]) &&
        isString(value["transferId"]) &&
        isString(value["waitId"]) &&
        isString(value["userMessageId"]) &&
        isString(value["conversationIdentity"])
      )
    case "bind-expected-user-turn":
      return (
        isString(value["sessionId"]) &&
        isString(value["waitId"]) &&
        isString(value["userMessageId"]) &&
        isString(value["conversationIdentity"]) &&
        isNumber(value["authorizationRevision"])
      )
    case "transcript-interference":
      return (
        isString(value["sessionId"]) &&
        isString(value["waitId"]) &&
        (value["reason"] === "unexpected-user-turn" ||
          value["reason"] === "regenerate" ||
          value["reason"] === "edit" ||
          value["reason"] === "branch" ||
          value["reason"] === "causality-ambiguous")
      )
    case "cancel-transfer":
      return isString(value["sessionId"]) && isString(value["transferId"])
    case "cancel-transfer-result":
      return isString(value["sessionId"]) && isCancelSubmissionResult(value["result"])
    case "relay-status-result":
      return isRelayStatusSnapshot(value["status"])
    case "relay-start-result":
      return (
        isRelayStatusSnapshot(value["status"]) &&
        (value["ok"] === true || (value["ok"] === false && isRelayFailureReason(value["reason"])))
      )
    case "relay-stop":
      return isString(value["sessionId"])
    case "relay-stop-result":
      return (
        isRelayStatusSnapshot(value["status"]) &&
        (value["ok"] === true || (value["ok"] === false && isRelayFailureReason(value["reason"])))
      )
    case "relay-preferences-result":
      return isPositiveInteger(value["maxTurns"])
    case "relay-preferences-set":
      return isNumber(value["maxTurns"])
    case "relay-preferences-set-result":
      return (
        isPositiveInteger(value["maxTurns"]) &&
        (value["ok"] === true || (value["ok"] === false && value["reason"] === "invalid-max-turns"))
      )
    default:
      return false
  }
}

export function parseRelayMessage(value: unknown): RelayMessage | null {
  return isRelayMessage(value) ? value : null
}
