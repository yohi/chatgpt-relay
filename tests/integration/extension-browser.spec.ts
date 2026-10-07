import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { chromium, expect, test as base } from "@playwright/test"
import type { BrowserContext, CDPSession, Worker } from "@playwright/test"
import { transform } from "esbuild"
import type { RelaySession } from "../../src/shared/domain"

const CHROME_IDLE_TEST_TIMEOUT_MS = 90_000
const EXTENSION_PATH = resolve(process.cwd(), "dist")

type ExtensionFixtures = {
  readonly extensionContext: BrowserContext
  readonly extensionId: string
  readonly serviceWorker: Worker
}

type ServiceWorkerVersionObservation = {
  readonly registrationId: string
  readonly scriptURL: string
  readonly versionId: string
  readonly runningStatus: "stopped" | "starting" | "running" | "stopping"
  readonly status: string
}

const test = base.extend<ExtensionFixtures>({
  extensionContext: async ({}, use) => {
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      headless: process.env["RELAY_BROWSER_HEADED"] !== "1",
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
      ],
    })
    await use(context)
    await context.close()
  },
  serviceWorker: async ({ extensionContext }, use) => {
    const existing = extensionContext.serviceWorkers()[0]
    const serviceWorker = existing ?? await extensionContext.waitForEvent("serviceworker")
    await use(serviceWorker)
  },
  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host)
  },
})

async function routeChatFixture(context: BrowserContext): Promise<void> {
  const html = await readFile(resolve(process.cwd(), "tests/integration/harness/chat-page.html"), "utf8")
  const source = await readFile(resolve(process.cwd(), "tests/integration/harness/chat-page.ts"), "utf8")
  const script = await transform(source, { loader: "ts", format: "iife" })
  await context.route("https://chatgpt.com/__relay-test/**", async (route) => {
    if (new URL(route.request().url()).pathname.endsWith("/chat-page.js")) {
      await route.fulfill({ status: 200, contentType: "application/javascript", body: script.code })
      return
    }
    await route.fulfill({ status: 200, contentType: "text/html", body: html })
  })
}

async function currentActiveTabId(worker: Worker): Promise<number> {
  return worker.evaluate(async () => {
    const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true })
    const activeTab = activeTabs[0]
    if (activeTab?.id === undefined) throw new Error("The extension test has no active browser tab")
    return activeTab.id
  })
}

async function identifyExtensionWorker(
  cdp: CDPSession,
  extensionId: string,
  scriptURL: string,
): Promise<{
  readonly target: ServiceWorkerVersionObservation
  readonly registrations: Map<string, string>
  readonly versions: Map<string, ServiceWorkerVersionObservation>
}> {
  const scopeURL = `chrome-extension://${extensionId}/`
  const registrations = new Map<string, string>()
  const versions = new Map<string, ServiceWorkerVersionObservation>()
  const waiters = new Set<() => void>()
  let ready: (() => void) | undefined
  let ambiguous = false
  const targetReady = new Promise<void>((resolveReady) => { ready = resolveReady })

  const matchingRegistrationIds = () => Array.from(registrations)
    .filter(([, registrationScope]) => registrationScope === scopeURL)
    .map(([registrationId]) => registrationId)
  const matchingVersions = () => {
    const registrationIds = new Set(matchingRegistrationIds())
    return Array.from(versions.values()).filter(
      (version) =>
        registrationIds.has(version.registrationId) &&
        version.scriptURL === scriptURL &&
        version.status !== "redundant",
    )
  }
  const notifyWaiters = () => {
    const registrationIds = matchingRegistrationIds()
    const workerVersions = matchingVersions()
    if (registrationIds.length > 1 || workerVersions.length > 1) ambiguous = true
    for (const waiter of waiters) waiter()
    if (ambiguous || (registrationIds.length === 1 && workerVersions.length === 1)) ready?.()
  }

  cdp.on("ServiceWorker.workerRegistrationUpdated", ({ registrations: updated }) => {
    for (const registration of updated) {
      if (registration.isDeleted) registrations.delete(registration.registrationId)
      else registrations.set(registration.registrationId, registration.scopeURL)
    }
    notifyWaiters()
  })
  cdp.on("ServiceWorker.workerVersionUpdated", ({ versions: updated }) => {
    for (const version of updated) versions.set(version.versionId, version)
    notifyWaiters()
  })

  await cdp.send("ServiceWorker.enable")
  notifyWaiters()
  await targetReady
  const candidates = matchingVersions()
  if (ambiguous || matchingRegistrationIds().length !== 1 || candidates.length !== 1) {
    throw new Error("Target extension service-worker registration/version is missing or ambiguous")
  }
  const target = candidates[0]
  if (target === undefined) throw new Error("Target extension service-worker version is unavailable")
  return { target, registrations, versions }
}

