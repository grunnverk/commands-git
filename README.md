# @eldrforge/commands-git

Git workflow commands for kodrdriv.

## Installation

```bash
npm install @eldrforge/commands-git
```

## Usage

```typescript
import * as Git from '@eldrforge/commands-git';

// Commit with AI-generated message
await Git.commit(config);

// Run precommit checks
await Git.precommit(config);

// Clean output directory
await Git.clean(config);

// Review changes and create issues
await Git.review(config);
```

## Commands

### commit
Creates AI-generated commit messages with optional agentic workflow:
- Analyzes staged changes (diff, log, file content)
- Generates conventional commit messages
- Supports commit splitting for large changes
- Interactive mode for editing

### precommit
Runs precommit validation checks:
- Lint
- Build
- Test
- Smart caching to skip unchanged tests

### clean
Removes output/generated files.

### review
Reviews code changes and creates GitHub issues:
- Analyzes diffs and commit history
- Creates structured issues from review notes
- Supports batch processing of review files

## Documentation

For AI agents and developers:
- [Agentic Guide](./guide/index.md) - Start here for AI-assisted development

## License

Apache-2.0

