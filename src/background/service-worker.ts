import type {
  RelayFailureReason,
  RelaySession,
  RelayStatusSnapshot,
} from "../shared/domain"
import { RelayDomainError, RelayTransportError } from "../shared/errors"
import type { RelayTransportFailure } from "../shared/errors"
import { RelayController } from "./relay-controller"
import type { RelayTabsPort, RelayTransport } from "./relay-controller"
import { createChromePreferencesStore, createChromeSessionStore } from "./session-store"
import { TransitionQueue } from "./transition-queue"
import { parseRelayMessage } from "../shared/protocol"
import type {
  AdapterCommandFailure,
  AdapterInspectRequest,
  AdapterInspectResult,
  ArmResponseMessage,
  AssistantCompleteMessage,
  BindExpectedUserTurnMessage,
  CancelTransferMessage,
  CancelTransferResult,
  CommitTransferMessage,
  InitialUserTurnObservedMessage,
  PreparePeerResponseMessage,
  RelayMessage,
  RelayPreferencesResult,
  RelayPreferencesSet,
  RelayPreferencesSetResult,
  RelayStartResult,
  RelayStatusResult,
  RelayStopRequest,
  RelayStopResult,
  TranscriptInterferenceMessage,
  TransferCommittedMessage,
  TransferPreparedMessage,
} from "../shared/protocol"

export type ServiceWorkerChromeApi = {
  readonly runtime: { readonly onMessage: typeof chrome.runtime.onMessage }
  readonly tabs: {
    readonly query: typeof chrome.tabs.query
    readonly sendMessage: typeof chrome.tabs.sendMessage
    readonly onRemoved: typeof chrome.tabs.onRemoved
    readonly onUpdated: typeof chrome.tabs.onUpdated
  }
}

export interface RelayRuntimeControllerPort {
  getStatus(): Promise<RelayStatusSnapshot>
  getMaxTurns(): Promise<number>
  setMaxTurns(maxTurns: number): Promise<number>
  start(): Promise<RelaySession>
  stop(sessionId: string): Promise<RelaySession>
  recoverTab(tabId: number): Promise<RelaySession | null>
  recoverActiveSession(): Promise<RelaySession | null>
  handleInitialUserTurnObserved(tabId: number, event: InitialUserTurnObservedMessage): Promise<void>
  handleAssistantComplete(tabId: number, event: AssistantCompleteMessage): Promise<void>
  handleTranscriptInterference(tabId: number, event: TranscriptInterferenceMessage): Promise<void>
  handleTabRemoved(tabId: number): Promise<void>
  handleTabUpdated(tabId: number, changeInfo: { url?: string; splitViewId?: number }): Promise<void>
}

export type ServiceWorkerRuntimeDeps = {
  readonly chromeApi: ServiceWorkerChromeApi
  readonly controller: RelayRuntimeControllerPort
}

type TabUpdatedChangeInfo = Parameters<Parameters<typeof chrome.tabs.onUpdated.addListener>[0]>[1]

export type RuntimeHandle = {
  readonly ready: Promise<void>
  dispose(): void
}

type AdapterRequest =
  | AdapterInspectRequest
  | ArmResponseMessage
  | PreparePeerResponseMessage
  | CommitTransferMessage
  | BindExpectedUserTurnMessage
  | CancelTransferMessage

function failureFor(
  tabId: number,
  request: AdapterRequest,
  reason: RelayFailureReason,
): RelayTransportError {
  let failure: RelayTransportFailure
  switch (request.type) {
    case "adapter-inspect":
      failure = { command: "adapter-inspect", tabId, reason }
      break
    case "arm-response":
      failure = {
        command: "arm-response",
        tabId,
        sessionId: request.expected.sessionId,
        waitId: request.expected.waitId,
        reason,
      }
      break
    case "prepare-peer-response":
    case "commit-transfer":
      failure = {
        command: request.type,
        tabId,
        sessionId: request.sessionId,
        transferId: request.transferId,
        waitId: request.waitId,
        reason,
      }
      break
    case "bind-expected-user-turn":
      failure = {
        command: request.type,
        tabId,
        sessionId: request.sessionId,
        waitId: request.waitId,
        reason,
      }
      break
    case "cancel-transfer":
      failure = {
        command: request.type,
        tabId,
        sessionId: request.sessionId,
        transferId: request.transferId,
        reason,
      }
      break
    default:
      return assertAdapterRequestNever(request)
  }
  return new RelayTransportError(failure)
}

