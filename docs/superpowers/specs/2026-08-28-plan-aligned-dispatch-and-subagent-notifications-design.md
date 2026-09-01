# Plan-Aligned Dispatch and Per-Subagent Notification Design

## Context

`pi-multi-agent-team` must remain useful with or without a planning skill. Today the leader always distills work into a team task packet, which is correct for unplanned work. When an existing implementation plan already defines execution units, however, the team protocol does not require the task packet to preserve those units. A leader can therefore re-slice a planned task, combine unrelated planned tasks, or expand a mechanical executor packet into research, design, implementation, broad testing, and self-review.

The standard implementation recipe also runs an executor and its reviewer inside one top-level asynchronous workflow. Mission state records the executor result before review, but the parent leader normally receives a completion wake only when the whole workflow ends. A slow reviewer therefore makes a completed executor look stuck.

## Goals

1. Preserve the existing free-form task-packet workflow when no plan is in use.
2. When a plan is explicitly in use, align each executor task packet with one native execution unit from that plan.
3. For Superpowers implementation plans, treat one complete `### Task N` section as the execution and review unit; do not split its individual Steps into separate executor packets.
4. Route only mechanically ready work to `executor`.
5. End each standard subagent phase at a top-level asynchronous workflow boundary so the leader receives a completion wake after that subagent finishes.
6. Preserve the mandatory executor-to-reviewer gate and mission-state recovery data across the new workflow boundaries.

## Non-Goals

- Changing model-selection or model-scope policy.
- Fixing pi-subagents process spawning or `resume` failures.
- Building a universal plan parser or a custom dispatcher runtime.
- Editing an existing plan to record runtime decomposition or progress.
- Adding polling, filesystem watchers, completion relays, or new dependencies.
- Changing the agent role definitions beyond wording needed to enforce these two protocol changes.

## Design

### 1. Two task-packet modes

#### General mode

When the leader is not executing an explicit plan file, the existing four-part packet remains authoritative:

- goal;
- constraints;
- relevant files;
- acceptance criteria.

The leader may distill and size the packet using the existing team routing rules. This preserves the plugin's standalone behavior.

#### Plan-aligned mode

Plan-aligned mode is explicit. The leader identifies a plan path and one native execution unit from that plan. The packet records:

- plan path;
- native unit identifier, such as `Task 3`;
- requirements artifact or exact source range for that unit;
- runtime-only context not available when the plan was authored;
- acceptance evidence and report location.

The plan remains read-only. The packet may add current facts such as the base commit, interfaces produced by completed tasks, and recorded controller rulings. It must not replace, broaden, or contradict the selected plan unit.

If the plan format is unknown, the leader supplies the native unit heading or exact range. The team protocol does not infer a new hierarchy and does not silently fall back to a different unit. If no usable unit can be identified, the leader returns to general mode explicitly and owns the resulting packet.

### 2. Superpowers plan alignment

For a plan produced by `superpowers:writing-plans`:

- one complete `### Task N` section is one execution and review unit;
- the Steps inside that Task stay together and run in order;
- the leader uses the `subagent-driven-development` `task-brief PLAN_FILE N` artifact when available;
- the executor reads the task brief, not the entire plan;
- exact values, code, commands, and expected results remain in the brief rather than being rephrased in the dispatch prompt;
- the dispatch adds only project placement, prior-task interfaces, controller rulings, and the report contract.

This follows the native task semantics shared by `executing-plans` and `subagent-driven-development`: review the plan first, execute its tasks in order, follow each task's Steps exactly, and verify before marking the task complete. The task-brief mechanism itself comes from `subagent-driven-development`, not `executing-plans`.

### 3. Mechanical-readiness gate

Before dispatching a plan-aligned unit to `executor`, the leader confirms that the unit supplies:

- exact files or code anchors;
- explicit operations or implementation content;
- concrete verification commands and expected results;
- resolved interfaces and dependencies;
- no unresolved architecture, product, or API choice.

A ready unit becomes one executor packet. A unit that fails this check returns to the leader for a ruling or design clarification; it is not made acceptable by adding open-ended research, broad repository investigation, or extra responsibilities to the executor.

The protocol does not silently create `Task N.a` or `Task N.b`. If an approved plan unit is genuinely unexecutable as written, the leader records the smallest necessary ruling in the plan's existing execution ledger or mission decision state and asks for human input only when the governing execution skill requires it. The original plan file remains unchanged.

### 4. One subagent phase per top-level asynchronous workflow

