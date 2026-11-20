---
name: context-handoff
description: Hand the current work off to a fresh Claude Code session through a self-contained handoff file. Use when the context window is filling up, when the context-handoff plugin asks for a handoff, or when the user asks to hand off, start over in a fresh session, or continue in a new session.
---

# Context handoff

A handoff moves the work to a new session that has none of this conversation.
The only thing it receives is the handoff file, so the file must stand on its own.

## 1. Write the handoff file

Path: the one the plugin gave you, or `~/.claude/handoffs/<yyyy-mm-dd-hhmm>-<first 8 chars of the session id>.md`.
Create the folder if needed. Use these sections, in this order:

- **Goal**: what the user wants in the end, in their terms.
- **Done so far**: what is finished and verified.
- **In progress (exact state)**: the half-done step, precisely: which file, which function, what is edited and what is not.
- **Next steps (ordered)**: numbered, concrete actions.
- **Key files and paths**: absolute paths, with one line on why each matters.
- **Decisions and constraints**: choices made and why, things ruled out, and every user preference stated this session.
- **Open questions**: what is still undecided or needs the user.
- **How to verify**: exact commands (tests, builds, checks) and what passing looks like.
- **Repo/branch/worktree**: repository path, branch, worktree, uncommitted changes, open PRs.

Rules:

- Self-contained: no "as discussed", "above" or "earlier"; spell out names, paths and commands.
- Absolute paths and exact commands, never paraphrases.
- No secrets (tokens, passwords) in the file.

## 2. Launch the new session

Call the `context_handoff` tool (`mcp__context-handoff__context_handoff`):

- `{"action": "launch", "file": "<absolute path>"}`: checks the file exists and is not trivially short,
  then starts a new session on the same model with the configured permission mode, prompted to
  continue from the file. When it succeeds, stop working: say in one line that the work continues in
  the new session. When it cannot launch (not Windows, launching off, or the launch failed), it returns
  a command: give it to the user as is. The file is kept in that case.
- `{"action": "status"}`: phase, threshold, current context fill and the file.
- `{"action": "cancel"}`: stops an automatic handoff; no new trigger until the context falls below the
  threshold (for example after a compaction).

The person can do the same with `/context-handoff status | now | cancel`.

## 3. The receiving session

The new session is told: read the handoff file first, then delete it, then continue. Reading it and
then deleting it is the receiving session's job, so do not delete the file yourself before launching.
