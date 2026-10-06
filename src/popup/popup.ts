import type { RelayFailureReason, RelayState, RelayStatusSnapshot } from "../shared/domain"
import { parseRelayMessage } from "../shared/protocol"
import type {
  RelayMessage,
  RelayPreferencesGet,
  RelayPreferencesSet,
  RelayStartRequest,
  RelayStatusRequest,
  RelayStopRequest,
} from "../shared/protocol"

const RUNTIME_ERROR_MESSAGE = "Extension runtime error; refresh status/retry"

const FAILURE_MESSAGES: Record<RelayFailureReason, string> = {
  "pair-invalid": "Open exactly two ChatGPT tabs in the same Split View, then retry.",
  "adapter-not-ready": "A ChatGPT tab is not ready. Reload the tab and retry.",
  "adapter-command-failed": "A ChatGPT tab could not complete a relay command. Refresh status and retry.",
  "adapter-transport-failed": "The extension could not verify a ChatGPT tab response. Refresh status and retry.",
  "generation-in-progress": "Wait for the active ChatGPT response to finish before starting or sending.",
  "dom-contract-ambiguous": "The ChatGPT page layout could not be identified safely. Reload the page and retry.",
  "conversation-changed": "A paired ChatGPT tab changed conversations. Stop and start a new relay.",
  "relay-causality-ambiguous": "The relay could not prove which user turn caused this response. The relay stopped safely.",
  "message-identity-ambiguous": "The relay could not identify a transcript message safely. The relay stopped.",
  "transcript-interference": "A transcript edit or regeneration changed the expected conversation. The relay stopped.",
  "unexpected-user-input": "Unexpected text or a manual turn was found. The relay left it unchanged and stopped.",
  "submission-failed": "The relay could not submit safely. Check the target tab before retrying.",
  "split-view-changed": "The paired tabs are no longer in the same Split View. Start a new relay.",
  "tab-closed": "A paired ChatGPT tab was closed. Start a new relay with two tabs.",
  "invalid-navigation": "A paired tab navigated away from ChatGPT. Start a new relay.",
  "invalid-session": "This relay session is no longer active. Refresh status before retrying.",
  "recovery-ambiguous": "The relay could not safely restore its previous state. Start a new relay.",
  "max-turns-reached": "The maximum number of relay turns was reached.",
  "stopped-by-user": "The relay was stopped.",
}

export type PopupRuntime = {
  sendMessage(message: RelayMessage): Promise<unknown>
}

type PopupHandle = {
  readonly ready: Promise<void>
  settled(): Promise<void>
  dispose(): void
}

function requireElement(document: Document, id: string): HTMLElement {
  const found = document.getElementById(id)
  if (!(found instanceof HTMLElement)) throw new TypeError(`Popup is missing ${id}`)
  return found
}

function requireButton(document: Document, id: string): HTMLButtonElement {
  const found = document.getElementById(id)
  if (!(found instanceof HTMLButtonElement)) throw new TypeError(`Popup is missing button ${id}`)
  return found
}

function requireInput(document: Document, id: string): HTMLInputElement {
  const found = document.getElementById(id)
  if (!(found instanceof HTMLInputElement)) throw new TypeError(`Popup is missing input ${id}`)
  return found
}

