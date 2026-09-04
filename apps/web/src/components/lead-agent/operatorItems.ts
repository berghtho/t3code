type OperatorItem = { readonly status: string; readonly needsOwner: boolean };

/** Presentation only. Keep the gateway snapshot and its item numbers intact. */
export function groupOperatorItems<T extends OperatorItem>(items: ReadonlyArray<T>) {
  const attention: T[] = [];
  const active: T[] = [];
  const history: T[] = [];
  for (const item of items) {
    if (item.needsOwner || item.status === "blocked" || item.status === "recovering") {
      attention.push(item);
    } else if (/^done(?:$|\s|\()/.test(item.status)) {
      history.push(item);
    } else {
      active.push(item);
    }
  }
  attention.sort((left, right) => Number(right.needsOwner) - Number(left.needsOwner));
  return { attention, active, history };
}