function waitForExtensionWorkerStatus(
  cdp: CDPSession,
  extensionId: string,
  versionId: string,
  scriptURL: string,
  status: ServiceWorkerVersionObservation["runningStatus"],
  versions: Map<string, ServiceWorkerVersionObservation>,
  registrationScopes: Map<string, string>,
): Promise<void> {
  const extensionScope = `chrome-extension://${extensionId}/`
  return new Promise<void>((resolveStatus, rejectStatus) => {
    const matches = () => Array.from(versions.values()).filter(
      (version) =>
        registrationScopes.get(version.registrationId) === extensionScope &&
        version.scriptURL === scriptURL &&
        version.status !== "redundant",
    )
    const check = () => {
      const candidates = matches()
      if (candidates.length > 1) {
        waitersDelete()
        rejectStatus(new Error("Target extension service-worker version became ambiguous"))
        return
      }
      const target = candidates[0]
      if (target?.versionId === versionId && target.runningStatus === status) {
        waitersDelete()
        resolveStatus()
      }
    }
    const waitersDelete = () => cdp.off("ServiceWorker.workerVersionUpdated", onUpdate)
    const onUpdate = ({ versions: updated }: { readonly versions: readonly ServiceWorkerVersionObservation[] }) => {
      for (const version of updated) versions.set(version.versionId, version)
      check()
    }
    cdp.on("ServiceWorker.workerVersionUpdated", onUpdate)
    check()
  })
}

function sessionFixture(): RelaySession {
  return {
    id: "browser-session",
    revision: 7,
    splitViewId: 8,
    tabA: 11,
    tabB: 12,
    conversationA: { state: "bound", conversationIdentity: "browser-fixture" },
    conversationB: { state: "bound", conversationIdentity: "browser-peer" },
    state: "waiting-b",
    turn: 1,
    maxTurns: 10,
    expectedResponse: {
      sessionId: "browser-session",
      waitId: "browser-wait-b",
      side: "b",
      tabId: 12,
      baselineMessageId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      causedByTransferId: "browser-transfer",
      causedByUserMessageId: "22222222-2222-4222-8222-222222222222",
    },
    lastMessageA: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    pendingTransfer: {
      id: "browser-transfer",
      sourceTabId: 11,
      targetTabId: 12,
      sourceMessageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      payloadHash: "browser-payload-hash",
      targetWaitId: "browser-wait-b",
      targetBaselineMessageId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      targetUserMessageId: "22222222-2222-4222-8222-222222222222",
      authorizationRevision: 6,
      submissionState: "committed",
    },
  }
}

test("loads the unpacked MV3 extension and popup status round-trip", async ({
  extensionContext,
  extensionId,
  serviceWorker,
}) => {
  expect(new URL(serviceWorker.url()).host).toBe(extensionId)
  const page = await extensionContext.newPage()
  await page.goto(`chrome-extension://${extensionId}/popup.html`)
  await expect(page.getByRole("heading", { name: "ChatGPT Relay" })).toBeVisible()
  await expect(page.getByText("A valid ChatGPT Split View pair is required.")).toBeVisible()
  const result: unknown = await page.evaluate(async () => chrome.runtime.sendMessage({ type: "relay-status" }))
  expect(result).toMatchObject({
    type: "relay-status-result",
    status: { pair: { valid: false, reason: "pair-invalid" }, session: null },
  })
})

test("injects only on the ChatGPT fixture origin and preserves its URL", async ({ extensionContext, serviceWorker }) => {
  await routeChatFixture(extensionContext)
  const page = await extensionContext.newPage()
  await page.goto("https://chatgpt.com/__relay-test/idle")
  expect(page.url()).toBe("https://chatgpt.com/c/browser-fixture")
  await expect(page.locator("html")).toHaveAttribute("data-relay-fixture-ready", "true")

  const tabId = await currentActiveTabId(serviceWorker)
  const inspection: unknown = await serviceWorker.evaluate(async (id) => {
    return chrome.tabs.sendMessage(id, { type: "adapter-inspect" })
  }, tabId)
  expect(inspection).toMatchObject({
    type: "adapter-inspect-result",
    snapshot: { ready: true, conversationIdentity: "browser-fixture" },
  })

  const outsidePage = await extensionContext.newPage()
  await extensionContext.route("https://example.test/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<main>outside origin</main>" }),
  )
  await outsidePage.goto("https://example.test/relay")
  const outsideTabId = await currentActiveTabId(serviceWorker)
  const hasReceiver = await serviceWorker.evaluate(async (id) => {
    try {
      await chrome.tabs.sendMessage(id, { type: "adapter-inspect" })
      return true
    } catch {
      return false
    }
  }, outsideTabId)
  expect(hasReceiver).toBe(false)

  const manifestText = await readFile(resolve(EXTENSION_PATH, "manifest.json"), "utf8")
  const manifest: unknown = JSON.parse(manifestText)
  expect(manifest).toMatchObject({
    permissions: ["storage"],
    host_permissions: ["https://chatgpt.com/*"],
    content_scripts: [{ matches: ["https://chatgpt.com/*"] }],
  })
})

