import type {
  ExpectedResponse,
  PendingTransfer,
  RelayFailureReason,
  RelaySession,
  RelayStatusSnapshot,
  Side,
} from "../shared/domain"
import { RelayDomainError, RelayTransportError } from "../shared/errors"
import type {
  AdapterInspectRequest,
  AdapterInspectResult,
  ArmResponseMessage,
  ArmResponseResult,
  AssistantCompleteMessage,
  BindExpectedUserTurnMessage,
  BindExpectedUserTurnResult,
  CancelTransferMessage,
  CancelTransferResult,
  CommitTransferMessage,
  InitialUserTurnObservedMessage,
  PreparePeerResponseMessage,
  TransferCommittedMessage,
  TransferPreparedMessage,
} from "../shared/protocol"
import { initializeConversationBinding, reconcileConversationBinding } from "../content/transcript-identity"
import { assertCurrentSession } from "./session-store"
import type { RelayPreferencesStore, RelaySessionStore } from "./session-store"
import { discoverSplitPair, isPairStillValid } from "./split-view"
import type { SplitPair, TabSnapshot } from "./split-view"
import { TransitionQueue } from "./transition-queue"

export interface RelayTransport {
  inspect(tabId: number, message: AdapterInspectRequest): Promise<AdapterInspectResult>
  armResponse(tabId: number, message: ArmResponseMessage): Promise<ArmResponseResult>
  prepareSubmission(tabId: number, message: PreparePeerResponseMessage): Promise<TransferPreparedMessage>
  commitSubmission(tabId: number, message: CommitTransferMessage): Promise<TransferCommittedMessage>
  bindExpectedUserTurn(tabId: number, message: BindExpectedUserTurnMessage): Promise<BindExpectedUserTurnResult>
  cancelSubmission(tabId: number, message: CancelTransferMessage): Promise<CancelTransferResult>
}

export interface RelayTabsPort {
  queryCurrentWindow(): Promise<readonly TabSnapshot[]>
}

export type TransitionExpectation = {
  readonly sessionId: string
  readonly revision?: number
  readonly waitId?: string
  readonly transferId?: string
}

export type TransitionDecision<T> = {
  readonly nextSession: RelaySession
  readonly result: T
  readonly effect?: () => Promise<void>
}

type RelayControllerDeps = {
  readonly sessions: RelaySessionStore
  readonly preferences: RelayPreferencesStore
  readonly queue: TransitionQueue
  readonly tabs: RelayTabsPort
  readonly transport: RelayTransport
}

function isActiveState(session: RelaySession): boolean {
  return (
    session.state === "waiting-a" ||
    session.state === "dispatching-b" ||
    session.state === "waiting-b" ||
    session.state === "dispatching-a" ||
    session.state === "stopping"
  )
}

function terminalFailure(session: RelaySession, reason: RelayFailureReason): RelaySession {
  const { expectedResponse: _expectedResponse, pendingTransfer: _pendingTransfer, ...retained } = session
  return {
    ...retained,
    state: "error",
    stopReason: reason,
  }
}

function samePair(left: SplitPair, right: SplitPair): boolean {
  return (
    left.splitViewId === right.splitViewId &&
    left.tabA === right.tabA &&
    left.tabB === right.tabB
  )
}

function targetSide(sourceSide: Side): Side {
  return sourceSide === "a" ? "b" : "a"
}

function targetTab(session: RelaySession, side: Side): number {
  return side === "a" ? session.tabA : session.tabB
}

function targetBinding(session: RelaySession, side: Side): RelaySession["conversationA"] {
  return side === "a" ? session.conversationA : session.conversationB
}

function withBinding(
  session: RelaySession,
  side: Side,
  binding: RelaySession["conversationA"],
): RelaySession {
  return side === "a"
    ? { ...session, conversationA: binding }
    : { ...session, conversationB: binding }
}

