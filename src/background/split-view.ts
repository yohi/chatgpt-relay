import { RelayDomainError } from "../shared/errors"

const DEFAULT_SPLIT_VIEW_ID = -1
const CHATGPT_URL = /^https:\/\/chatgpt\.com(?:\/|$)/i

export type TabSnapshot = {
  readonly id: number
  readonly windowId: number
  readonly active: boolean
  readonly url?: string
  readonly splitViewId?: number
}

export type SplitPair = {
  readonly splitViewId: number
  readonly tabA: number
  readonly tabB: number
}

function isEligibleChatGptTab(tab: TabSnapshot): boolean {
  return tab.url !== undefined && CHATGPT_URL.test(tab.url)
}

function isSplitViewId(value: number | undefined): value is number {
  return value !== undefined && value !== DEFAULT_SPLIT_VIEW_ID
}

export function discoverSplitPair(tabs: readonly TabSnapshot[]): SplitPair {
  const activeTabs = tabs.filter((tab) => tab.active && isEligibleChatGptTab(tab))
  const activeTab = activeTabs[0]
  if (activeTabs.length !== 1 || activeTab === undefined || !isSplitViewId(activeTab.splitViewId)) {
    throw new RelayDomainError("pair-invalid")
  }

  const candidates = tabs.filter(
    (tab) => isEligibleChatGptTab(tab) && tab.splitViewId === activeTab.splitViewId,
  )
  if (
    candidates.length !== 2 ||
    candidates.some((tab) => tab.windowId !== activeTab.windowId)
  ) {
    throw new RelayDomainError("pair-invalid")
  }

  const peer = candidates.find((tab) => tab.id !== activeTab.id)
  if (peer === undefined) throw new RelayDomainError("pair-invalid")

  return { splitViewId: activeTab.splitViewId, tabA: activeTab.id, tabB: peer.id }
}

export function isPairStillValid(pair: SplitPair, tabs: readonly TabSnapshot[]): boolean {
  if (!isSplitViewId(pair.splitViewId) || pair.tabA === pair.tabB) return false
  const first = tabs.find((tab) => tab.id === pair.tabA)
  const second = tabs.find((tab) => tab.id === pair.tabB)
  if (
    first === undefined ||
    second === undefined ||
    first.windowId !== second.windowId ||
    !isEligibleChatGptTab(first) ||
    !isEligibleChatGptTab(second) ||
    first.splitViewId !== pair.splitViewId ||
    second.splitViewId !== pair.splitViewId
  ) {
    return false
  }

  const candidates = tabs.filter(
    (tab) => isEligibleChatGptTab(tab) && tab.splitViewId === pair.splitViewId,
  )
  return candidates.length === 2 && candidates.every((tab) => tab.windowId === first.windowId)
}

export function splitViewChangeInvalidatesPair(
  pair: SplitPair,
  tabId: number,
  nextSplitViewId: number | undefined,
): boolean {
  if (tabId !== pair.tabA && tabId !== pair.tabB) return false
  return !isSplitViewId(nextSplitViewId) || nextSplitViewId !== pair.splitViewId
}
