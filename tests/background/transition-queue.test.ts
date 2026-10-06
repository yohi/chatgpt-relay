import { describe, expect, it } from "vitest"
import { TransitionQueue } from "../../src/background/transition-queue"

describe("TransitionQueue", () => {
  it("executes asynchronous operations in enqueue order", async () => {
    const queue = new TransitionQueue()
    const events: string[] = []
    let releaseFirst: () => void = () => {}
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const first = queue.run(async () => {
      events.push("first-start")
      await firstGate
      events.push("first-end")
    })
    const second = queue.run(async () => {
      events.push("second")
    })

    await Promise.resolve()
    expect(events).toEqual(["first-start"])
    releaseFirst()
    await Promise.all([first, second])

    expect(events).toEqual(["first-start", "first-end", "second"])
  })
})