function stoppedForMaxTurns(session: RelaySession): RelaySession {
  const { expectedResponse: _expectedResponse, pendingTransfer: _pendingTransfer, ...retained } = session
  return { ...retained, state: "stopped", stopReason: "max-turns-reached" }
}

export class RelayController {
  constructor(private readonly deps: RelayControllerDeps) {}

  async getStatus(): Promise<RelayStatusSnapshot> {
    let pair: RelayStatusSnapshot["pair"]
    try {
      const discovered = discoverSplitPair(await this.deps.tabs.queryCurrentWindow())
      pair = {
        valid: true,
        splitViewId: discovered.splitViewId,
        tabA: discovered.tabA,
        tabB: discovered.tabB,
      }
    } catch (error) {
      if (!(error instanceof RelayDomainError) || error.reason !== "pair-invalid") throw error
      pair = { valid: false, reason: "pair-invalid" }
    }

    const current = await this.deps.sessions.read()
    return {
      pair,
      session:
        current === null
          ? null
          : {
              sessionId: current.id,
              state: current.state,
              turn: current.turn,
              maxTurns: current.maxTurns,
              expectedSide: current.expectedResponse?.side ?? null,
              waitId: current.expectedResponse?.waitId ?? null,
              reason: current.stopReason ?? null,
            },
    }
  }

  getMaxTurns(): Promise<number> {
    return this.deps.preferences.readMaxTurns()
  }

  async setMaxTurns(maxTurns: number): Promise<number> {
    if (!Number.isInteger(maxTurns) || maxTurns < 1) {
      throw new TypeError("maxTurns must be a positive integer")
    }
    await this.deps.preferences.writeMaxTurns(maxTurns)
    return this.deps.preferences.readMaxTurns()
  }

  async start(): Promise<RelaySession> {
    const pair = discoverSplitPair(await this.deps.tabs.queryCurrentWindow())
    let inspectedA: AdapterInspectResult
    let inspectedB: AdapterInspectResult
    try {
      ;[inspectedA, inspectedB] = await Promise.all([
        this.deps.transport.inspect(pair.tabA, { type: "adapter-inspect" }),
        this.deps.transport.inspect(pair.tabB, { type: "adapter-inspect" }),
      ])
    } catch (error) {
      if (error instanceof RelayTransportError) throw new RelayDomainError(error.failure.reason)
      throw error
    }

    if (!inspectedA.snapshot.ready || !inspectedB.snapshot.ready) {
      throw new RelayDomainError("adapter-not-ready")
    }
    if (inspectedA.snapshot.generating) throw new RelayDomainError("generation-in-progress")

    const maxTurns = await this.deps.preferences.readMaxTurns()
    const verifiedTabs = await this.deps.tabs.queryCurrentWindow()
    if (!isPairStillValid(pair, verifiedTabs) || !samePair(pair, discoverSplitPair(verifiedTabs))) {
      throw new RelayDomainError("pair-invalid")
    }

    const sessionId = crypto.randomUUID()
    const expectedResponse = {
      sessionId,
      waitId: crypto.randomUUID(),
      side: "a" as const,
      tabId: pair.tabA,
      baselineMessageId: inspectedA.snapshot.latestAssistant?.messageId ?? null,
    }
    const session: RelaySession = {
      id: sessionId,
      revision: 1,
      splitViewId: pair.splitViewId,
      tabA: pair.tabA,
      tabB: pair.tabB,
      conversationA: initializeConversationBinding(inspectedA.snapshot.conversationIdentity),
      conversationB: initializeConversationBinding(inspectedB.snapshot.conversationIdentity),
      state: "waiting-a",
      turn: 0,
      maxTurns,
      expectedResponse,
    }

    await this.deps.queue.run(async () => {
      const current = await this.deps.sessions.read()
      if (current !== null && isActiveState(current)) throw new RelayDomainError("invalid-session")
      await this.deps.sessions.write(session)
    })

    try {
      await this.deps.transport.armResponse(pair.tabA, {
        type: "arm-response",
        expected: expectedResponse,
        authorizationRevision: session.revision,
      })
    } catch (error) {
      if (error instanceof RelayTransportError) {
        await this.withTransition(
          { sessionId, revision: session.revision, waitId: expectedResponse.waitId },
          (current) => ({
            nextSession: terminalFailure(current, error.failure.reason),
            result: undefined,
          }),
        )
        throw new RelayDomainError(error.failure.reason)
      }
      throw error
    }

    const armed = assertCurrentSession(await this.deps.sessions.read(), {
      sessionId,
      revision: session.revision,
      waitId: expectedResponse.waitId,
    })
    return armed
  }