function assertAdapterRequestNever(request: never): never {
  throw new TypeError(`Unsupported adapter transport request: ${String(request)}`)
}

function failureCorrelationMatches(
  failure: AdapterCommandFailure,
  request: AdapterRequest,
): boolean {
  switch (request.type) {
    case "adapter-inspect":
      return failure.command === "adapter-inspect"
    case "arm-response":
      return (
        failure.command === "arm-response" &&
        failure.sessionId === request.expected.sessionId &&
        failure.waitId === request.expected.waitId
      )
    case "prepare-peer-response":
    case "commit-transfer":
      return (
        failure.command === request.type &&
        failure.sessionId === request.sessionId &&
        failure.transferId === request.transferId &&
        failure.waitId === request.waitId
      )
    case "bind-expected-user-turn":
      return (
        failure.command === request.type &&
        failure.sessionId === request.sessionId &&
        failure.waitId === request.waitId
      )
    case "cancel-transfer":
      return (
        failure.command === request.type &&
        failure.sessionId === request.sessionId &&
        failure.transferId === request.transferId
      )
    default:
      return false
  }
}

function successCorrelationMatches(request: AdapterRequest, response: RelayMessage): boolean {
  switch (request.type) {
    case "adapter-inspect":
      return response.type === "adapter-inspect-result"
    case "arm-response":
      return (
        response.type === "arm-response-result" &&
        response.sessionId === request.expected.sessionId &&
        response.waitId === request.expected.waitId
      )
    case "prepare-peer-response":
      return (
        response.type === "transfer-prepared" &&
        response.sessionId === request.sessionId &&
        response.transferId === request.transferId &&
        response.waitId === request.waitId
      )
    case "commit-transfer":
      return (
        response.type === "transfer-committed" &&
        response.sessionId === request.sessionId &&
        response.transferId === request.transferId &&
        response.waitId === request.waitId
      )
    case "bind-expected-user-turn":
      return (
        response.type === "bind-expected-user-turn-result" &&
        response.sessionId === request.sessionId &&
        response.waitId === request.waitId
      )
    case "cancel-transfer":
      return (
        response.type === "cancel-transfer-result" &&
        response.sessionId === request.sessionId &&
        response.result.transferId === request.transferId
      )
    default:
      return false
  }
}

function createChromeRelayTransport(
  tabs: Pick<ServiceWorkerChromeApi["tabs"], "sendMessage">,
): RelayTransport {
  async function send(tabId: number, request: AdapterRequest): Promise<RelayMessage> {
    let rawResponse: unknown
    try {
      rawResponse = await tabs.sendMessage(tabId, request)
    } catch {
      throw failureFor(tabId, request, "adapter-not-ready")
    }

    const response = parseRelayMessage(rawResponse)
    if (response === null) throw failureFor(tabId, request, "adapter-transport-failed")
    if (response.type === "adapter-command-failure") {
      if (!failureCorrelationMatches(response, request)) {
        throw failureFor(tabId, request, "adapter-transport-failed")
      }
      throw failureFor(tabId, request, response.reason)
    }
    if (!successCorrelationMatches(request, response)) {
      throw failureFor(tabId, request, "adapter-transport-failed")
    }
    return response
  }

  return {
    async inspect(tabId, message) {
      const response = await send(tabId, message)
      if (response.type !== "adapter-inspect-result") {
        throw failureFor(tabId, message, "adapter-transport-failed")
      }
      return response
    },
    async armResponse(tabId, message) {
      const response = await send(tabId, message)
      if (response.type !== "arm-response-result") {
        throw failureFor(tabId, message, "adapter-transport-failed")
      }
      return response
    },
    async prepareSubmission(tabId, message) {
      const response = await send(tabId, message)
      if (response.type !== "transfer-prepared") {
        throw failureFor(tabId, message, "adapter-transport-failed")
      }
      return response
    },
    async commitSubmission(tabId, message) {
      const response = await send(tabId, message)
      if (response.type !== "transfer-committed") {
        throw failureFor(tabId, message, "adapter-transport-failed")
      }
      return response
    },
    async bindExpectedUserTurn(tabId, message) {
      const response = await send(tabId, message)
      if (response.type !== "bind-expected-user-turn-result") {
        throw failureFor(tabId, message, "adapter-transport-failed")
      }
      return response
    },
    async cancelSubmission(tabId, message) {
      const response = await send(tabId, message)
      if (response.type !== "cancel-transfer-result") {
        throw failureFor(tabId, message, "adapter-transport-failed")
      }
      return response
    },
  }
}

