import type { RelayFailureReason } from "./domain"

export class RelayDomainError extends Error {
  readonly reason: RelayFailureReason

  constructor(reason: RelayFailureReason, message?: string) {
    super(message ?? reason)
    this.name = "RelayDomainError"
    this.reason = reason
  }
}

export type RelayTransportFailure = {
  readonly command: AdapterCommandName
  readonly tabId: number
  readonly sessionId?: string
  readonly transferId?: string
  readonly waitId?: string
  readonly reason: RelayFailureReason
}

export type AdapterCommandName =
  | "adapter-inspect"
  | "arm-response"
  | "prepare-peer-response"
  | "commit-transfer"
  | "bind-expected-user-turn"
  | "cancel-transfer"

export class RelayTransportError extends Error {
  readonly failure: RelayTransportFailure

  constructor(failure: RelayTransportFailure, message?: string) {
    super(message ?? `${failure.command} failed: ${failure.reason}`)
    this.name = "RelayTransportError"
    this.failure = failure
  }
}
