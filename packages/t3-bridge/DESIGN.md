# Bridge design

The user wants to message T3 agents from Ember using the existing bot interface. Ember sends an administrator-configured webhook when mentioned or DMed. The webhook carries a relative credential-bearing room callback path and optional thread ID. HTTP 202 acknowledges without a synchronous reply. The bot API later accepts markup at the configured room route. No changes to timeline, storage queries, broadcasts or presence in the Worker are needed.

Two independent read-only architect runners considered these whole-system alternatives.

| Candidate | Durable model | Ordering and recovery | Cost |
| --- | --- | --- | --- |
| SQLite jobs | Unique inbound jobs plus conversation bindings | Explicit state transitions, one queue head per conversation | Small implementation and directly inspectable state |
| Actor journal | Append-only event log plus replayed projections | Per-conversation sequence, event replay, prepared effects | More replay/projection code and future compaction |

The implementation uses SQLite jobs. Both candidates required a checkpoint before remote mutation, exact-run observation and deliberate stops on uncertain effects. The journal candidate's distinction between prepared, accepted and delivered effects is retained in the state union. Cross-judging by another model family was unavailable because all configured architect models are GPT-family models; the implementation owner synthesized the alternatives. Independent focused review runs separately, and the parent owns final review and publication.

The domain shape is `Delivery`, `Target` and the discriminated `State` union. `Store.enqueue` durably admits a unique message before HTTP 202. `Bridge.tick` selects the first unfinished message per conversation. `T3.submit` launches a new worktree thread or queues a followup on the bound thread. `Store.accepted` atomically saves the thread binding and running state. `T3.observe` checks the exact run and collects local output only after settlement. `Bridge` persists reply text before its callback POST. Unknown states block the conversation until explicit operator resolution. SQLite exclusive locking gives the private directory a single owner.

The throughput checkpoint follows the implementation brief. Protocol and auth grounding block implementation. Design sketches are independent read-only work. Runtime state belongs solely to this bridge and implementation belongs to one checkout owner. One code owner avoids split schema and queue ownership; test fixtures provide the rerunnable verification tool.

Module ownership is explicit. `config.ts` parses admission and network boundaries. `oauth.ts` owns credential persistence and sign-in. `t3.ts` hides MCP schemas and tool operations. `store.ts` owns durable state. `bridge.ts` owns HTTP and the scheduler. `cli.ts` owns operator commands. No arbitrary tool proxy, approval endpoint or direct T3 database access is exposed.

Known limitations and operator procedures are in [the setup guide](../../docs/t3-bridge.md). Tests use local protocol fixtures. Live compatibility remains unverified until the parent's coordinated pilot.

Focused review found a reply-size defect. The final renderer uses the shared protocol's `MAX_MESSAGE_LENGTH` to budget status, output, T3 link and delivery marker together. A long-answer regression verifies that the callback remains within the plain-text limit. The seven bridge tests pass, including executable server startup and HTTP OAuth/MCP contracts. Repository-wide `pnpm typecheck`, `pnpm test` and `pnpm build` passed. Worker tests reported 184 files and 4,120 tests passing. The final bridge-only typecheck, test and build also passed after the last local fixes. Perf load tests were not run because existing Worker queries, broadcasts, presence and timeline code were unchanged.
