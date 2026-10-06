import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { initializePopup } from "../../src/popup/popup"
import type { PopupRuntime } from "../../src/popup/popup"
import type { RelayStatusSnapshot } from "../../src/shared/domain"
import type { RelayMessage } from "../../src/shared/protocol"

const validPair = { valid: true as const, splitViewId: 8, tabA: 11, tabB: 12 }
const invalidPair = { valid: false as const, reason: "pair-invalid" as const }

function status(session: RelayStatusSnapshot["session"] = null): RelayStatusSnapshot {
  return { pair: validPair, session }
}

function activeSessionStatus(state: "waiting-a" | "waiting-b" | "dispatching-a" | "dispatching-b" | "stopping" = "waiting-a"): RelayStatusSnapshot {
  return {
    pair: validPair,
    session: {
      sessionId: "session-1",
      state,
      turn: 2,
      maxTurns: 10,
      expectedSide: "a",
      waitId: "wait-3",
      reason: null,
    },
  }
}

function terminalErrorStatus(): RelayStatusSnapshot {
  return {
    pair: validPair,
    session: {
      sessionId: "session-1",
      state: "error",
      turn: 2,
      maxTurns: 10,
      expectedSide: null,
      waitId: null,
      reason: "recovery-ambiguous",
    },
  }
}

async function popupDocument(): Promise<Document> {
  const html = await readFile(resolve(process.cwd(), "src/popup/popup.html"), "utf8")
  return new DOMParser().parseFromString(html, "text/html")
}

function getHTMLElement(document: Document, id: string): HTMLElement {
  const result = document.getElementById(id)
  if (!(result instanceof HTMLElement)) throw new Error(`missing popup element: ${id}`)
  return result
}

function getButton(document: Document, id: string): HTMLButtonElement {
  const result = document.getElementById(id)
  if (!(result instanceof HTMLButtonElement)) throw new Error(`missing popup button: ${id}`)
  return result
}

function getInput(document: Document, id: string): HTMLInputElement {
  const result = document.getElementById(id)
  if (!(result instanceof HTMLInputElement)) throw new Error(`missing popup input: ${id}`)
  return result
}

type RuntimeHarnessOptions = {
  readonly responses: Readonly<Record<string, readonly unknown[]>>
}

function createPopupRuntime(options: RuntimeHarnessOptions): {
  readonly runtime: PopupRuntime
  readonly requests: RelayMessage[]
} {
  const responses = new Map(
    Object.entries(options.responses).map(([type, values]) => [type, [...values]]),
  )
  const requests: RelayMessage[] = []
  return {
    requests,
    runtime: {
      async sendMessage(message) {
        requests.push(message)
        const response = responses.get(message.type)?.shift()
        if (response instanceof Error) throw response
        return response
      },
    },
  }
}

