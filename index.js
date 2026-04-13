// @amql/resolver-npm — Programmatic npm via @npmcli/arborist
//
// Wraps npm's internal libraries to provide the same operations as the CLI
// but as function calls. No exec(), no subprocess, no manual config parsing.
// Arborist handles .npmrc, registries, auth, workspaces — we just pass through.

import { createTag, declare } from "@amql/resolver";
import Arborist from "@npmcli/arborist";

// ── Tags ────────────────────────────────────────────────────────────

const Dependency = createTag({
  version: "",
  type: "prod",
  source: "registry",
  resolved: "",
  integrity: "",
});

const Workspace = createTag({
  version: "",
  path: "",
});

const Script = createTag({
  command: "",
});

// ── API Surface ─────────────────────────────────────────────────────
// Mirrors npm CLI commands. Every option Arborist accepts, we accept.
// We don't parse .npmrc — Arborist does that from the path we give it.

/**
 * Install packages. Equivalent to `npm install <specs>`.
 *
 * Arborist handles .npmrc discovery, registry resolution, auth tokens,
 * scoped registries, and workspace linking from the given path.
 *
 * @param {string} path — project root (Arborist finds .npmrc from here)
 * @param {string[]} specs — package specifiers (e.g., ["lodash@^4", "express"])
 * @param {object} [options] — passed through to Arborist
 * @param {string} [options.saveType] — "prod" | "dev" | "optional" | "peer"
 * @param {boolean} [options.save=true] — update package.json and lockfile
 * @param {boolean} [options.dryRun=false] — compute without writing
 * @param {boolean} [options.saveBundle] — add to bundleDependencies
 * @param {boolean} [options.legacyBundling] — use npm v1/v2 nesting
 * @param {string[]} [options.omit] — dep types to skip: ["dev", "optional"]
 * @param {object} [options.arboristOptions] — raw Arborist constructor overrides
 * @returns {Promise<InstallResult>}
 */
export async function install(path, specs, options = {}) {
  const arb = new Arborist({ path, ...options.arboristOptions });

  const buildOpts = { add: specs };
  if (options.saveType) buildOpts.saveType = options.saveType;
  if (options.saveBundle) buildOpts.saveBundle = options.saveBundle;
  if (options.legacyBundling) buildOpts.legacyBundling = options.legacyBundling;

  await arb.buildIdealTree(buildOpts);

  const reifyOpts = {
    save: options.save !== false,
    dryRun: options.dryRun || false,
  };
  if (options.omit) reifyOpts.omit = options.omit;

  await arb.reify(reifyOpts);

  return summarize(arb, specs);
}

/**
 * Remove packages. Equivalent to `npm uninstall <names>`.
 *
 * @param {string} path
 * @param {string[]} names — package names to remove
 * @param {object} [options]
 * @param {boolean} [options.save=true]
 * @param {boolean} [options.dryRun=false]
 * @param {object} [options.arboristOptions]
 * @returns {Promise<{removed: string[]}>}
 */
export async function remove(path, names, options = {}) {
  const arb = new Arborist({ path, ...options.arboristOptions });

  await arb.buildIdealTree({ rm: names });
  await arb.reify({
    save: options.save !== false,
    dryRun: options.dryRun || false,
  });

  return { removed: names };
}

/**
 * Update packages. Equivalent to `npm update [names]`.
 *
 * @param {string} path
 * @param {string[]} [names] — specific packages (empty = all)
 * @param {object} [options]
 * @param {boolean} [options.save=true]
 * @param {boolean} [options.dryRun=false]
 * @param {object} [options.arboristOptions]
 * @returns {Promise<void>}
 */
export async function update(path, names = [], options = {}) {
  const arb = new Arborist({ path, ...options.arboristOptions });

  const updateOpt = names.length > 0 ? { names } : true;
  await arb.buildIdealTree({ update: updateOpt });
  await arb.reify({
    save: options.save !== false,
    dryRun: options.dryRun || false,
  });
}

/**
 * List dependency tree. Equivalent to `npm ls`.
 *
 * @param {string} path
 * @param {object} [options]
 * @param {boolean} [options.all=false] — include transitive deps
 * @param {object} [options.arboristOptions]
 * @returns {Promise<TreeNode>}
 */
export async function list(path, options = {}) {
  const arb = new Arborist({ path, ...options.arboristOptions });
  const tree = await arb.loadActual();
  return nodeToTree(tree, options.all ? Infinity : 1);
}

