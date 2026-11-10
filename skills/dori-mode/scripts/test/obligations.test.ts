import { afterEach, beforeEach, expect, test } from "bun:test";

import { ack, EYES, HOURGLASS, obligationsTick, recordHandled, track, unacked } from "../src/ack.ts";
import { MessengerError } from "../src/messenger/http.ts";
import { withState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const SEC = 1000;
const MIN = 60 * SEC;
const timers = { ackTimeoutSec: 120, handledTimeoutMin: 30 };
let state: ReturnType<typeof withState>;
beforeEach(() => { state = withState(); });
afterEach(() => state.done());

const fakeDiscord = (opts: { failReact?: string } = {}) => {
  const calls: string[] = [];
  const on = new Set<string>();
  return {
    calls,
    on,
    react: async (c: string, m: string, e: string) => {
      calls.push(`react ${e}`);
      if (opts.failReact === e) throw new MessengerError("boom", 500);
      on.add(`${c}/${m}/${e}`);
    },
    unreact: async (c: string, m: string, e: string) => {
      calls.push(`unreact ${e}`);
      if (!on.delete(`${c}/${m}/${e}`)) throw new MessengerError("Unknown Reaction", 404);
    },
  };
};

test("a tracked message gets the hourglass, and ack swaps it for the eyes before recording the ack", async () => {
  const dc = fakeDiscord();
  expect(await track(state.dir, dc, { channel: "11", message: "22", text: "please look" }, T0)).toBe("TRACKED 11 22 owner hourglass");
  expect([...dc.on]).toEqual([`11/22/${HOURGLASS}`]);
  expect(await ack(state.dir, dc, "11", "22", T0 + 30 * SEC)).toBe("ACKED 11 22");
  expect([...dc.on]).toEqual([`11/22/${EYES}`]);
  expect(unacked(state.dir)).toEqual([]);
});

test("a failed eyes reaction records no ack, so the message stays due", async () => {
  const dc = fakeDiscord({ failReact: EYES });
  await track(state.dir, dc, { channel: "11", message: "22" }, T0);
  await expect(ack(state.dir, dc, "11", "22", T0)).rejects.toThrow("boom");
  expect(unacked(state.dir).map((o) => o.message)).toEqual(["22"]);
});

test("acking a message that never got the hourglass (404 on removal) still puts the eyes on", async () => {
  const dc = fakeDiscord();
  expect(await ack(state.dir, dc, "11", "33", T0)).toBe("ACKED 11 33");
  expect([...dc.on]).toEqual([`11/33/${EYES}`]);
});

test("UNACKED fires once after ackTimeoutSec, UNHANDLED once after handledTimeoutMin from the ack, none once handled", async () => {
  await track(state.dir, undefined, { channel: "11", message: "22", text: "deploy it" }, T0);
  await track(state.dir, undefined, { channel: "11", message: "44", source: "card" }, T0);
  expect(obligationsTick(state.dir, timers, T0 + 119 * SEC)).toEqual([]);
  const due = obligationsTick(state.dir, timers, T0 + 121 * SEC);
  expect(due.map((l) => l.split(" ").slice(0, 4).join(" ")).sort()).toEqual(["UNACKED 11 22 owner", "UNACKED 11 44 card"]);
  expect(obligationsTick(state.dir, timers, T0 + 5 * MIN)).toEqual([]);
  await ack(state.dir, fakeDiscord(), "11", "22", T0 + 5 * MIN);
  recordHandled(state.dir, "11", "44", T0 + 6 * MIN, { reply: true });
  expect(obligationsTick(state.dir, timers, T0 + 34 * MIN)).toEqual([]);
  const late = obligationsTick(state.dir, timers, T0 + 35 * MIN);
  expect(late).toHaveLength(1);
  expect(late[0]).toStartWith("UNHANDLED 11 22 owner 30m acked \"deploy it\"");
  expect(obligationsTick(state.dir, timers, T0 + 60 * MIN)).toEqual([]);
});

test("tracking the same message twice keeps the first receipt time", async () => {
  await track(state.dir, undefined, { channel: "11", message: "22" }, T0);
  expect(await track(state.dir, undefined, { channel: "11", message: "22" }, T0 + 10 * MIN)).toBe("TRACK_EXISTS 11 22");
  expect(unacked(state.dir)[0]?.at).toBe(T0);
});

test("non-numeric ids and a handled without a link are refused", async () => {
  await expect(track(state.dir, undefined, { channel: "general", message: "22" }, T0)).rejects.toThrow("Discord ids");
  expect(() => recordHandled(state.dir, "11", "22", T0, {})).toThrow("--lane");
});
