import type { RelayFailureReason, CancelSubmissionResult } from "../shared/domain"
import { RelayDomainError } from "../shared/errors"
import { parseRelayMessage } from "../shared/protocol"
import type {
  AdapterCommandFailure,
  AdapterInspectRequest,
  AdapterInspectResult,
  ArmResponseMessage,
  ArmResponseResult,
  BindExpectedUserTurnMessage,
  BindExpectedUserTurnResult,
  CancelTransferMessage,
  CancelTransferResult,
  CommitTransferMessage,
  PreparePeerResponseMessage,
  RelayMessage,
  TransferCommittedMessage,
  TransferPreparedMessage,
} from "../shared/protocol"
import { ChatGPTAdapter } from "./chatgpt-adapter"
import type { AdapterEvent } from "./chatgpt-adapter"
import type { RuntimeHandle } from "../background/service-worker"

export type ContentChromeApi = {
  readonly runtime: {
    readonly onMessage: typeof chrome.runtime.onMessage
    readonly sendMessage: typeof chrome.runtime.sendMessage
  }
}

export type ContentRuntimeDeps = {
  readonly chromeApi: ContentChromeApi
  readonly adapter: ChatGPTAdapter
}

type ContentAdapterRequest =
  | AdapterInspectRequest
  | ArmResponseMessage
  | PreparePeerResponseMessage
  | CommitTransferMessage
  | BindExpectedUserTurnMessage
  | CancelTransferMessage

function validatedMessage<T extends RelayMessage>(message: T): T {
  if (parseRelayMessage(message) === null) throw new TypeError("Invalid outgoing extension message")
  return message
}

function isContentAdapterRequest(message: RelayMessage): message is ContentAdapterRequest {
  switch (message.type) {
    case "adapter-inspect":
    case "arm-response":
    case "prepare-peer-response":
    case "commit-transfer":
    case "bind-expected-user-turn":
    case "cancel-transfer":
      return true
    default:
      return false
  }
}

function adapterFailure(request: ContentAdapterRequest, reason: RelayFailureReason): AdapterCommandFailure {
  switch (request.type) {
    case "adapter-inspect":
      return { type: "adapter-command-failure", command: request.type, reason }
    case "arm-response":
      return {
        type: "adapter-command-failure",
        command: request.type,
        sessionId: request.expected.sessionId,
        waitId: request.expected.waitId,
        reason,
      }
    case "prepare-peer-response":
    case "commit-transfer":
      return {
        type: "adapter-command-failure",
        command: request.type,
        sessionId: request.sessionId,
        transferId: request.transferId,
        waitId: request.waitId,
        reason,
      }
    case "bind-expected-user-turn":
      return {
        type: "adapter-command-failure",
        command: request.type,
        sessionId: request.sessionId,
        waitId: request.waitId,
        reason,
      }
    case "cancel-transfer":
      return {
        type: "adapter-command-failure",
        command: request.type,
        sessionId: request.sessionId,
        transferId: request.transferId,
        reason,
      }
    default:
      return contentRequestNever(request)
  }
}

function contentRequestNever(request: never): never {
  throw new TypeError(`Unsupported content adapter request: ${String(request)}`)
}

async function dispatchAdapterCommand(
  adapter: ChatGPTAdapter,
  request: ContentAdapterRequest,
): Promise<RelayMessage> {
  switch (request.type) {
    case "adapter-inspect": {
      const snapshot = await adapter.inspect()
      const response: AdapterInspectResult = { type: "adapter-inspect-result", snapshot }
      return validatedMessage(response)
    }
    case "arm-response": {
      await adapter.armExpectedResponse(request.expected)
      const response: ArmResponseResult = {
        type: "arm-response-result",
        ok: true,
        sessionId: request.expected.sessionId,
        waitId: request.expected.waitId,
      }
      return validatedMessage(response)
    }
    case "prepare-peer-response": {
      const prepared = await adapter.prepareSubmission({
        sessionId: request.sessionId,
        transferId: request.transferId,
        waitId: request.waitId,
        text: request.text,
      })
      const response: TransferPreparedMessage = {
        type: "transfer-prepared",
        sessionId: request.sessionId,
        ...prepared,
      }
      return validatedMessage(response)
    }
    case "commit-transfer": {
      const committed = await adapter.commitSubmission({
        sessionId: request.sessionId,
        transferId: request.transferId,
        waitId: request.waitId,
        authorizationRevision: request.authorizationRevision,
        authorizedConversationIdentity: request.authorizedConversationIdentity,
      })
      const response: TransferCommittedMessage = {
        type: "transfer-committed",
        sessionId: request.sessionId,
        ...committed,
      }
      return validatedMessage(response)
    }
    case "bind-expected-user-turn": {
      await adapter.bindExpectedUserTurn({
        sessionId: request.sessionId,
        waitId: request.waitId,
        userMessageId: request.userMessageId,
        conversationIdentity: request.conversationIdentity,
        authorizationRevision: request.authorizationRevision,
      })
      const response: BindExpectedUserTurnResult = {
        type: "bind-expected-user-turn-result",
        ok: true,
        sessionId: request.sessionId,
        waitId: request.waitId,
      }
      return validatedMessage(response)
    }
    case "cancel-transfer": {
      const result: CancelSubmissionResult = await adapter.cancelSubmission({
        sessionId: request.sessionId,
        transferId: request.transferId,
      })
      const response: CancelTransferResult = {
        type: "cancel-transfer-result",
        sessionId: request.sessionId,
        result,
      }
      return validatedMessage(response)
    }
    default:
      return contentRequestNever(request)
  }
}

export function createContentRuntime(deps: ContentRuntimeDeps): RuntimeHandle {
  const onMessage = (
    rawMessage: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ): boolean => {
    const message = parseRelayMessage(rawMessage)
    if (message === null || !isContentAdapterRequest(message)) return false
    const work = dispatchAdapterCommand(deps.adapter, message).catch((error: unknown) => {
      const reason = error instanceof RelayDomainError ? error.reason : "adapter-command-failed"
      return validatedMessage(adapterFailure(message, reason))
    })
    void work.then((response) => sendResponse(response))
    return true
  }

  deps.chromeApi.runtime.onMessage.addListener(onMessage)
  const stopObserving = deps.adapter.startObserving((event: AdapterEvent) => {
    const message = validatedMessage(event)
    void deps.chromeApi.runtime.sendMessage(message)
  })
  const ready = deps.chromeApi.runtime.sendMessage(
    validatedMessage({ type: "adapter-ready" }),
  ).then(() => undefined)

  return {
    ready,
    dispose() {
      deps.chromeApi.runtime.onMessage.removeListener(onMessage)
      stopObserving()
    },
  }
}

if (typeof chrome !== "undefined" && typeof document !== "undefined") {
  const adapter = new ChatGPTAdapter(document)
  createContentRuntime({
    chromeApi: {
      runtime: {
        onMessage: chrome.runtime.onMessage,
        sendMessage: chrome.runtime.sendMessage,
      },
    },
    adapter,
  })
}