  async handleInitialUserTurnObserved(
    tabId: number,
    event: InitialUserTurnObservedMessage,
  ): Promise<void> {
    const current = await this.deps.sessions.read()
    if (
      current === null ||
      current.id !== event.sessionId ||
      current.tabA !== tabId ||
      current.state !== "waiting-a" ||
      current.expectedResponse?.side !== "a" ||
      current.expectedResponse.waitId !== event.waitId
    ) {
      return
    }

    const expected = current.expectedResponse
    if (expected.causedByUserMessageId !== undefined) {
      if (expected.causedByUserMessageId === event.userMessageId) return
      await this.withTransition(
        { sessionId: current.id, revision: current.revision, waitId: expected.waitId },
        (latest) => ({
          nextSession: terminalFailure(latest, "unexpected-user-input"),
          result: undefined,
        }),
      )
      return
    }

    let conversationA: RelaySession["conversationA"]
    try {
      conversationA = reconcileConversationBinding(
        current.conversationA,
        event.conversationIdentity,
        "first-allowed-prompt",
      )
    } catch (error) {
      if (!(error instanceof RelayDomainError)) throw error
      await this.withTransition(
        { sessionId: current.id, revision: current.revision, waitId: expected.waitId },
        (latest) => ({
          nextSession: terminalFailure(latest, error.reason),
          result: undefined,
        }),
      )
      return
    }

    const authorizationRevision = current.revision + 1
    try {
      await this.withTransition(
        { sessionId: current.id, revision: current.revision, waitId: expected.waitId },
        (latest) => {
          const latestExpected = latest.expectedResponse
          if (latestExpected === undefined || latestExpected.waitId !== expected.waitId) {
            throw new RelayDomainError("invalid-session")
          }
          return {
            nextSession: {
              ...latest,
              conversationA,
              expectedResponse: {
                ...latestExpected,
                causedByUserMessageId: event.userMessageId,
              },
            },
            result: undefined,
            effect: async () => {
              await this.deps.transport.bindExpectedUserTurn(latest.tabA, {
                type: "bind-expected-user-turn",
                sessionId: latest.id,
                waitId: expected.waitId,
                userMessageId: event.userMessageId,
                conversationIdentity: event.conversationIdentity,
                authorizationRevision,
              })
            },
          }
        },
      )
    } catch (error) {
      if (!(error instanceof RelayTransportError)) throw error
      const latest = await this.deps.sessions.read()
      if (latest !== null && latest.id === current.id) {
        await this.withTransition(
          {
            sessionId: latest.id,
            revision: latest.revision,
            waitId: expected.waitId,
          },
          (session) => ({
            nextSession: terminalFailure(session, error.failure.reason),
            result: undefined,
          }),
        )
      }
      throw new RelayDomainError(error.failure.reason)
    }
  }

