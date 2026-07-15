# OpenSpec Instructions

This directory follows the [OpenSpec](https://github.com/Fission-AI/OpenSpec) spec-driven workflow. Read this before creating or modifying anything under `plan/`.

## Directory layout

```
plan/
├── project.md          # Project-wide context: stack, conventions, external systems
├── AGENTS.md           # This file
├── specs/              # Source of truth for what IS built (deployed capabilities)
│   └── <capability>/spec.md
└── changes/            # Proposals for what SHOULD change (not yet built)
    └── <change-id>/
        ├── proposal.md # Why, what changes, impact
        ├── design.md   # Technical decisions (only when cross-cutting/complex)
        ├── tasks.md    # Implementation checklist, grouped, in dependency order
        └── specs/      # Spec deltas per capability
            └── <capability>/spec.md
```

## Rules

1. **`specs/` describes the present.** Nothing is deployed yet, so top-level `specs/` starts empty. When a change ships and is verified, its deltas are merged into `specs/<capability>/spec.md` and the change folder is archived to `changes/archive/`.
2. **`changes/` describes the future.** Every unit of work is a change folder. Changes here are ordered by numeric prefix (`01-`, `02-`, …) matching the product phases; a change must not start until the previous one is deployed and stable.
3. **Spec delta format.** Delta files use `## ADDED Requirements`, `## MODIFIED Requirements`, `## REMOVED Requirements` sections. Each requirement uses SHALL language and carries at least one scenario:

   ```markdown
   ### Requirement: Inbox deduplication
   The system SHALL ignore inbound payloads whose (channel_instance_id, channel_message_id) already exists.

   #### Scenario: Duplicate delivery
   - **WHEN** an ingestion worker submits a payload that already exists in agent_inbox
   - **THEN** the payload is discarded and no new inbox row is created
   ```

4. **Tasks are the contract for implementation.** Work through `tasks.md` top to bottom, checking items off (`- [x]`) as they are completed and verified.
5. **Architecture invariants live in `design.md` of change `01-…` and in `project.md`.** Core code never imports adapter code; every external system sits behind a port interface. Any new change that would violate this needs an explicit decision recorded in its own `design.md`.
6. **Workflow diagrams use mermaid**, per the owner's global conventions.