The standard paired recipe is split at role boundaries.

Initial implementation:

```text
executor workflow
  -> run executor
  -> validate terminal result and retained run id
  -> write lane.phase = implementation-done-pending-review
  -> return and become terminal
  -> leader receives completion wake
```

Review:

```text
leader inspects executor result
  -> reviewer workflow using the same missionId and laneKey
  -> require lane.phase = implementation-done-pending-review
  -> run fresh reviewer
  -> write lane.phase = reviewed
  -> return and become terminal
  -> leader receives completion wake
```

Fix and re-review use the same separation:

```text
resume executor -> fix-done-pending-review -> wake leader
fresh reviewer  -> reviewed                -> wake leader
```

The reviewer gate remains mandatory. The difference is that the leader observes and validates the executor terminal result before launching the reviewer.

### 5. Parallel work

A grouped `runs.all` workflow produces one top-level completion wake, so it cannot promise one wake per completed subagent. Standard team recipes that promise per-subagent notification therefore launch each independent subagent task as its own top-level asynchronous workflow. Each run owns one lane and returns its own receipt. The leader may keep several such runs active concurrently, but does not wrap them in a parent workflow that delays their completion notifications.

Plan-driven implementation remains sequential by default because later plan tasks may consume interfaces produced by earlier tasks. General-mode work may run independent top-level workflows concurrently after the existing conflict check.

### 6. Mission state

The existing lane state remains the recovery source of truth. Workflow splitting changes when state is written, not its meaning.

Required transitions:

```text
executing
  -> implementation-done-pending-review
  -> reviewing
  -> reviewed
  -> accepted | needs-fix
  -> fixing
  -> fix-done-pending-review
  -> reviewing
  -> reviewed
```

Every follow-up workflow receives the same `missionId` and `laneKey`. It verifies the expected prior phase before launching a child. A missing lane, wrong phase, failed child, or missing retained run id terminates that workflow and reports the error to the leader instead of advancing the lane.

### 7. Leader-visible behavior

For a Superpowers plan, the normal sequence becomes:

```text
Task 1 executor completes -> leader wake
Task 1 reviewer completes -> leader wake
Task 1 accepted
Task 2 executor completes -> leader wake
Task 2 reviewer completes -> leader wake
```

The leader does not treat a bounded `subagent_wait` timeout as child failure. Completion wakes and terminal status are authoritative; status inspection is used only when a wake is missing or a run needs attention.

## Files Affected

- `skills/team-orchestration/SKILL.md`
  - distinguish general and plan-aligned task-packet routing;
  - require mechanical-readiness checks;
  - describe per-subagent workflow boundaries and leader wake behavior.
- `skills/team-orchestration/references/task-packets.md`
  - add the plan-aligned packet form;
  - document Superpowers `Task N` and task-brief alignment;
  - keep the existing general, resume, and fallback forms.
- `skills/team-orchestration/references/workflows.md`
  - replace combined executor-plus-reviewer recipes with separate executor and reviewer workflows;
  - split fix and re-review recipes;
  - revise parallel guidance so each independently notified child is a top-level async run.
- `README.md`
  - summarize plan-aware task packets and per-subagent completion notifications.
- `test/team-status/team-orchestration-contract.test.mjs`
  - assert the protocol documents retain the two packet modes, Superpowers task alignment, separate workflow phases, phase guards, and mandatory reviewer gate.

No runtime extension changes or new dependencies are required.

## Testing

1. Add protocol contract tests before editing the protocol documents.
2. Verify the new tests fail because the plan-aligned mode and split recipes are absent.
3. Update the three protocol documents and README minimally.
4. Run the focused contract test until green.
5. Run `npm test` and `npm run typecheck`.
6. Review the document examples for executable `workflowScript` syntax and phase consistency.

## Acceptance Criteria

- General task packets remain supported without a plan.
- Plan-aligned packets identify one native plan unit and preserve it without a second arbitrary slice.
- Superpowers plans map one complete `Task N` to one executor and one task-scoped reviewer.
- Non-mechanical plan units return to the leader rather than expanding executor responsibility.
- The initial executor workflow ends after recording `implementation-done-pending-review`.
- Review runs in a separate top-level async workflow and rejects an unexpected prior phase.
- Fix and re-review are also separate top-level workflows.
- Each standard subagent phase can produce its own completion wake.
- Failed or incomplete executor results cannot advance into review.
- The mandatory reviewer gate and mission recovery fields remain documented and tested.