  async handleAssistantComplete(tabId: number, event: AssistantCompleteMessage): Promise<void> {
    const current = await this.deps.sessions.read()
    const expected = current?.expectedResponse
    if (
      current === null ||
      current.id !== event.sessionId ||
      (current.state !== "waiting-a" && current.state !== "waiting-b") ||
      targetTab(current, expected?.side ?? "a") !== tabId ||
      expected === undefined ||
      expected.waitId !== event.waitId ||
      expected.causedByUserMessageId === undefined
    ) {
      return
    }
    if (
      event.causedByUserMessageId !== expected.causedByUserMessageId ||
      event.causedByTransferId !== expected.causedByTransferId ||
      (expected.baselineMessageId !== null && event.message.messageId === expected.baselineMessageId)
    ) {
      await this.failSession(current.id, "relay-causality-ambiguous")
      return
    }
    const lastMessage = expected.side === "a" ? current.lastMessageA : current.lastMessageB
    if (lastMessage === event.message.messageId) return

    if (current.turn + 1 > current.maxTurns) {
      await this.withTransition(
        { sessionId: current.id, revision: current.revision, waitId: expected.waitId },
        (latest) => ({ nextSession: stoppedForMaxTurns(latest), result: undefined }),
      )
      return
    }

    let inspected: AdapterInspectResult
    try {
      inspected = await this.deps.transport.inspect(tabId, { type: "adapter-inspect" })
    } catch (error) {
      if (!(error instanceof RelayTransportError)) throw error
      await this.failSession(current.id, error.failure.reason)
      throw new RelayDomainError(error.failure.reason)
    }

    if (!inspected.snapshot.ready) {
      await this.failSession(current.id, "adapter-not-ready")
      return
    }
    if (inspected.snapshot.generating) {
      await this.failSession(current.id, "generation-in-progress")
      return
    }

    let sourceBinding: RelaySession["conversationA"]
    try {
      if (targetBinding(current, expected.side).state === "unbound") {
        throw new RelayDomainError("conversation-changed")
      }
      sourceBinding = reconcileConversationBinding(
        targetBinding(current, expected.side),
        inspected.snapshot.conversationIdentity,
        "revalidation",
      )
    } catch (error) {
      if (!(error instanceof RelayDomainError)) throw error
      await this.failSession(current.id, error.reason)
      return
    }

    const transferId = crypto.randomUUID()
    const peerWaitId = crypto.randomUUID()
    const destinationSide = targetSide(expected.side)
    const destinationTabId = targetTab(current, destinationSide)
    const pendingTransfer: PendingTransfer = {
      id: transferId,
      sourceTabId: tabId,
      targetTabId: destinationTabId,
      sourceMessageId: event.message.messageId,
      payloadHash: event.message.textHash,
      targetWaitId: peerWaitId,
      submissionState: "preparing",
    }
    const nextState = destinationSide === "b" ? "dispatching-b" : "dispatching-a"
    const sourceLastMessage = expected.side === "a"
      ? { lastMessageA: event.message.messageId }
      : { lastMessageB: event.message.messageId }
    try {
      await this.withTransition(
        {
          sessionId: current.id,
          revision: current.revision,
          waitId: expected.waitId,
        },
        (latest) => {
          const { expectedResponse: _expectedResponse, ...withoutExpected } = latest
          return {
            nextSession: {
              ...withBinding(withoutExpected, expected.side, sourceBinding),
              ...sourceLastMessage,
              state: nextState,
              pendingTransfer,
            },
            result: undefined,
            effect: async () => {
              const prepared = await this.deps.transport.prepareSubmission(destinationTabId, {
                type: "prepare-peer-response",
                sessionId: latest.id,
                transferId,
                waitId: peerWaitId,
                text: event.message.text,
                authorizationRevision: latest.revision + 1,
              })
              if (
                prepared.sessionId !== latest.id ||
                prepared.transferId !== transferId ||
                prepared.waitId !== peerWaitId
              ) {
                throw new RelayTransportError({
                  command: "prepare-peer-response",
                  tabId: destinationTabId,
                  sessionId: latest.id,
                  transferId,
                  waitId: peerWaitId,
                  reason: "adapter-transport-failed",
                })
              }
              await this.handleTransferPrepared(destinationTabId, prepared)
            },
          }
        },
      )
    } catch (error) {
      if (error instanceof RelayTransportError) {
        await this.failTransfer(current.id, transferId, error.failure.reason)
        throw new RelayDomainError(error.failure.reason)
      }
      if (error instanceof RelayDomainError && error.reason === "invalid-session") return
      throw error
    }
  }