test("routes transcript interference through the real content-to-worker message path", async ({
  extensionContext,
  serviceWorker,
}) => {
  await routeChatFixture(extensionContext)
  const page = await extensionContext.newPage()
  await page.goto("https://chatgpt.com/__relay-test/idle")
  await expect(page.locator("html")).toHaveAttribute("data-relay-fixture-ready", "true")
  const tabId = await currentActiveTabId(serviceWorker)
  const fixtureSession = sessionFixture()
  await serviceWorker.evaluate(async (input) => {
    await chrome.storage.session.set({ activeRelaySession: input })
  }, { ...fixtureSession, tabA: tabId })
  await serviceWorker.evaluate(async ({ id, expected }) => {
    await chrome.tabs.sendMessage(id, {
      type: "arm-response",
      expected: { ...expected, tabId: id },
      authorizationRevision: 7,
    })
  }, { id: tabId, expected: fixtureSession.expectedResponse })

  await page.getByRole("button", { name: "メッセージを編集" }).click()
  await expect.poll(() => serviceWorker.evaluate(async () => {
    const stored = await chrome.storage.session.get("activeRelaySession")
    const sessionValue: unknown = stored["activeRelaySession"]
    if (typeof sessionValue !== "object" || sessionValue === null) return null
    return Reflect.get(sessionValue, "stopReason")
  })).toBe("transcript-interference")
})

test("deterministic MV3 stop/restart resets globals and preserves session storage on the same Worker", async ({
  extensionContext,
  extensionId,
  serviceWorker,
}) => {
  test.setTimeout(CHROME_IDLE_TEST_TIMEOUT_MS)
  const fixture = sessionFixture()
  const cdpPage = await extensionContext.newPage()
  const cdp = await extensionContext.newCDPSession(cdpPage)
  try {
    const scriptURL = serviceWorker.url()
    const lifecycle = await identifyExtensionWorker(cdp, extensionId, scriptURL)
    await serviceWorker.evaluate(async (input) => {
      await chrome.storage.session.set({ activeRelaySession: input })
      Reflect.set(globalThis, "__relayLifetimeMarker", "before-restart")
    }, fixture)

    const stopped = waitForExtensionWorkerStatus(
      cdp,
      extensionId,
      lifecycle.target.versionId,
      scriptURL,
      "stopped",
      lifecycle.versions,
      lifecycle.registrations,
    )
    await cdp.send("ServiceWorker.stopWorker", { versionId: lifecycle.target.versionId })
    await stopped

    const running = waitForExtensionWorkerStatus(
      cdp,
      extensionId,
      lifecycle.target.versionId,
      scriptURL,
      "running",
      lifecycle.versions,
      lifecycle.registrations,
    )
    await cdp.send("ServiceWorker.startWorker", { scopeURL: `chrome-extension://${extensionId}/` })
    await running

    const extensionWorkers = extensionContext.serviceWorkers().filter(
      (worker) => new URL(worker.url()).host === extensionId,
    )
    expect(extensionWorkers).toContain(serviceWorker)
    if (extensionWorkers.length === 1) expect(extensionWorkers).toStrictEqual([serviceWorker])

    const afterRestart = await serviceWorker.evaluate(async () => {
      const stored = await chrome.storage.session.get("activeRelaySession")
      const sessionValue: unknown = stored["activeRelaySession"]
      return {
        lifetimeMarker: Reflect.get(globalThis, "__relayLifetimeMarker") ?? null,
        session: sessionValue,
      }
    })
    expect(afterRestart.lifetimeMarker).toBeNull()
    expect(afterRestart.session).toEqual(fixture)
  } finally {
    await cdp.detach()
    await cdpPage.close()
  }

  const popup = await extensionContext.newPage()
  await popup.goto(`chrome-extension://${extensionId}/popup.html`)
  await expect(popup.locator("#status")).toHaveAttribute("data-state", "waiting-b")
  await popup.close()
})
