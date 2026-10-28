# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Wayfinder labels

`/wayfinder` reads and writes a fixed label set, separate from the triage roles:

| Label               | Repo label            | Use                                        |
| ------------------- | --------------------- | ------------------------------------------ |
| map                 | `wayfinder:map`       | The single map issue for an effort         |
| research            | `wayfinder:research`  | Ticket type: investigate against sources   |
| prototype           | `wayfinder:prototype` | Ticket type: build to answer a design question |
| grilling            | `wayfinder:grilling`  | Ticket type: open decision/discussion      |
| task                | `wayfinder:task`      | Ticket type: concrete implementation work  |
