import type { RelayFailureReason } from "../shared/domain"
import { RelayDomainError } from "../shared/errors"
import { normalizeRelayText } from "./transcript-identity"

const QUICK_CHAT_EXCLUSIONS =
  '[data-pip-obstacle="quick-chat"], [data-quick-chat-drag-handle], [role="dialog"]'
const MAIN_COMPOSER = "form[data-chatgpt-composer]"
const COMPOSER_TEXTBOX = '[role="textbox"][contenteditable="true"][data-composer-markdown]'
const TRANSCRIPT_UNIT = "[data-chatgpt-search-unit-key]"
const MESSAGE_IDS = "data-chatgpt-search-message-ids"
const SELECTION_MESSAGE_ID = "data-chatgpt-selection-message-id"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type TranscriptEntry = {
  readonly role: "user" | "assistant"
  readonly stableDomId: string | null
  readonly roleOrdinal: number
  readonly text: string
  readonly branchEvidence: string | null
}

export type DomInspection = {
  readonly ready: boolean
  readonly generating: boolean
  readonly conversationIdentity: string | null
  readonly composer: HTMLElement
  readonly transcript: TranscriptEntry[]
}

type MainThread = {
  readonly root: HTMLElement
  readonly composer: HTMLFormElement
  readonly textbox: HTMLElement
}

function failClosed(reason: RelayFailureReason): never {
  throw new RelayDomainError(reason)
}

function isExcludedFromMainThread(element: Element): boolean {
  return element.closest(QUICK_CHAT_EXCLUSIONS) !== null
}

function exactlyOne<T extends Element>(elements: readonly T[]): T {
  const element = elements[0]
  if (elements.length !== 1 || element === undefined) failClosed("dom-contract-ambiguous")
  return element
}

function resolveMainThread(document: Document): MainThread {
  const mainRoots = Array.from(document.querySelectorAll("main")).filter(
    (main) =>
      !isExcludedFromMainThread(main) &&
      Array.from(main.querySelectorAll(MAIN_COMPOSER)).some(
        (composer) => !isExcludedFromMainThread(composer),
      ),
  )
  const root = exactlyOne(mainRoots)
  const composer = exactlyOne(
    Array.from(root.querySelectorAll(MAIN_COMPOSER)).filter(
      (candidate) => !isExcludedFromMainThread(candidate),
    ),
  )
  const textbox = exactlyOne(
    Array.from(composer.querySelectorAll(COMPOSER_TEXTBOX)).filter(
      (candidate) => !isExcludedFromMainThread(candidate),
    ),
  )
  if (!(composer instanceof HTMLFormElement) || !(textbox instanceof HTMLElement)) {
    failClosed("dom-contract-ambiguous")
  }
  return { root, composer, textbox }
}

function readConversationIdentity(document: Document, transcriptLength: number): string | null {
  const pathname = document.location.pathname
  if (pathname === "/" && transcriptLength === 0) return null
  if (pathname === "/" || pathname === "") failClosed("dom-contract-ambiguous")

  const match = /^\/c\/([^/]+)\/?$/.exec(pathname)
  const conversationIdentity = match?.[1]
  if (conversationIdentity === undefined || conversationIdentity.length === 0) {
    failClosed("dom-contract-ambiguous")
  }
  return conversationIdentity
}

function readStableMessageId(unit: Element, role: TranscriptEntry["role"]): string {
  const rawIds = unit.getAttribute(MESSAGE_IDS)
  if (rawIds === null || rawIds.trim().length === 0) failClosed("message-identity-ambiguous")
  const tokens = rawIds.trim().split(/\s+/)
  const normalizedIds = new Set<string>()
  for (const token of tokens) {
    if (!UUID.test(token)) failClosed("message-identity-ambiguous")
    normalizedIds.add(token.toLowerCase())
  }

  if ((role === "user" && tokens.length !== 1) || normalizedIds.size !== 1) {
    failClosed("message-identity-ambiguous")
  }
  const stableId = normalizedIds.values().next().value
  if (stableId === undefined) failClosed("message-identity-ambiguous")

  const selectionMessageId = unit.getAttribute(SELECTION_MESSAGE_ID)
  if (selectionMessageId !== null) {
    if (!UUID.test(selectionMessageId) || selectionMessageId.toLowerCase() !== stableId) {
      failClosed("message-identity-ambiguous")
    }
  }
  return stableId
}

function readRole(unit: Element): TranscriptEntry["role"] {
  const key = unit.getAttribute("data-chatgpt-search-unit-key")
  const role = key?.split(":").at(-1)
  if (role === "user") {
    if (unit.querySelectorAll("[data-user-message-bubble]").length !== 1) {
      failClosed("dom-contract-ambiguous")
    }
    return role
  }
  if (role === "assistant") {
    if (unit.querySelectorAll('h4[data-conversation-role="assistant"]').length !== 1) {
      failClosed("dom-contract-ambiguous")
    }
    return role
  }
  failClosed("dom-contract-ambiguous")
}

function readBranchEvidence(unit: Element): string | null {
  const evidence: string[] = []
  if (unit.querySelectorAll('button[aria-label="メッセージを編集"]').length > 0) {
    evidence.push("edit")
  }
  if (unit.querySelectorAll('button[aria-label="回答を再生成"]').length > 0) {
    evidence.push("regenerate")
  }
  return evidence.length === 0 ? null : evidence.join(",")
}

function readTranscriptIn(root: HTMLElement): TranscriptEntry[] {
  const units = Array.from(root.querySelectorAll(TRANSCRIPT_UNIT)).filter(
    (unit) => !isExcludedFromMainThread(unit),
  )
  const roleOrdinals: Record<TranscriptEntry["role"], number> = { user: 0, assistant: 0 }
  const seenMessageIds = new Set<string>()
  return units.map((unit) => {
    const role = readRole(unit)
    const stableDomId = readStableMessageId(unit, role)
    if (seenMessageIds.has(stableDomId)) failClosed("message-identity-ambiguous")
    seenMessageIds.add(stableDomId)
    roleOrdinals[role] += 1
    return {
      role,
      stableDomId,
      roleOrdinal: roleOrdinals[role],
      text: normalizeRelayText(unit.textContent ?? ""),
      branchEvidence: readBranchEvidence(unit),
    }
  })
}

export function readTranscript(document: Document): TranscriptEntry[] {
  const { root } = resolveMainThread(document)
  return readTranscriptIn(root)
}

export function findSubmitControl(document: Document): HTMLElement {
  const { composer } = resolveMainThread(document)
  const submitControl = exactlyOne(
    Array.from(composer.querySelectorAll('button[type="submit"], input[type="submit"]')),
  )
  if (!(submitControl instanceof HTMLElement)) failClosed("dom-contract-ambiguous")
  return submitControl
}

export function inspectChatGptDom(document: Document): DomInspection {
  const { root, composer, textbox } = resolveMainThread(document)
  const transcript = readTranscriptIn(root)
  const conversationIdentity = readConversationIdentity(document, transcript.length)
  const stopControls = Array.from(composer.querySelectorAll('button[aria-label="停止"]'))
  if (stopControls.length > 1) failClosed("dom-contract-ambiguous")

  return {
    ready: true,
    generating: stopControls.length === 1,
    conversationIdentity,
    composer: textbox,
    transcript,
  }
}
