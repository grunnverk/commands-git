# @grunnverk/commands-git - Agentic Guide

## Purpose

Git workflow commands for kodrdriv: commit, precommit, clean, review.

## Commands

- `commit` - Create AI-generated commits with agentic workflow
- `precommit` - Pre-commit validation with smart caching
- `clean` - Clean up generated files
- `review` - Review changes and create GitHub issues

## Usage

```typescript
import * as Git from '@grunnverk/commands-git';

// Execute commands with config
await Git.commit(config);
await Git.precommit(config);
await Git.clean(config);
await Git.review(config);
```

## Dependencies

- @grunnverk/core - Shared infrastructure
- @grunnverk/git-tools - Git operations
- @grunnverk/github-tools - GitHub API
- @grunnverk/ai-service - AI/LLM integration
- @grunnverk/shared - Shared utilities

## Package Structure

```
src/
├── commands/
│   ├── commit.ts    # AI-powered commits
│   ├── precommit.ts # Validation checks
│   ├── clean.ts     # Cleanup
│   └── review.ts    # Code review
├── util/
│   ├── precommitOptimizations.ts
│   └── performance.ts
└── index.ts
```

