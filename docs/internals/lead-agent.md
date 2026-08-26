# External Lead Agent

T3 Code can expose a CMD Riker Lead Agent through the existing authenticated WebSocket connection.
This is a presentation integration, not a provider adapter: CMD Riker remains authoritative for the
Owner conversation, delegated work, effects, and verification.

The server launches `riker gateway --project <canonicalWorkspaceRoot>` lazily when a client first
subscribes or sends an Owner turn. It resolves the RPC's `projectId` through the active project
projection, normalizes the configured workspace root, and resolves its real path on the environment
that owns the project. A client never supplies a workspace path.

`RikerOwnerGateway` requires external Owner Gateway protocol version 2, validates the versioned
JSON-lines records, and owns the child process. The ready snapshot and every later conversation event
must target the requested canonical project path. Path comparison is case-insensitive on Windows and
case-sensitive elsewhere; slash direction and trailing directory separators are normalized. Startup
and unexpected stream-closure failures record a bounded, commonly redacted stderr tail in server
diagnostics while clients receive stable error messages that do not include child-process output.

`LeadAgentBridge` owns one gateway connection and single-consumer event stream per canonical project
path, projects each latest snapshot, and fans updates out to that project's clients. Subscribers to
the same project share a connection; different projects have isolated connection, projection,
reconnect, and generation state. A terminal gateway failure ends that project's current
subscriptions; its next request attempts a fresh connection. Riker availability therefore does not
gate T3 server startup. Each gateway generation has its own resource scope, which is closed on
disconnect or server shutdown so retired child-process resources do not accumulate.

The wire surface is defined in `packages/contracts/src/leadAgent.ts`:

- `subscribeLeadAgent` accepts a branded `projectId`, streams an initial snapshot followed by
  semantic events, and requires `orchestration:read`.
- `leadAgent.completeTurn` forwards one non-blank Owner turn without changing its content and requires
  a branded `projectId` plus `orchestration:operate`.

Remote clients select their environment connection outside this RPC contract. Only the environment-
local `projectId` crosses the WebSocket; `environmentId` and workspace paths do not.

The Session View contract contains presentation-safe numbers and plain-language status only. T3 does
not persist or derive a competing workflow model from it, and it does not launch provider sessions or
modify Target Project state on the Lead Agent's behalf.
