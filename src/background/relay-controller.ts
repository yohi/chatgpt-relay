import type { RelayFailureReason, RelaySession, RelayStatusSnapshot } from "../shared/domain"
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
      current.state !== "waiting-a" ||
      current.tabA !== tabId ||
      expected?.side !== "a" ||
      expected.waitId !== event.waitId ||
      expected.causedByUserMessageId === undefined
    ) {
      return
    }
    if (
      event.causedByUserMessageId !== expected.causedByUserMessageId ||
      (expected.baselineMessageId !== null && event.message.messageId === expected.baselineMessageId)
    ) {
      await this.withTransition(
        { sessionId: current.id, revision: current.revision, waitId: expected.waitId },
        (latest) => ({
          nextSession: terminalFailure(latest, "relay-causality-ambiguous"),
          result: undefined,
        }),
      )
      return
    }

    if (current.lastMessageA === event.message.messageId) return
    await this.withTransition(
      { sessionId: current.id, revision: current.revision, waitId: expected.waitId },
      (latest) => ({
        nextSession: { ...latest, lastMessageA: event.message.messageId },
        result: undefined,
      }),
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
