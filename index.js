// @amql/resolver-npm — Programmatic npm via the user's installed Arborist
//
// Uses the SAME @npmcli/arborist that ships with the user's npm installation.
// No bundled npm version — whatever npm the user has, that's what we use.
// Arborist handles .npmrc, registries, auth, workspaces internally.

import { createTag, declare } from "@amql/resolver";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";

// ── Resolve the user's Arborist ─────────────────────────────────────

let _Arborist;

/**
 * Dynamically load @npmcli/arborist from the user's npm installation.
 * This ensures we use the exact same version npm uses — no version mismatch,
 * no bundled copy, no divergent behavior.
 */
function getArborist() {
  if (_Arborist) return _Arborist;

  const npmBin = execSync("which npm", { encoding: "utf8" }).trim();
  const npmPrefix = dirname(dirname(npmBin));
  const npmModules = join(npmPrefix, "lib/node_modules/npm/node_modules");
  const npmRequire = createRequire(npmModules + "/");

  try {
    _Arborist = npmRequire("@npmcli/arborist");
  } catch {
    throw new Error(
      "Could not find @npmcli/arborist in your npm installation. " +
        "Ensure npm is installed and accessible via PATH.",
    );
  }

  return _Arborist;
}

// ── Tags ────────────────────────────────────────────────────────────

const Dependency = createTag({
  version: "",
  type: "prod",
  source: "registry",
  resolved: "",
  integrity: "",
});

const Workspace = createTag({ version: "", path: "" });

const Script = createTag({ command: "" });

// ── API ─────────────────────────────────────────────────────────────

export async function install(path, specs, options = {}) {
  const Arborist = getArborist();
  const arb = new Arborist({ path, ...options.arboristOptions });

  const buildOpts = { add: specs };
  if (options.saveType) buildOpts.saveType = options.saveType;
  if (options.saveBundle) buildOpts.saveBundle = options.saveBundle;
  if (options.legacyBundling) buildOpts.legacyBundling = options.legacyBundling;

  await arb.buildIdealTree(buildOpts);
  await arb.reify({
    save: options.save !== false,
    dryRun: options.dryRun || false,
    ...(options.omit ? { omit: options.omit } : {}),
  });

  return summarize(arb, specs);
}

export async function remove(path, names, options = {}) {
  const Arborist = getArborist();
  const arb = new Arborist({ path, ...options.arboristOptions });
  await arb.buildIdealTree({ rm: names });
  await arb.reify({ save: options.save !== false, dryRun: options.dryRun || false });
  return { removed: names };
}

export async function update(path, names = [], options = {}) {
  const Arborist = getArborist();
  const arb = new Arborist({ path, ...options.arboristOptions });
  await arb.buildIdealTree({ update: names.length > 0 ? { names } : true });
  await arb.reify({ save: options.save !== false, dryRun: options.dryRun || false });
}

export async function list(path, options = {}) {
  const Arborist = getArborist();
  const arb = new Arborist({ path, ...options.arboristOptions });
  return nodeToTree(await arb.loadActual(), options.all ? Infinity : 1);
}

export async function audit(path, options = {}) {
  const Arborist = getArborist();
  const arb = new Arborist({ path, ...options.arboristOptions });
  return arb.audit({ fix: options.fix || false });
}

export async function loadLockfile(path, options = {}) {
  const Arborist = getArborist();
  const arb = new Arborist({ path, ...options.arboristOptions });
  return nodeToTree(await arb.loadVirtual(), Infinity);
}

export async function loadActual(path, options = {}) {
  const Arborist = getArborist();
  const arb = new Arborist({ path, ...options.arboristOptions });
  return nodeToTree(await arb.loadActual(), Infinity);
}

// ── Helpers ─────────────────────────────────────────────────────────

function summarize(arb, specs) {
  return {
    added: specs.map((spec) => {
      const name = spec.replace(/@[^@/]*$/, "");
      const node = arb.idealTree?.children?.get(name);
      return {
        name: node?.name || name,
        version: node?.version || "",
        resolved: node?.resolved || "",
        integrity: node?.integrity || "",
      };
    }),
  };
}

function nodeToTree(node, depth, seen = new Set()) {
  if (!node || depth < 0) return null;
  if (seen.has(node.path)) return { name: node.name, version: node.version, circular: true };
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

// ── Resolver ────────────────────────────────────────────────────────

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

      if (ctx.file.includes("node_modules")) return [];

      const nodes = [];

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

      const workspaces = Array.isArray(pkg.workspaces)
        ? pkg.workspaces
        : pkg.workspaces?.packages || [];
      for (const pattern of workspaces) {
        nodes.push(Workspace({ name: pattern, path: pattern }));
      }

      if (pkg.scripts) {
        for (const [name, command] of Object.entries(pkg.scripts)) {
          nodes.push(Script({ name, command: String(command) }));
        }
      }

      return nodes;
    });
  },
});