export { createChromeRelayTransport }

export function createChromeTabsPort(tabs: ServiceWorkerChromeApi["tabs"]): RelayTabsPort {
  return {
    async queryCurrentWindow() {
      const results = await tabs.query({ currentWindow: true })
      return results.flatMap((tab) => {
        if (tab.id === undefined || tab.windowId === undefined) return []
        return [{
          id: tab.id,
          windowId: tab.windowId,
          active: tab.active,
          ...(tab.url === undefined ? {} : { url: tab.url }),
          ...(tab.splitViewId === undefined ? {} : { splitViewId: tab.splitViewId }),
        }]
      })
    },
  }
}

function validatedMessage<T extends RelayMessage>(message: T): T {
  const parsed = parseRelayMessage(message)
  if (parsed === null) throw new TypeError("Invalid outgoing extension message")
  return message
}

async function routeServiceWorkerMessage(
  message: RelayMessage,
  sender: chrome.runtime.MessageSender,
  ready: Promise<void>,
  controller: RelayRuntimeControllerPort,
): Promise<RelayMessage | undefined> {
  await ready
  switch (message.type) {
    case "adapter-ready": {
      const tabId = sender.tab?.id
      if (tabId === undefined) throw new TypeError("adapter-ready is missing Chrome sender tab metadata")
      await controller.recoverTab(tabId)
      return undefined
    }
    case "initial-user-turn-observed":
    case "assistant-complete":
    case "transcript-interference": {
      const tabId = sender.tab?.id
      if (tabId === undefined) throw new TypeError("adapter event is missing Chrome sender tab metadata")
      if (message.type === "initial-user-turn-observed") {
        await controller.handleInitialUserTurnObserved(tabId, message)
      } else if (message.type === "assistant-complete") {
        await controller.handleAssistantComplete(tabId, message)
      } else {
        await controller.handleTranscriptInterference(tabId, message)
      }
      return undefined
    }
    case "relay-status": {
      const response: RelayStatusResult = {
        type: "relay-status-result",
        status: await controller.getStatus(),
      }
      return validatedMessage(response)
    }
    case "relay-start":
      return routeStart(controller)
    case "relay-stop":
      return routeStop(controller, message)
    case "relay-preferences-get": {
      const response: RelayPreferencesResult = {
        type: "relay-preferences-result",
        maxTurns: await controller.getMaxTurns(),
      }
      return validatedMessage(response)
    }
    case "relay-preferences-set":
      return routePreferencesSet(controller, message)
    default:
      return undefined
  }
}

async function routeStart(controller: RelayRuntimeControllerPort): Promise<RelayStartResult> {
  try {
    await controller.start()
    const response: RelayStartResult = {
      type: "relay-start-result",
      ok: true,
      status: await controller.getStatus(),
    }
    return validatedMessage(response)
  } catch (error) {
    if (!(error instanceof RelayDomainError)) throw error
    const response: RelayStartResult = {
      type: "relay-start-result",
      ok: false,
      reason: error.reason,
      status: await controller.getStatus(),
    }
    return validatedMessage(response)
  }
}

