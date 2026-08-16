# Issue 186 remote tmux bootstrap plan

| Obligation | Slice | State | Proof |
| --- | --- | --- | --- |
| AC1: probe reports a usable tmux path and version | preset bootstrap probe | in-progress | pending TDD proof |
| AC2, AC3: ordered PM detection and root / `sudo -n` / brew install policy | package and privilege resolution | todo | pending TDD proof |
| AC4: successful install re-probes and discloses host mutation | install success | todo | pending TDD proof |
| AC5, AC6: all closed outcomes provide host-scoped install and verify guidance, including probe-only mode | operator guidance | todo | pending TDD proof |
| AC7: bootstrap has an enforced whole-operation timeout | bounded external runner | todo | pending TDD proof |
| AC8: every scenario uses the preset seam's fake external runner | seam-level scenario matrix | todo | pending TDD proof |
| Coverage and close-out gates | generated evidence and PR contract | todo | pending final HEAD |
