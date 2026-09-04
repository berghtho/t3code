import { describe, expect, it } from "vite-plus/test";
import { groupOperatorItems } from "./operatorItems";

describe("operator work selection", () => {
  it("keeps problems visible even on a previously completed item", () => {
    const items = [
      { number: 2, status: "done", needsOwner: false },
      { number: 4, status: "in progress", needsOwner: false },
      { number: 7, status: "done", needsOwner: true },
      { number: 8, status: "blocked", needsOwner: false },
      { number: 9, status: "recovering", needsOwner: false },
      { number: 10, status: "paused", needsOwner: false },
    ];
    const groups = groupOperatorItems(items);
    expect(groups.attention.map((item) => item.number)).toEqual([7, 8, 9]);
    expect(groups.active.map((item) => item.number)).toEqual([4, 10]);
    expect(groups.history.map((item) => item.number)).toEqual([2]);
    expect(items.map((item) => item.number)).toEqual([2, 4, 7, 8, 9, 10]);
  });

  it("removes completed work from current counts and restores reopened work", () => {
    const older = Array.from({ length: 1000 }, (_, number) => ({
      number,
      status: "done",
      needsOwner: false,
    }));
    const current = { number: 1001, status: "verifying the result", needsOwner: false };
    expect(groupOperatorItems([...older, current]).active).toEqual([current]);
    current.status = "done";
    expect(groupOperatorItems([...older, current]).active).toEqual([]);
    current.status = "in progress (Worker running)";
    expect(groupOperatorItems([...older, current]).active).toEqual([current]);
  });
});
