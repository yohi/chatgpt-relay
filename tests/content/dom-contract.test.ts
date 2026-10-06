import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { RelayDomainError } from "../../src/shared/errors"
import {
  findSubmitControl,
  inspectChatGptDom,
  readTranscript,
} from "../../src/content/dom-contract"
import type { TranscriptEntry } from "../../src/content/dom-contract"

async function loadFixture(name: string, pathname: string): Promise<Document> {
  const html = await readFile(resolve(process.cwd(), "tests/content/fixtures", name), "utf8")
  document.body.innerHTML = html
  window.history.replaceState(null, "", pathname)
  return document
}

describe("ChatGPT DOM contract", () => {
  it("treats a new root chat with no transcript as unbound, ignoring local IDs", async () => {
    const page = await loadFixture("new-chat.html", "/")
    const inspection = inspectChatGptDom(page)

    expect(inspection.conversationIdentity).toBeNull()
    expect(inspection.transcript).toEqual([])
    expect(inspection.composer.id).toBe("main-textbox")
  })

  it("extracts stable conversation identity from a committed thread pathname", async () => {
    const page = await loadFixture("idle-existing.html", "/c/conversation-123")

    expect(inspectChatGptDom(page).conversationIdentity).toBe("conversation-123")
  })

  it("selects the unique main composer and submit control, excluding Quick Chat", async () => {
    const page = await loadFixture("idle-existing.html", "/c/conversation-123")
    const inspection = inspectChatGptDom(page)

    expect(inspection.composer.id).toBe("main-textbox")
    expect(findSubmitControl(page).id).toBe("main-submit")
  })

  it("reads user and assistant transcript roles in DOM order with stable UUIDs", async () => {
    const page = await loadFixture("idle-existing.html", "/c/conversation-123")
    const transcript = readTranscript(page)

    expect(transcript.map(({ role }) => role)).toEqual(["user", "assistant"])
    expect(transcript.map(({ stableDomId }) => stableDomId)).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ])
  })

  it("normalizes duplicated identical assistant UUID tokens to one identity", async () => {
    const page = await loadFixture("completed.html", "/c/conversation-123")
    const transcript = readTranscript(page)

    expect(transcript[1]?.stableDomId).toBe("44444444-4444-4444-8444-444444444444")
  })

  it("rejects multiple distinct message IDs and duplicate user-unit identities", async () => {
    const page = await loadFixture("completed.html", "/c/conversation-123")
    document.getElementById("assistant-turn")?.setAttribute(
      "data-chatgpt-search-message-ids",
      "44444444-4444-4444-8444-444444444444 77777777-7777-4777-8777-777777777777",
    )
    expect(() => readTranscript(page)).toThrow(
      new RelayDomainError("message-identity-ambiguous"),
    )

    const duplicatePage = await loadFixture("idle-existing.html", "/c/conversation-123")
    const duplicateUser = document.getElementById("user-turn")?.cloneNode(true)
    document.getElementById("transcript")?.append(duplicateUser ?? document.createElement("span"))
    expect(() => readTranscript(duplicatePage)).toThrow(
      new RelayDomainError("message-identity-ambiguous"),
    )
  })

  it("rejects missing, malformed, or uncorroborated stable message identities", async () => {
    const page = await loadFixture("idle-existing.html", "/c/conversation-123")
    document.getElementById("user-turn")?.removeAttribute("data-chatgpt-search-message-ids")
    expect(() => readTranscript(page)).toThrow(
      new RelayDomainError("message-identity-ambiguous"),
    )

    const malformed = await loadFixture("idle-existing.html", "/c/conversation-123")
    document.getElementById("user-turn")?.setAttribute("data-chatgpt-search-message-ids", "not-a-uuid")
    expect(() => readTranscript(malformed)).toThrow(
      new RelayDomainError("message-identity-ambiguous"),
    )

    const mismatch = await loadFixture("idle-existing.html", "/c/conversation-123")
    document.getElementById("assistant-turn")?.setAttribute(
      "data-chatgpt-selection-message-id",
      "99999999-9999-4999-8999-999999999999",
    )
    expect(() => readTranscript(mismatch)).toThrow(
      new RelayDomainError("message-identity-ambiguous"),
    )
  })

  it("reports generating while the assistant UUID already exists", async () => {
    const page = await loadFixture("generating.html", "/c/conversation-123")
    const inspection = inspectChatGptDom(page)

    expect(inspection.generating).toBe(true)
    expect(inspection.transcript.some(({ role }) => role === "assistant")).toBe(true)
  })

  it("reports completed-state observations only after the main Stop control disappears", async () => {
    const page = await loadFixture("completed.html", "/c/conversation-123")
    const inspection = inspectChatGptDom(page)

    expect(inspection.generating).toBe(false)
    expect(inspection.transcript[1]?.stableDomId).toBe("44444444-4444-4444-8444-444444444444")
    expect(inspection.transcript[1]?.branchEvidence).toBe("regenerate")
  })

  it("recognizes edit and regenerate controls as transcript interference evidence", async () => {
    const page = await loadFixture("transcript-interference.html", "/c/conversation-123")

    expect(readTranscript(page).map(({ branchEvidence }) => branchEvidence)).toEqual([
      "edit",
      "regenerate",
    ])
  })

  it("fails closed for zero or multiple main composer candidates", async () => {
    const ambiguous = await loadFixture("ambiguous-composer.html", "/")
    expect(() => inspectChatGptDom(ambiguous)).toThrow(
      new RelayDomainError("dom-contract-ambiguous"),
    )

    document.body.innerHTML = "<main><form data-chatgpt-composer></form></main>"
    expect(() => inspectChatGptDom(document)).toThrow(
      new RelayDomainError("dom-contract-ambiguous"),
    )
  })

  it("fails closed for multiple stop controls in the main composer", async () => {
    const page = await loadFixture("generating.html", "/c/conversation-123")
    const secondStop = document.createElement("button")
    secondStop.setAttribute("aria-label", "停止")
    document.getElementById("main-composer")?.append(secondStop)

    expect(() => inspectChatGptDom(page)).toThrow(
      new RelayDomainError("dom-contract-ambiguous"),
    )
  })

  it("fails closed for zero or multiple semantic submit controls", async () => {
    const page = await loadFixture("new-chat.html", "/")
    expect(findSubmitControl(page).id).toBe("main-submit")

    document.getElementById("main-composer")?.append(document.createElement("button"))
    const secondSubmit = document.createElement("button")
    secondSubmit.type = "submit"
    document.getElementById("main-composer")?.append(secondSubmit)
    expect(() => findSubmitControl(page)).toThrow(
      new RelayDomainError("dom-contract-ambiguous"),
    )
  })

  it("rejects a transcript without a stable committed-conversation pathname", async () => {
    const page = await loadFixture("idle-existing.html", "/")

    expect(() => inspectChatGptDom(page)).toThrow(
      new RelayDomainError("dom-contract-ambiguous"),
    )
  })

  it("fails closed on a non-ChatGPT page without the approved main context", () => {
    document.body.innerHTML = "<main><textarea></textarea></main>"
    window.history.replaceState(null, "", "/")

    expect(() => inspectChatGptDom(document)).toThrow(
      new RelayDomainError("dom-contract-ambiguous"),
    )
  })

  it("keeps the task-owned adapter snapshot minimal", async () => {
    const page = await loadFixture("completed.html", "/c/conversation-123")
    const inspection = inspectChatGptDom(page)
    const transcript: readonly TranscriptEntry[] = inspection.transcript

    expect(inspection.ready).toBe(true)
    expect(transcript).toHaveLength(2)
  })
})