describe("relay popup", () => {
  it("disables Start when the current Split View pair is invalid", async () => {
    const document = await popupDocument()
    const harness = createPopupRuntime({
      responses: {
        "relay-status": [{ type: "relay-status-result", status: { pair: invalidPair, session: null } }],
        "relay-preferences-get": [{ type: "relay-preferences-result", maxTurns: 10 }],
      },
    })
    const popup = initializePopup(document, harness.runtime)
    await popup.ready

    expect(getButton(document, "start").disabled).toBe(true)
    expect(getInput(document, "max-turns").value).toBe("10")
    popup.dispose()
  })

  it("loads default maxTurns and persists a user preference", async () => {
    const document = await popupDocument()
    const harness = createPopupRuntime({
      responses: {
        "relay-status": [{ type: "relay-status-result", status: status() }],
        "relay-preferences-get": [{ type: "relay-preferences-result", maxTurns: 10 }],
        "relay-preferences-set": [
          { type: "relay-preferences-set-result", ok: true, maxTurns: 5 },
        ],
      },
    })
    const popup = initializePopup(document, harness.runtime)
    await popup.ready
    getInput(document, "max-turns").value = "5"
    getButton(document, "save-max-turns").click()
    await popup.settled()

    expect(harness.requests).toContainEqual({ type: "relay-preferences-set", maxTurns: 5 })
    expect(getHTMLElement(document, "preference-status").dataset["saved"]).toBe("true")
    popup.dispose()
  })

  it("sends Stop only for the currently displayed session ID", async () => {
    const document = await popupDocument()
    const harness = createPopupRuntime({
      responses: {
        "relay-status": [{ type: "relay-status-result", status: activeSessionStatus() }],
        "relay-preferences-get": [{ type: "relay-preferences-result", maxTurns: 10 }],
        "relay-stop": [{ type: "relay-stop-result", ok: true, status: status() }],
      },
    })
    const popup = initializePopup(document, harness.runtime)
    await popup.ready
    expect(getHTMLElement(document, "status").dataset["state"]).toBe("waiting-a")
    getButton(document, "stop").click()
    await popup.settled()

    expect(harness.requests).toContainEqual({ type: "relay-stop", sessionId: "session-1" })
    popup.dispose()
  })

  it("renders stopping and stopped as distinct machine states", async () => {
    const stoppingDocument = await popupDocument()
    const stoppingHarness = createPopupRuntime({
      responses: {
        "relay-status": [{ type: "relay-status-result", status: activeSessionStatus("stopping") }],
        "relay-preferences-get": [{ type: "relay-preferences-result", maxTurns: 10 }],
      },
    })
    const stoppingPopup = initializePopup(stoppingDocument, stoppingHarness.runtime)
    await stoppingPopup.ready

    const stoppedDocument = await popupDocument()
    const stoppedStatus = {
      pair: validPair,
      session: {
        sessionId: "session-1",
        state: "stopped" as const,
        turn: 2,
        maxTurns: 10,
        expectedSide: null,
        waitId: null,
        reason: "stopped-by-user" as const,
      },
    }
    const stoppedHarness = createPopupRuntime({
      responses: {
        "relay-status": [{ type: "relay-status-result", status: stoppedStatus }],
        "relay-preferences-get": [{ type: "relay-preferences-result", maxTurns: 10 }],
      },
    })
    const stoppedPopup = initializePopup(stoppedDocument, stoppedHarness.runtime)
    await stoppedPopup.ready

    expect(getHTMLElement(stoppingDocument, "status").dataset["state"]).toBe("stopping")
    expect(getHTMLElement(stoppedDocument, "status").dataset["state"]).toBe("stopped")
    stoppingPopup.dispose()
    stoppedPopup.dispose()
  })

  it("shows an actionable explanation for machine-readable Start failure", async () => {
    const document = await popupDocument()
    const failedStatus = { pair: invalidPair, session: null }
    const harness = createPopupRuntime({
      responses: {
        "relay-status": [{ type: "relay-status-result", status: status() }],
        "relay-preferences-get": [{ type: "relay-preferences-result", maxTurns: 10 }],
        "relay-start": [{
          type: "relay-start-result",
          ok: false,
          reason: "pair-invalid",
          status: failedStatus,
        }],
      },
    })
    const popup = initializePopup(document, harness.runtime)
    await popup.ready
    getButton(document, "start").click()
    await popup.settled()

    const error = getHTMLElement(document, "error")
    expect(error.dataset["reason"]).toBe("pair-invalid")
    expect(error.textContent?.length).toBeGreaterThan(0)
    popup.dispose()
  })

  it("renders exact Stop failure reason and accepted Stop ending in error", async () => {
    const failedDocument = await popupDocument()
    const failedHarness = createPopupRuntime({
      responses: {
        "relay-status": [{ type: "relay-status-result", status: activeSessionStatus() }],
        "relay-preferences-get": [{ type: "relay-preferences-result", maxTurns: 10 }],
        "relay-stop": [{
          type: "relay-stop-result",
          ok: false,
          reason: "invalid-session",
          status: activeSessionStatus(),
        }],
      },
    })
    const failedPopup = initializePopup(failedDocument, failedHarness.runtime)
    await failedPopup.ready
    getButton(failedDocument, "stop").click()
    await failedPopup.settled()
    expect(getHTMLElement(failedDocument, "error").dataset["reason"]).toBe("invalid-session")

    const acceptedDocument = await popupDocument()
    const acceptedHarness = createPopupRuntime({
      responses: {
        "relay-status": [{ type: "relay-status-result", status: activeSessionStatus() }],
        "relay-preferences-get": [{ type: "relay-preferences-result", maxTurns: 10 }],
        "relay-stop": [{ type: "relay-stop-result", ok: true, status: terminalErrorStatus() }],
      },
    })
    const acceptedPopup = initializePopup(acceptedDocument, acceptedHarness.runtime)
    await acceptedPopup.ready
    getButton(acceptedDocument, "stop").click()
    await acceptedPopup.settled()
    expect(getHTMLElement(acceptedDocument, "status").dataset["state"]).toBe("error")
    expect(getHTMLElement(acceptedDocument, "error").dataset["reason"]).toBe("recovery-ambiguous")
    expect(getHTMLElement(acceptedDocument, "status").dataset["stop-accepted"]).toBe("true")
    failedPopup.dispose()
    acceptedPopup.dispose()
  })

  it("shows generic runtime error and immediately refreshes status after a rejected action", async () => {
    const document = await popupDocument()
    const refreshedStatus = activeSessionStatus("waiting-b")
    const harness = createPopupRuntime({
      responses: {
        "relay-status": [
          { type: "relay-status-result", status: status() },
          { type: "relay-status-result", status: refreshedStatus },
        ],
        "relay-preferences-get": [{ type: "relay-preferences-result", maxTurns: 10 }],
        "relay-start": [new Error("closed runtime channel")],
      },
    })
    const popup = initializePopup(document, harness.runtime)
    await popup.ready
    getButton(document, "start").click()
    await popup.settled()

    expect(getHTMLElement(document, "error").dataset["runtimeError"]).toBe("true")
    expect(getHTMLElement(document, "status").dataset["state"]).toBe("waiting-b")
    expect(harness.requests.filter(({ type }) => type === "relay-status")).toHaveLength(2)
    popup.dispose()
  })

  it("reconstructs state from status on popup recreation without mutating the session", async () => {
    const requestsForPopup: RelayMessage[][] = []
    for (let i = 0; i < 2; i += 1) {
      const document = await popupDocument()
      const harness = createPopupRuntime({
        responses: {
          "relay-status": [{ type: "relay-status-result", status: activeSessionStatus() }],
          "relay-preferences-get": [{ type: "relay-preferences-result", maxTurns: 10 }],
        },
      })
      const popup = initializePopup(document, harness.runtime)
      await popup.ready
      requestsForPopup.push(harness.requests)
      expect(harness.requests.some(({ type }) => type === "relay-start" || type === "relay-stop")).toBe(false)
      popup.dispose()
    }

    expect(requestsForPopup.every((requests) => requests.some(({ type }) => type === "relay-status"))).toBe(true)
  })
})
