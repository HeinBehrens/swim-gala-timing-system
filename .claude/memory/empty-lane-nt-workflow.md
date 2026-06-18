---
name: empty-lane-nt-workflow
description: "Empty/no-swimmer lanes are handled by manual Stop → NT, NOT by roster-based auto-exclusion (that approach was considered and dropped)"
metadata: 
  node_type: memory
  type: project
  originSessionId: e6f94727-50d5-46b6-8867-fb4f1c1c9210
---

Decision (2026-06-05): lanes with no swimmer for a heat are handled by the operator
**manually pressing Stop on the control panel**, which finalizes the race and renders
every lane without a recorded finish as **NT** (No Time). This is the intended
race-day workflow.

We explicitly considered and **dropped** a server-side feature to auto-detect
occupied lanes from the imported heat roster and exclude empty lanes from timing /
auto-completion. Don't re-propose it unless asked.

Already works end-to-end, no code change was needed:
- Stop → `race.stop()` sets state `completed`, then `settleCompletion()` broadcasts it ([src/server.ts] ~628/369).
- Dashboard `updateResults()` marks any `!laneFinished[i]` lane as NT on the lane card
  (`setLaneStatus(i,'nt')`) and in the results table ([static/app.js] ~976-1002).

Context: swimmer-per-lane comes from the imported roster (key `event-heat-lane`), see
[[results-publishing]] / [[server-ts-not-built]]. The all-6-lanes auto-complete in
RaceManager only fires if every lane presses; manual Stop is the normal finalize path.
