import { useState, type ReactNode } from "react";
import type { LeadAgentSessionView } from "@t3tools/contracts";
import { Badge } from "../ui/badge";
import { groupOperatorItems } from "./operatorItems";

export function SessionViewPanel({
  sessionView,
}: {
  readonly sessionView?: LeadAgentSessionView | undefined;
}) {
  if (!sessionView)
    return (
      <aside aria-label="Session View" className="p-4 text-xs text-muted-foreground">
        Session View is not available yet.
      </aside>
    );
  const { attention, active, history } = groupOperatorItems(sessionView.items);
  const activeOrders =
    sessionView.standingOrders?.filter((order) => order.status === "active") ?? [];
  const oldOrders = sessionView.standingOrders?.filter((order) => order.status !== "active") ?? [];
  const oldSessions = sessionView.sessions?.filter((session) => !session.current) ?? [];
  const currentSession = sessionView.sessions?.find((session) => session.current);
  const notices = [...new Set(sessionView.notices)];
  const historyCount = history.length + oldOrders.length + oldSessions.length;
  return (
    <aside
      aria-label="Session View"
      className="min-h-0 overflow-y-auto border-t border-border/70 bg-muted/15 p-4 lg:border-t-0 lg:border-l"
    >
      <h2 className="text-xs font-semibold">Session View</h2>
      <p className="mt-2 text-xs text-muted-foreground">
        {active.length + attention.length} current work items · {sessionView.activeWorkerCount}{" "}
        active workers
      </p>
      {notices.length > 0 ? (
        <Section title="Notices">
          {notices.map((notice) => (
            <p
              key={notice}
              className="rounded-lg bg-warning/8 px-2.5 py-2 text-xs text-warning-foreground"
            >
              {notice}
            </p>
          ))}
        </Section>
      ) : null}
      {attention.length > 0 ? (
        <Section title="Needs attention">
          <Items items={attention} />
        </Section>
      ) : null}
      <Section title="Current work">
        {active.length === 0 ? (
          <p className="text-xs text-muted-foreground">No other work in progress.</p>
        ) : (
          <Items items={active.slice(0, 3)} />
        )}
        {active.length > 3 ? (
          <Disclosure title={`Show ${active.length - 3} more work items`}>
            <Items items={active.slice(3)} />
          </Disclosure>
        ) : null}
      </Section>
      <Disclosure title="Details">
        {currentSession ? <p className="text-xs">Current session: {currentSession.name}</p> : null}
        {sessionView.lead ? (
          <Section title="Lead">
            <p className="text-xs">
              {sessionView.lead.model} · {sessionView.lead.provider}
            </p>
            {sessionView.lead.contextWindow ? (
              <p className="text-xs text-muted-foreground">
                {Math.min(
                  100,
                  Math.round(
                    (sessionView.lead.contextTokens / sessionView.lead.contextWindow) * 100,
                  ),
                )}
                % context
              </p>
            ) : null}
          </Section>
        ) : null}
        <Section title="Worker Sessions">
          {sessionView.workers.length === 0 ? (
            <p className="text-xs text-muted-foreground">No active workers.</p>
          ) : (
            sessionView.workers.map((worker) => (
              <div key={worker.number} className="rounded-lg border border-border/60 p-2.5 text-xs">
                <p>{worker.label}</p>
                <p className="mt-1 text-muted-foreground">{worker.status}</p>
              </div>
            ))
          )}
        </Section>
        {activeOrders.length > 0 ? (
          <Section title="Standing Orders">
            <Orders orders={activeOrders} />
          </Section>
        ) : null}
      </Disclosure>
      <Disclosure title={`History (${historyCount})`}>
        {historyCount === 0 ? (
          <p className="text-xs text-muted-foreground">No history yet.</p>
        ) : null}
        {history.length > 0 ? (
          <Section title="Completed work">
            <Items items={history} />
          </Section>
        ) : null}
        {oldOrders.length > 0 ? (
          <Section title="Past Standing Orders">
            <Orders orders={oldOrders} />
          </Section>
        ) : null}
        {oldSessions.length > 0 ? (
          <Section title="Previous sessions">
            {oldSessions.map((session) => (
              <p key={session.number} className="text-xs">
                {session.name} · {session.state}
              </p>
            ))}
          </Section>
        ) : null}
      </Disclosure>
    </aside>
  );
}

function Items({ items }: { readonly items: LeadAgentSessionView["items"] }) {
  return items.map((item) => (
    <div key={item.number} className="rounded-xl border border-border/60 bg-card p-3 text-xs">
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium leading-snug">{item.outcome}</p>
        <Badge size="sm" variant={item.needsOwner ? "warning" : "outline"}>
          {item.status}
        </Badge>
      </div>
      {item.detail ? (
        item.needsOwner || item.status === "blocked" || item.status === "recovering" ? (
          <p className="mt-2 text-muted-foreground">{item.detail}</p>
        ) : (
          <Disclosure title="Work item details">
            <p className="text-muted-foreground">{item.detail}</p>
          </Disclosure>
        )
      ) : null}
    </div>
  ));
}

function Orders({
  orders,
}: {
  readonly orders: NonNullable<LeadAgentSessionView["standingOrders"]>;
}) {
  return orders.map((order) => (
    <Disclosure key={order.number} title={`${order.title} · ${order.status}`}>
      <p className="text-xs text-muted-foreground">{order.instruction}</p>
    </Disclosure>
  ));
}

function Disclosure({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="w-full rounded-md py-1 text-left text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span aria-hidden>{open ? "▾" : "▸"} </span>
        {title}
      </button>
      {open ? <div className="mt-2 flex flex-col gap-2">{children}</div> : null}
    </div>
  );
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="mt-4">
      <h3 className="mb-2 text-xs font-semibold text-muted-foreground">{title}</h3>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}
