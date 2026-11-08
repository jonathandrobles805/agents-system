# 0003 Agents communicate through files, never shared conversation

Date: 2026-11-08

## Context
Reviewer anchored on builder reasoning, planners inheriting unverified beliefs, and lost context after compaction all come from agents sharing a conversation.

## Decision
Each agent reads and writes fixed files in fixed templates. The reviewer never sees the implementer's conversation. Progress, logs, and events are files so a fresh session can resume.

## Alternatives rejected
- One long orchestrating conversation: context loss, anchoring, nothing auditable.

## Consequences
Templates and validate-docs are load-bearing. The dashboard is a view over the same files.
