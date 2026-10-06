import type { ExpectedResponse, PendingTransfer, RelaySession } from "../shared/domain"
import { RelayDomainError } from "../shared/errors"
import { isRelayFailureReason } from "../shared/protocol"

const SESSION_KEY = "activeRelaySession"
const MAX_TURNS_KEY = "maxTurns"
const DEFAULT_MAX_TURNS = 10

export interface RelaySessionStore {
  read(): Promise<RelaySession | null>
  write(session: RelaySession): Promise<void>
  clear(): Promise<void>
}

export interface RelayPreferencesStore {
  readMaxTurns(): Promise<number>
  writeMaxTurns(value: number): Promise<void>
}

type TransitionExpectation = {
  readonly sessionId: string
  readonly revision?: number
  readonly waitId?: string
  readonly transferId?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function hasOptionalString(value: Record<string, unknown>, key: string): boolean {
  return !(key in value) || isString(value[key])
}

function isExpectedResponse(value: unknown): value is ExpectedResponse {
  return (
    isRecord(value) &&
    isString(value["sessionId"]) &&
    isString(value["waitId"]) &&
    (value["side"] === "a" || value["side"] === "b") &&
    isNumber(value["tabId"]) &&
    (value["baselineMessageId"] === null || isString(value["baselineMessageId"])) &&
    hasOptionalString(value, "causedByTransferId") &&
    hasOptionalString(value, "causedByUserMessageId")
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
    (!("targetBaselineMessageId" in value) ||
      value["targetBaselineMessageId"] === null ||
      isString(value["targetBaselineMessageId"])) &&
    hasOptionalString(value, "targetUserMessageId") &&
    (!("authorizationRevision" in value) || isNumber(value["authorizationRevision"])) &&
    (value["submissionState"] === "preparing" ||
      value["submissionState"] === "authorized" ||
      value["submissionState"] === "committed")
  )
}

function isConversationBinding(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value["state"] === "unbound" ||
      (value["state"] === "bound" && isString(value["conversationIdentity"])))
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
    ["idle", "waiting-a", "dispatching-b", "waiting-b", "dispatching-a", "stopping", "stopped", "error"].some(
      (state) => state === value["state"],
    ) &&
    isNumber(value["turn"]) &&
    isNumber(value["maxTurns"]) &&
    (!("expectedResponse" in value) || isExpectedResponse(value["expectedResponse"])) &&
    hasOptionalString(value, "lastMessageA") &&
    hasOptionalString(value, "lastMessageB") &&
    (!("pendingTransfer" in value) || isPendingTransfer(value["pendingTransfer"])) &&
    (!("stopReason" in value) || isRelayFailureReason(value["stopReason"]))
  )
}

export function createChromeSessionStore(): RelaySessionStore {
  return {
    async read() {
      const values = await chrome.storage.session.get(SESSION_KEY)
      const stored: unknown = values[SESSION_KEY]
      if (stored === undefined) return null
      if (!isRelaySession(stored)) throw new RelayDomainError("recovery-ambiguous")
      return stored
    },
    async write(session) {
      await chrome.storage.session.set({ [SESSION_KEY]: session })
    },
    async clear() {
      await chrome.storage.session.remove(SESSION_KEY)
    },
  }
}

export function createChromePreferencesStore(): RelayPreferencesStore {
  return {
    async readMaxTurns() {
      const values = await chrome.storage.local.get(MAX_TURNS_KEY)
      const stored: unknown = values[MAX_TURNS_KEY]
      return typeof stored === "number" && Number.isInteger(stored) && stored >= 1
        ? stored
        : DEFAULT_MAX_TURNS
    },
    async writeMaxTurns(value) {
      await chrome.storage.local.set({ [MAX_TURNS_KEY]: value })
    },
  }
}

export function assertCurrentSession(
  current: RelaySession | null,
  expected: TransitionExpectation,
): RelaySession {
  if (
    current === null ||
    current.id !== expected.sessionId ||
    (expected.revision !== undefined && current.revision !== expected.revision) ||
    (expected.waitId !== undefined && current.expectedResponse?.waitId !== expected.waitId) ||
    (expected.transferId !== undefined && current.pendingTransfer?.id !== expected.transferId)
  ) {
    throw new RelayDomainError("invalid-session")
  }
  return current
}