/**
 * Audit for vulnerabilities. Equivalent to `npm audit`.
 *
 * @param {string} path
 * @param {object} [options]
 * @param {boolean} [options.fix=false] — apply fixes
 * @param {object} [options.arboristOptions]
 * @returns {Promise<AuditResult>}
 */
export async function audit(path, options = {}) {
  const arb = new Arborist({ path, ...options.arboristOptions });
  return arb.audit({ fix: options.fix || false });
}

/**
 * Load the virtual tree from lockfile. Equivalent to reading
 * package-lock.json with full resolution.
 *
 * @param {string} path
 * @param {object} [options]
 * @param {object} [options.arboristOptions]
 * @returns {Promise<TreeNode>}
 */
export async function loadLockfile(path, options = {}) {
  const arb = new Arborist({ path, ...options.arboristOptions });
  const tree = await arb.loadVirtual();
  return nodeToTree(tree, Infinity);
}

/**
 * Load the actual tree from node_modules. Reads what's on disk.
 *
 * @param {string} path
 * @param {object} [options]
 * @param {object} [options.arboristOptions]
 * @returns {Promise<TreeNode>}
 */
export async function loadActual(path, options = {}) {
  const arb = new Arborist({ path, ...options.arboristOptions });
  const tree = await arb.loadActual();
  return nodeToTree(tree, Infinity);
}

// ── Helpers ─────────────────────────────────────────────────────────

function summarize(arb, specs) {
  const result = { added: [] };
  for (const spec of specs) {
    // Handle scoped packages: @scope/name@version → @scope/name
    const name = spec.replace(/@[^@/]*$/, "");
    const node = arb.idealTree?.children?.get(name);
    result.added.push({
      name: node?.name || name,
      version: node?.version || "",
      resolved: node?.resolved || "",
      integrity: node?.integrity || "",
    });
  }
  return result;
}

function nodeToTree(node, depth, seen = new Set()) {
  if (!node || depth < 0) return null;
  if (seen.has(node.path)) {
    return { name: node.name, version: node.version, circular: true };
  }
  seen.add(node.path);

  const children = [];
  if (node.children && depth > 0) {
    for (const [, child] of node.children) {
      const c = nodeToTree(child, depth - 1, seen);
      if (c) children.push(c);
    }
  }

  return {
    name: node.name || "",
    version: node.version || "",
    resolved: node.resolved || "",
    path: node.path || "",
    dev: node.dev || false,
    optional: node.optional || false,
    peer: node.peer || false,
    children,
  };
}

// ── AMQL Resolver ───────────────────────────────────────────────────
// Scans package.json files and emits Dependency, Workspace, Script
// annotations for structural querying.

declare({
  name: "npm",
  version: 1,
  filePatterns: ["**/package.json"],

  setup({ on, log }) {
    on("*", (ctx) => {
      let pkg;
      try {
        pkg = JSON.parse(ctx.source);
      } catch (e) {
        log.warn(`Failed to parse ${ctx.file}: ${e.message}`);
        return [];
      }

      // Skip node_modules
      if (ctx.file.includes("node_modules")) return [];

      const nodes = [];

      // Dependencies
      for (const [section, type] of [
        ["dependencies", "prod"],
        ["devDependencies", "dev"],
        ["optionalDependencies", "optional"],
        ["peerDependencies", "peer"],
      ]) {
        const deps = pkg[section];
        if (!deps) continue;
        for (const [name, version] of Object.entries(deps)) {
          const source = version.startsWith("file:")
            ? "file"
            : version.startsWith("git") || version.includes("github:")
              ? "git"
              : version.startsWith("workspace:")
                ? "workspace"
                : "registry";
          nodes.push(Dependency({ name, version: String(version), type, source }));
        }
      }

      // Workspaces (both array and object forms)
      const workspaces = Array.isArray(pkg.workspaces)
        ? pkg.workspaces
        : pkg.workspaces?.packages || [];
      for (const pattern of workspaces) {
        nodes.push(Workspace({ name: pattern, path: pattern }));
      }

      // Scripts
      if (pkg.scripts) {
        for (const [name, command] of Object.entries(pkg.scripts)) {
          nodes.push(Script({ name, command: String(command) }));
        }
      }

      return nodes;
    });
  },
});
