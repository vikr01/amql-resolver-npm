// @amql/resolver-npm — Programmatic npm package management via @npmcli/arborist
//
// This resolver wraps npm's internal Arborist library to provide transactional
// package operations (install, remove, update) without shelling out to the CLI.
// All operations respect .npmrc, scoped registries, and workspace configurations.

import { createTag, declare, Fragment } from "@amql/resolver";
import Arborist from "@npmcli/arborist";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

// ── Tags ────────────────────────────────────────────────────────────

const Dependency = createTag({
  name: "",
  version: "",
  resolved: "",
  integrity: "",
  type: "prod",       // prod | dev | optional | peer
  source: "registry", // registry | git | file | workspace
});

const Workspace = createTag({
  name: "",
  version: "",
  path: "",
});

const Script = createTag({
  name: "",
  command: "",
});

// ── Arborist Wrapper ────────────────────────────────────────────────

/**
 * Load .npmrc configuration from the project root.
 * Arborist reads .npmrc automatically when given a path, but we extract
 * registry/auth settings for visibility and annotation.
 */
function loadNpmConfig(projectRoot) {
  const npmrcPath = join(projectRoot, ".npmrc");
  const config = {};

  if (existsSync(npmrcPath)) {
    const raw = readFileSync(npmrcPath, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        config[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
      }
    }
  }

  return config;
}

/**
 * Create an Arborist instance configured for the given project.
 * Respects .npmrc for registries, auth tokens, and scoped configs.
 */
function createArborist(projectRoot) {
  const config = loadNpmConfig(projectRoot);

  const opts = {
    path: projectRoot,
  };

  // Pass through registry and scoped registry settings
  if (config.registry) {
    opts.registry = config.registry;
  }
  for (const [key, val] of Object.entries(config)) {
    if (key.startsWith("@") && key.endsWith(":registry")) {
      opts[key] = val;
    }
    // Pass auth tokens for scoped registries
    if (key.includes(":_authToken") || key.includes(":_auth")) {
      opts[key] = val;
    }
  }

  return new Arborist(opts);
}

/**
 * Install one or more packages. Transactional: if any package fails to
 * resolve, none are written.
 *
 * @param {string} projectRoot — absolute path to project
 * @param {string[]} specs — package specifiers (e.g., ["lodash@^4", "express"])
 * @param {object} options
 * @param {string} options.type — "prod" | "dev" | "optional" | "peer"
 * @param {boolean} options.dryRun — compute changes without writing
 * @returns {Promise<{added: object[], updated: object[]}>}
 */
export async function install(projectRoot, specs, options = {}) {
  const arb = createArborist(projectRoot);
  const saveType = options.type || "prod";

  // Phase 1: build ideal tree (resolve all dependencies)
  // If ANY spec fails to resolve, this throws — nothing is written
  await arb.buildIdealTree({
    add: specs,
    saveType,
  });

  if (options.dryRun) {
    return { dryRun: true, idealTree: arb.idealTree };
  }

  // Phase 2: reify (write package.json, package-lock.json, node_modules)
  // Atomic: package.json and lockfile are written together
  await arb.reify({ save: true });

  return {
    added: specs.map((spec) => {
      const name = spec.split("@")[0] || spec;
      const node = arb.idealTree.children.get(name);
      return {
        name: node?.name || name,
        version: node?.version || "unknown",
        resolved: node?.resolved || "",
        integrity: node?.integrity || "",
      };
    }),
  };
}

/**
 * Remove one or more packages. Transactional.
 *
 * @param {string} projectRoot
 * @param {string[]} names — package names to remove
 * @returns {Promise<{removed: string[]}>}
 */
export async function remove(projectRoot, names) {
  const arb = createArborist(projectRoot);

  await arb.buildIdealTree({ rm: names });
  await arb.reify({ save: true });

  return { removed: names };
}

/**
 * Update one or more packages (or all if names is empty).
 *
 * @param {string} projectRoot
 * @param {string[]} names — specific packages to update (empty = all)
 * @returns {Promise<void>}
 */
export async function update(projectRoot, names = []) {
  const arb = createArborist(projectRoot);

  const updateOpts = names.length > 0 ? { names } : true;
  await arb.buildIdealTree({ update: updateOpts });
  await arb.reify({ save: true });
}

// ── AMQL Resolver ───────────────────────────────────────────────────

declare({
  name: "npm",
  version: 1,
  filePatterns: ["package.json"],

  setup({ on, log, meta }) {
    on("*", (ctx) => {
      // Parse the package.json
      let pkg;
      try {
        pkg = JSON.parse(ctx.source);
      } catch (e) {
        log.error(`Failed to parse package.json: ${e.message}`);
        return [];
      }

      const nodes = [];

      // Emit Dependency annotations for each dependency
      const depSections = [
        ["dependencies", "prod"],
        ["devDependencies", "dev"],
        ["optionalDependencies", "optional"],
        ["peerDependencies", "peer"],
      ];

      for (const [section, type] of depSections) {
        const deps = pkg[section];
        if (!deps) continue;

        for (const [name, version] of Object.entries(deps)) {
          const source = version.startsWith("file:")
            ? "file"
            : version.startsWith("git")
              ? "git"
              : version.startsWith("workspace:")
                ? "workspace"
                : "registry";

          nodes.push(
            Dependency({
              name,
              version: String(version),
              type,
              source,
            }),
          );
        }
      }

      // Emit Workspace annotations
      const workspaces = pkg.workspaces;
      if (Array.isArray(workspaces)) {
        for (const pattern of workspaces) {
          nodes.push(Workspace({ name: pattern, path: pattern }));
        }
      }

      // Emit Script annotations
      const scripts = pkg.scripts;
      if (scripts && typeof scripts === "object") {
        for (const [name, command] of Object.entries(scripts)) {
          nodes.push(Script({ name, command: String(command) }));
        }
      }

      return nodes;
    });
  },
});