function stateText(state: RelayState | null, pairValid: boolean): string {
  if (state === null) return pairValid ? "Ready to start a relay." : "A valid ChatGPT Split View pair is required."
  switch (state) {
    case "idle":
      return "Ready to start a relay."
    case "waiting-a":
      return "Waiting for ChatGPT tab A."
    case "dispatching-b":
      return "Sending the response to ChatGPT tab B."
    case "waiting-b":
      return "Waiting for ChatGPT tab B."
    case "dispatching-a":
      return "Sending the response to ChatGPT tab A."
    case "stopping":
      return "Stopping and reconciling the current transfer…"
    case "stopped":
      return "Relay stopped."
    case "error":
      return "Relay stopped because it could not continue safely."
    default:
      return assertNever(state)
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Unsupported relay state: ${String(value)}`)
}

function readStatusResponse(response: unknown): RelayStatusSnapshot {
  const parsed = parseRelayMessage(response)
  if (parsed?.type !== "relay-status-result") throw new TypeError("Invalid relay status response")
  return parsed.status
}

function readPreferencesResponse(response: unknown): number {
  const parsed = parseRelayMessage(response)
  if (parsed?.type !== "relay-preferences-result") {
    throw new TypeError("Invalid relay preferences response")
  }
  return parsed.maxTurns
}

export function initializePopup(document: Document, runtime: PopupRuntime): PopupHandle {
  const statusElement = requireElement(document, "status")
  const errorElement = requireElement(document, "error")
  const preferenceStatus = requireElement(document, "preference-status")
  const turnsInput = requireInput(document, "max-turns")
  const startButton = requireButton(document, "start")
  const stopButton = requireButton(document, "stop")
  const preferencesForm = document.getElementById("preferences-form")
  if (!(preferencesForm instanceof HTMLFormElement)) throw new TypeError("Popup is missing preferences form")

  let currentStatus: RelayStatusSnapshot | null = null
  let disposed = false
  let pendingAction: Promise<void> = Promise.resolve()

  const clearError = () => {
    errorElement.hidden = true
    errorElement.textContent = ""
    delete errorElement.dataset["reason"]
    delete errorElement.dataset["runtimeError"]
  }

  const showFailure = (reason: RelayFailureReason) => {
    errorElement.hidden = false
    errorElement.dataset["reason"] = reason
    delete errorElement.dataset["runtimeError"]
    errorElement.textContent = FAILURE_MESSAGES[reason]
  }

  const showPreferenceError = () => {
    errorElement.hidden = false
    errorElement.dataset["reason"] = "invalid-max-turns"
    delete errorElement.dataset["runtimeError"]
    errorElement.textContent = "Enter a positive whole number for maximum turns."
  }

  const showRuntimeError = () => {
    errorElement.hidden = false
    errorElement.dataset["runtimeError"] = "true"
    delete errorElement.dataset["reason"]
    errorElement.textContent = RUNTIME_ERROR_MESSAGE
  }

  const renderStatus = (
    snapshot: RelayStatusSnapshot,
    options: { readonly preserveError?: boolean; readonly stopAccepted?: boolean } = {},
  ) => {
    currentStatus = snapshot
    const relay = snapshot.session
    const state = relay?.state ?? (snapshot.pair.valid ? "idle" : "pair-invalid")
    statusElement.dataset["state"] = state
    if (options.stopAccepted === true) statusElement.dataset["stopAccepted"] = "true"
    else delete statusElement.dataset["stopAccepted"]
    statusElement.textContent = stateText(relay?.state ?? null, snapshot.pair.valid)

    const active = relay !== null &&
      relay.state !== "stopped" &&
      relay.state !== "error" &&
      relay.state !== "idle"
    startButton.disabled = !snapshot.pair.valid || active
    stopButton.disabled = relay === null || relay.state === "stopped" || relay.state === "error"

    if (relay?.state === "error" && relay.reason !== null) {
      showFailure(relay.reason)
    } else if (relay?.state === "stopped" && relay.reason !== null && relay.reason !== "stopped-by-user") {
      showFailure(relay.reason)
    } else if (options.preserveError !== true) {
      clearError()
    }
  }

  const requestStatus = async (): Promise<RelayStatusSnapshot> => {
    const request: RelayStatusRequest = { type: "relay-status" }
    return readStatusResponse(await runtime.sendMessage(request))
  }

  const refreshStatus = async (preserveError = false): Promise<RelayStatusSnapshot> => {
    const snapshot = await requestStatus()
    renderStatus(snapshot, { preserveError })
    return snapshot
  }

  const requestPreferences = async (): Promise<number> => {
    const request: RelayPreferencesGet = { type: "relay-preferences-get" }
    return readPreferencesResponse(await runtime.sendMessage(request))
  }

  const refreshAfterRuntimeError = async () => {
    showRuntimeError()
    if (disposed) return
    try {
      await refreshStatus(true)
    } catch {
      showRuntimeError()
    }
  }

  const runAction = (operation: () => Promise<void>) => {
    pendingAction = operation().catch(async () => {
      await refreshAfterRuntimeError()
    })
    return pendingAction
  }

  const start = async () => {
    clearError()
    const request: RelayStartRequest = { type: "relay-start" }
    const response = parseRelayMessage(await runtime.sendMessage(request))
    if (response?.type !== "relay-start-result") throw new TypeError("Invalid relay start response")
    renderStatus(response.status)
    if (!response.ok) showFailure(response.reason)
  }

  const stop = async () => {
    const sessionId = currentStatus?.session?.sessionId
    if (sessionId === undefined) return
    clearError()
    const request: RelayStopRequest = { type: "relay-stop", sessionId }
    const response = parseRelayMessage(await runtime.sendMessage(request))
    if (response?.type !== "relay-stop-result") throw new TypeError("Invalid relay stop response")
    renderStatus(response.status, { stopAccepted: response.ok })
    if (!response.ok) showFailure(response.reason)
  }

  const saveMaxTurns = async () => {
    const maxTurns = turnsInput.valueAsNumber
    if (!Number.isInteger(maxTurns) || maxTurns < 1) {
      showPreferenceError()
      return
    }
    clearError()
    const request: RelayPreferencesSet = { type: "relay-preferences-set", maxTurns }
    const response = parseRelayMessage(await runtime.sendMessage(request))
    if (response?.type !== "relay-preferences-set-result") {
      throw new TypeError("Invalid relay preferences update response")
    }
    turnsInput.value = String(response.maxTurns)
    if (response.ok) {
      preferenceStatus.textContent = "Maximum turns saved."
      preferenceStatus.dataset["saved"] = "true"
      clearError()
    } else {
      preferenceStatus.textContent = "Maximum turns were not changed."
      delete preferenceStatus.dataset["saved"]
      showPreferenceError()
    }
  }

  const onStart = () => { void runAction(start) }
  const onStop = () => { void runAction(stop) }
  const onSavePreferences = (event: Event) => {
    event.preventDefault()
    void runAction(saveMaxTurns)
  }
  startButton.addEventListener("click", onStart)
  stopButton.addEventListener("click", onStop)
  preferencesForm.addEventListener("submit", onSavePreferences)

  const ready = Promise.all([refreshStatus(), requestPreferences()]).then(([, maxTurns]) => {
    turnsInput.value = String(maxTurns)
  }).catch(async () => {
    await refreshAfterRuntimeError()
  })

  return {
    ready,
    settled: () => pendingAction,
    dispose() {
      disposed = true
      startButton.removeEventListener("click", onStart)
      stopButton.removeEventListener("click", onStop)
      preferencesForm.removeEventListener("submit", onSavePreferences)
    },
  }
}

if (typeof chrome !== "undefined" && typeof document !== "undefined") {
  initializePopup(document, {
    sendMessage: (message) => chrome.runtime.sendMessage(message),
  })
}
