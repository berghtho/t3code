# External Lead Agent

T3 Code can expose a CMD Riker Lead Agent through the existing authenticated WebSocket connection.
This is a presentation integration, not a provider adapter: CMD Riker remains authoritative for the
Owner conversation, delegated work, effects, and verification.

The server launches `riker gateway` lazily when a client first subscribes or sends an Owner turn.
`RikerOwnerGateway` validates the versioned JSON-lines protocol and owns the child process.
`LeadAgentBridge` owns the gateway's single-consumer event stream, projects the latest snapshot, and
fans updates out to clients. A terminal gateway failure ends current subscriptions; the next request
attempts a fresh connection. Riker availability therefore does not gate T3 server startup.

The wire surface is defined in `packages/contracts/src/leadAgent.ts`:

- `subscribeLeadAgent` streams an initial snapshot followed by semantic events and requires
  `orchestration:read`.
- `leadAgent.completeTurn` forwards one non-empty Owner turn without changing its content and requires
  `orchestration:operate`.

The Session View contract contains presentation-safe numbers and plain-language status only. T3 does
not persist or derive a competing workflow model from it, and it does not launch provider sessions or
modify Target Project state on the Lead Agent's behalf.
