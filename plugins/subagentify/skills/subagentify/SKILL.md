---
name: subagentify
description: Use when planning or breaking down multi-step work, in plan mode or not. Explains how to split the work into independent units and run each in an Opus or Sonnet subagent with an explicit model.
---

# Plan in subagents

Whenever you plan, split the work into independent units and run each unit in a subagent with an explicit `model`. State the chosen model next to each step of the plan. The main thread integrates, reviews and verifies; it does not do the units itself.

## Opus or Sonnet

| Model | Use for | Examples |
| --- | --- | --- |
| opus | Judgment, ambiguity, high cost of a wrong call | Designing a module boundary; debugging a failure with no clear cause; a security review; a refactor that crosses many files and needs a consistent decision |
| sonnet | The task is specified well enough that the result can be checked | Implementing a function from a signature and behaviour; writing tests for known behaviour; docs and README edits; renaming or mechanical edits; searching the codebase and reporting what is where |

Never use haiku for delegated work. When unsure, pick sonnet for the doing and opus for the deciding: if a step needs a decision the plan does not already contain, it is an opus step.

## Writing a subagent prompt

A subagent starts with no context. Make the prompt self-contained:

- Goal: what done looks like, in one or two sentences.
- Paths: the files and folders to read and the ones it may change. Say which it must not touch.
- Constraints: style, APIs to use, things to avoid, whether it may run commands or git.
- Return: what to report back (files changed, test result, open questions), kept short.

## Parallel or sequential

Run units in parallel when they touch different files and none needs another's output: send the Agent calls in one message. Run them in sequence when a later unit consumes an earlier result (design, then implementation). Never give two parallel subagents the same file.

## The main thread's duty

When subagents return, read what they changed rather than their summary alone. Integrate the pieces, resolve conflicts between them, run the tests and the build, and send a failing unit back with a precise correction. The task is done when the main thread has verified it, not when the subagents say so.
