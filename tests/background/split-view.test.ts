import { describe, expect, it } from "vitest"
import { RelayDomainError } from "../../src/shared/errors"
import {
  discoverSplitPair,
  isPairStillValid,
  splitViewChangeInvalidatesPair,
} from "../../src/background/split-view"
import type { TabSnapshot } from "../../src/background/split-view"

const tabA: TabSnapshot = {
  id: 1,
  windowId: 3,
  active: true,
  url: "https://chatgpt.com/c/a",
  splitViewId: 8,
}

const tabB: TabSnapshot = {
  id: 2,
  windowId: 3,
  active: false,
  url: "https://chatgpt.com/c/b",
  splitViewId: 8,
}

describe("Split View pair discovery", () => {
  it("assigns the active eligible ChatGPT tab as A and the other tab as B", () => {
    expect(discoverSplitPair([tabA, tabB])).toEqual({ splitViewId: 8, tabA: 1, tabB: 2 })
  })

  it("rejects candidates outside ChatGPT", () => {
    expect(() => discoverSplitPair([tabA, { ...tabB, url: "https://example.com/" }])).toThrow(
      RelayDomainError,
    )
  })

  it("rejects tabs in different windows", () => {
    expect(() => discoverSplitPair([tabA, { ...tabB, windowId: 4 }])).toThrow(RelayDomainError)
  })

  it("rejects missing or default Split View identifiers", () => {
    const { splitViewId: _splitViewId, ...tabWithoutSplitViewId } = tabB

    expect(() => discoverSplitPair([tabA, tabWithoutSplitViewId])).toThrow(RelayDomainError)
    expect(() => discoverSplitPair([tabA, { ...tabB, splitViewId: -1 }])).toThrow(RelayDomainError)
  })

  it("rejects a candidate group with more than two eligible tabs", () => {
    expect(() => discoverSplitPair([tabA, tabB, { ...tabB, id: 3 }])).toThrow(RelayDomainError)
  })

  it("revalidates the persisted pair against current tabs", () => {
    const pair = discoverSplitPair([tabA, tabB])

    expect(isPairStillValid(pair, [tabA, tabB])).toBe(true)
    expect(isPairStillValid(pair, [tabA, { ...tabB, splitViewId: 9 }])).toBe(false)
  })

  it("invalidates a paired tab when its Split View changes", () => {
    const pair = { splitViewId: 8, tabA: 1, tabB: 2 }

    expect(splitViewChangeInvalidatesPair(pair, 1, -1)).toBe(true)
    expect(splitViewChangeInvalidatesPair(pair, 2, undefined)).toBe(true)
    expect(splitViewChangeInvalidatesPair(pair, 2, 9)).toBe(true)
    expect(splitViewChangeInvalidatesPair(pair, 3, 9)).toBe(false)
    expect(splitViewChangeInvalidatesPair(pair, 1, 8)).toBe(false)
  })
})