  async handleTransferPrepared(tabId: number, event: TransferPreparedMessage): Promise<void> {
    const current = await this.deps.sessions.read()
    const pending = current?.pendingTransfer
    if (
      current === null ||
      current.id !== event.sessionId ||
      pending === undefined ||
      pending.id !== event.transferId ||
      pending.targetTabId !== tabId ||
      pending.targetWaitId !== event.waitId ||
      pending.submissionState !== "preparing" ||
      (current.state !== "dispatching-a" && current.state !== "dispatching-b")
    ) {
      return
    }

    const side = pending.targetTabId === current.tabA ? "a" : "b"
    let reconciledBinding: RelaySession["conversationA"]
    try {
      reconciledBinding = reconcileConversationBinding(
        targetBinding(current, side),
        event.conversationIdentity,
        "revalidation",
      )
    } catch (error) {
      if (!(error instanceof RelayDomainError)) throw error
      await this.failTransfer(current.id, pending.id, error.reason)
      return
    }

    const authorizationRevision = current.revision + 1
    const expectedResponse: ExpectedResponse = {
      sessionId: current.id,
      waitId: pending.targetWaitId,
      side,
      tabId: pending.targetTabId,
      baselineMessageId: event.baselineMessageId,
      causedByTransferId: pending.id,
    }
    try {
      await this.withTransition(
        {
          sessionId: current.id,
          revision: current.revision,
          transferId: pending.id,
        },
        (latest) => {
          const latestPending = latest.pendingTransfer
          if (
            latestPending === undefined ||
            latestPending.id !== pending.id ||
            latestPending.targetWaitId !== event.waitId
          ) {
            throw new RelayDomainError("invalid-session")
          }
          return {
            nextSession: {
              ...withBinding(latest, side, reconciledBinding),
              expectedResponse,
              pendingTransfer: {
                ...latestPending,
                targetBaselineMessageId: event.baselineMessageId,
                authorizationRevision,
                submissionState: "authorized",
              },
            },
            result: undefined,
            effect: async () => {
              await this.deps.transport.armResponse(pending.targetTabId, {
                type: "arm-response",
                expected: expectedResponse,
                authorizationRevision,
              })
              assertCurrentSession(await this.deps.sessions.read(), {
                sessionId: current.id,
                revision: authorizationRevision,
                waitId: pending.targetWaitId,
                transferId: pending.id,
              })
              const committed = await this.deps.transport.commitSubmission(pending.targetTabId, {
                type: "commit-transfer",
                sessionId: current.id,
                transferId: pending.id,
                waitId: pending.targetWaitId,
                authorizationRevision,
                authorizedConversationIdentity: event.conversationIdentity,
              })
              if (
                committed.sessionId !== current.id ||
                committed.transferId !== pending.id ||
                committed.waitId !== pending.targetWaitId
              ) {
                throw new RelayTransportError({
                  command: "commit-transfer",
                  tabId: pending.targetTabId,
                  sessionId: current.id,
                  transferId: pending.id,
                  waitId: pending.targetWaitId,
                  reason: "adapter-transport-failed",
                })
              }
              await this.handleTransferCommitted(pending.targetTabId, committed)
            },
          }
        },
      )
    } catch (error) {
      if (error instanceof RelayTransportError) {
        await this.failTransfer(current.id, pending.id, error.failure.reason)
        throw new RelayDomainError(error.failure.reason)
      }
      if (error instanceof RelayDomainError && error.reason === "invalid-session") return
      throw error
    }
  }

