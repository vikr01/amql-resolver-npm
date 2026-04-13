# @amql/resolver-npm

AMQL resolver for npm package management. Wraps `@npmcli/arborist` (npm's internal dependency manager) for programmatic, transactional package operations — no `exec()`, no CLI shelling.

## What it does

### As an AMQL resolver
Scans `package.json` and emits structured annotations:

```xml
<Dependency name="express" version="^4.18.0" type="prod" source="registry" />
<Dependency name="lodash" version="^4.17.21" type="dev" source="registry" />
<Workspace name="packages/*" path="packages/*" />
<Script name="build" command="tsc --noEmit" />
```

Query your dependencies:
```bash
amql select "Dependency[type='dev']"
amql select "Dependency[source='git']"
amql select "Script[name='test']"
```

### As a programmatic API
Install, remove, and update packages without the npm CLI:

```javascript
import { install, remove, update } from "@amql/resolver-npm";

// Install — respects .npmrc, scoped registries, auth tokens
// Transactional: if express fails to resolve, lodash isn't added either
await install("/path/to/project", ["express@^4", "lodash"], { type: "prod" });

// Remove
await remove("/path/to/project", ["old-package"]);

// Update all
await update("/path/to/project");

// Update specific
await update("/path/to/project", ["express"]);

// Dry run — compute changes without writing
const preview = await install("/path/to/project", ["new-pkg"], { dryRun: true });
```

## How it works

Uses `@npmcli/arborist` — the same library npm uses internally:

1. **`buildIdealTree({ add: specs })`** — resolves all dependencies, respects .npmrc registries and auth. If ANY package fails to resolve, throws immediately — nothing is written.
2. **`reify({ save: true })`** — atomically writes `package.json`, `package-lock.json`, and `node_modules`.

No `child_process.exec("npm install")`. No subprocess. Pure library calls.

## .npmrc support

The resolver reads `.npmrc` from the project root and passes configuration to Arborist:

```ini
# .npmrc
registry=https://custom.registry.com/
@myorg:registry=https://myorg.registry.com/
//myorg.registry.com/:_authToken=npm_xxx
```

Scoped registries, auth tokens, and all standard npm configuration is respected.

## Tags

| Tag | Attributes | Description |
|-----|-----------|-------------|
| `Dependency` | `name`, `version`, `type` (prod/dev/optional/peer), `source` (registry/git/file/workspace), `resolved`, `integrity` | A package dependency |
| `Workspace` | `name`, `path` | A workspace pattern from the `workspaces` field |
| `Script` | `name`, `command` | A script from the `scripts` field |

## Install

```bash
npm install @amql/resolver-npm
```