async function routeStop(
  controller: RelayRuntimeControllerPort,
  request: RelayStopRequest,
): Promise<RelayStopResult> {
  try {
    await controller.stop(request.sessionId)
    const response: RelayStopResult = {
      type: "relay-stop-result",
      ok: true,
      status: await controller.getStatus(),
    }
    return validatedMessage(response)
  } catch (error) {
    if (!(error instanceof RelayDomainError)) throw error
    const response: RelayStopResult = {
      type: "relay-stop-result",
      ok: false,
      reason: error.reason,
      status: await controller.getStatus(),
    }
    return validatedMessage(response)
  }
}

async function routePreferencesSet(
  controller: RelayRuntimeControllerPort,
  request: RelayPreferencesSet,
): Promise<RelayPreferencesSetResult> {
  if (!Number.isInteger(request.maxTurns) || request.maxTurns < 1) {
    const response: RelayPreferencesSetResult = {
      type: "relay-preferences-set-result",
      ok: false,
      reason: "invalid-max-turns",
      maxTurns: await controller.getMaxTurns(),
    }
    return validatedMessage(response)
  }
  const response: RelayPreferencesSetResult = {
    type: "relay-preferences-set-result",
    ok: true,
    maxTurns: await controller.setMaxTurns(request.maxTurns),
  }
  return validatedMessage(response)
}

export function createServiceWorkerRuntime(deps: ServiceWorkerRuntimeDeps): RuntimeHandle {
  const ready = deps.controller.recoverActiveSession().then(() => undefined)
  const onMessage = (
    rawMessage: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ): boolean => {
    const message = parseRelayMessage(rawMessage)
    if (message === null) return false
    if (
      (message.type === "adapter-ready" ||
        message.type === "initial-user-turn-observed" ||
        message.type === "assistant-complete" ||
        message.type === "transcript-interference") &&
      sender.tab?.id === undefined
    ) {
      throw new TypeError("Adapter message is missing Chrome sender tab metadata")
    }
    const work = routeServiceWorkerMessage(message, sender, ready, deps.controller)
    void work.then((response) => sendResponse(response))
    return true
  }
  const onRemoved = async (tabId: number): Promise<void> => {
    await ready
    await deps.controller.handleTabRemoved(tabId)
  }
  const onUpdated = (
    tabId: number,
    changeInfo: TabUpdatedChangeInfo,
  ): Promise<void> => {
    const forwarded: { url?: string; splitViewId?: number } = {}
    if (changeInfo.url !== undefined) forwarded.url = changeInfo.url
    if (Object.prototype.hasOwnProperty.call(changeInfo, "splitViewId")) {
      Object.defineProperty(forwarded, "splitViewId", {
        value: changeInfo.splitViewId,
        enumerable: true,
      })
    }
    return ready.then(() => deps.controller.handleTabUpdated(tabId, forwarded))
  }

  deps.chromeApi.runtime.onMessage.addListener(onMessage)
  deps.chromeApi.tabs.onRemoved.addListener(onRemoved)
  deps.chromeApi.tabs.onUpdated.addListener(onUpdated)

  return {
    ready,
    dispose() {
      deps.chromeApi.runtime.onMessage.removeListener(onMessage)
      deps.chromeApi.tabs.onRemoved.removeListener(onRemoved)
      deps.chromeApi.tabs.onUpdated.removeListener(onUpdated)
    },
  }
}

if (typeof chrome !== "undefined") {
  const chromeApi: ServiceWorkerChromeApi = {
    runtime: { onMessage: chrome.runtime.onMessage },
    tabs: {
      query: chrome.tabs.query,
      sendMessage: chrome.tabs.sendMessage,
      onRemoved: chrome.tabs.onRemoved,
      onUpdated: chrome.tabs.onUpdated,
    },
  }
  const controller = new RelayController({
    sessions: createChromeSessionStore(),
    preferences: createChromePreferencesStore(),
    queue: new TransitionQueue(),
    tabs: createChromeTabsPort(chromeApi.tabs),
    transport: createChromeRelayTransport(chromeApi.tabs),
  })
  createServiceWorkerRuntime({ chromeApi, controller })
}