  async handleTransferCommitted(tabId: number, event: TransferCommittedMessage): Promise<void> {
    const current = await this.deps.sessions.read()
    const pending = current?.pendingTransfer
    const expected = current?.expectedResponse
    if (
      current === null ||
      current.id !== event.sessionId ||
      pending === undefined ||
      expected === undefined ||
      pending.id !== event.transferId ||
      pending.targetTabId !== tabId ||
      pending.targetWaitId !== event.waitId ||
      pending.submissionState !== "authorized" ||
      expected.waitId !== event.waitId ||
      expected.causedByTransferId !== event.transferId
    ) {
      return
    }
    if (
      event.userMessageId.length === 0 ||
      event.conversationIdentity.length === 0 ||
      event.userMessageId === pending.targetBaselineMessageId
    ) {
      await this.failTransfer(current.id, pending.id, "relay-causality-ambiguous")
      return
    }

    const side = expected.side
    let boundConversation: RelaySession["conversationA"]
    try {
      boundConversation = reconcileConversationBinding(
        targetBinding(current, side),
        event.conversationIdentity,
        "first-allowed-prompt",
      )
    } catch (error) {
      if (!(error instanceof RelayDomainError)) throw error
      await this.failTransfer(current.id, pending.id, error.reason)
      return
    }

    const nextState = side === "a" ? "waiting-a" : "waiting-b"
    const authorizationRevision = current.revision + 1
    try {
      await this.withTransition(
        {
          sessionId: current.id,
          revision: current.revision,
          transferId: pending.id,
          waitId: expected.waitId,
        },
        (latest) => {
          const latestPending = latest.pendingTransfer
          const latestExpected = latest.expectedResponse
          if (
            latestPending === undefined ||
            latestExpected === undefined ||
            latestPending.id !== pending.id ||
            latestExpected.waitId !== expected.waitId
          ) {
            throw new RelayDomainError("invalid-session")
          }
          return {
            nextSession: {
              ...withBinding(latest, side, boundConversation),
              state: nextState,
              turn: latest.turn + 1,
              expectedResponse: {
                ...latestExpected,
                causedByUserMessageId: event.userMessageId,
              },
              pendingTransfer: {
                ...latestPending,
                targetUserMessageId: event.userMessageId,
                submissionState: "committed",
              },
            },
            result: undefined,
            effect: async () => {
              await this.deps.transport.bindExpectedUserTurn(tabId, {
                type: "bind-expected-user-turn",
                sessionId: current.id,
                waitId: expected.waitId,
                userMessageId: event.userMessageId,
                conversationIdentity: event.conversationIdentity,
                authorizationRevision,
              })
            },
          }
        },
      )
    } catch (error) {
      if (error instanceof RelayTransportError) {
        await this.failTransfer(current.id, pending.id, error.failure.reason)
        throw new RelayDomainError(error.failure.reason)
      }
      if (error instanceof RelayDomainError && error.reason === "invalid-session") return
      throw error
    }
  }

  private async failSession(sessionId: string, reason: RelayFailureReason): Promise<void> {
    const current = await this.deps.sessions.read()
    if (current === null || current.id !== sessionId) return
    await this.withTransition(
      { sessionId, revision: current.revision },
      (latest) => ({ nextSession: terminalFailure(latest, reason), result: undefined }),
    )
  }

  private async failTransfer(
    sessionId: string,
    transferId: string,
    reason: RelayFailureReason,
  ): Promise<void> {
    const current = await this.deps.sessions.read()
    if (current === null || current.id !== sessionId || current.pendingTransfer?.id !== transferId) return
    await this.withTransition(
      { sessionId, revision: current.revision, transferId },
      (latest) => ({ nextSession: terminalFailure(latest, reason), result: undefined }),
    )
  }

  async withTransition<T>(
    expected: TransitionExpectation,
    transition: (current: RelaySession) => Promise<TransitionDecision<T>> | TransitionDecision<T>,
  ): Promise<T> {
    const outcome = await this.deps.queue.run(async () => {
      const current = assertCurrentSession(await this.deps.sessions.read(), expected)
      const decision = await transition(current)
      const nextSession: RelaySession = {
        ...decision.nextSession,
        revision: current.revision + 1,
      }
      await this.deps.sessions.write(nextSession)
      return { result: decision.result, effect: decision.effect }
    })
    if (outcome.effect !== undefined) await outcome.effect()
    return outcome.result
  }
}
