import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import ts from "typescript";
import {
  NON_RESOURCE_COMMANDS,
  REQUIRED_RESOURCE_ACTION_SURFACES,
  RETIRED_RESOURCE_ACTION_RESIDUE,
} from "../e2e/resourceActionProductOracle.ts";

const APP_ROOT = join(import.meta.dir, "..");

function fail(message) {
  throw new Error(`resource-action-surface-policy: ${message}`);
}

function parseText(relativePath, text) {
  const scriptKind = relativePath.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
  return {
    relativePath,
    text,
    sourceFile: ts.createSourceFile(
      relativePath,
      text,
      ts.ScriptTarget.Latest,
      true,
      scriptKind,
    ),
  };
}

function parse(relativePath) {
  return parseText(
    relativePath,
    readFileSync(join(APP_ROOT, relativePath), "utf8"),
  );
}

function visit(node, visitor) {
  visitor(node);
  ts.forEachChild(node, (child) => visit(child, visitor));
}

function importedNames(parsed, moduleName, importedName) {
  const names = new Set();
  for (const statement of parsed.sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== moduleName ||
      !statement.importClause
    ) {
      continue;
    }
    if (importedName === "default" && statement.importClause.name) {
      names.add(statement.importClause.name.text);
    }
    const bindings = statement.importClause.namedBindings;
    if (importedName !== "default" && bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (
          (element.propertyName?.text ?? element.name.text) === importedName
        ) {
          names.add(element.name.text);
        }
      }
    }
  }
  return names;
}

function moduleMatchesTarget(relativePath, moduleName, alias, targetPath) {
  if (moduleName === alias) return true;
  if (!moduleName.startsWith(".")) return false;
  const resolved = normalize(join(dirname(relativePath), moduleName)).replaceAll(
    "\\",
    "/",
  );
  return resolved === targetPath || resolved === `${targetPath}.tsx`;
}

function importedBindingsForTarget(
  parsed,
  { alias, targetPath, importedName },
) {
  const names = new Set();
  const namespaces = new Set();
  for (const statement of parsed.sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.importClause ||
      !moduleMatchesTarget(
        parsed.relativePath,
        statement.moduleSpecifier.text,
        alias,
        targetPath,
      )
    ) {
      continue;
    }
    if (importedName === "default" && statement.importClause.name) {
      names.add(statement.importClause.name.text);
    }
    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    if (importedName !== "default" && bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if ((element.propertyName?.text ?? element.name.text) === importedName) {
          names.add(element.name.text);
        }
      }
    }
  }
  return { names, namespaces };
}

function hasJsxAttribute(attributes, attributeName) {
  return attributes.properties.some(
    (property) =>
      ts.isJsxAttribute(property) && property.name.getText() === attributeName,
  );
}

function assertRendersImportedComponent({
  path,
  moduleName,
  importedName = "default",
  requiredAttribute,
}) {
  const parsed = parse(path);
  const names = importedNames(parsed, moduleName, importedName);
  if (names.size === 0) {
    fail(
      `${path} must import ${importedName} from ${moduleName}; the canonical consumer boundary is missing.`,
    );
  }
  let renders = 0;
  visit(parsed.sourceFile, (node) => {
    if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) {
      return;
    }
    if (
      ts.isIdentifier(node.tagName) &&
      names.has(node.tagName.text) &&
      (!requiredAttribute ||
        hasJsxAttribute(node.attributes, requiredAttribute))
    ) {
      renders += 1;
    }
  });
  if (renders === 0) {
    fail(
      `${path} imports ${moduleName} but does not render it${
        requiredAttribute ? ` with ${requiredAttribute}` : ""
      }; the surface is not connected to the canonical consumer.`,
    );
  }
}

function assertCanonicalMenu(path) {
  assertRendersImportedComponent({
    path,
    moduleName: "@/components/resources/ResourceActionMenu",
    requiredAttribute: "actionSubject",
  });
}

function assertCanonicalMenuVariant(path, { requiredLabel, forbiddenLabel = [] }) {
  const parsed = parse(path);
  const names = importedNames(
    parsed,
    "@/components/resources/ResourceActionMenu",
    "default",
  );
  const labels = [];
  visit(parsed.sourceFile, (node) => {
    if (
      (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) ||
      !ts.isIdentifier(node.tagName) ||
      !names.has(node.tagName.text) ||
      !hasJsxAttribute(node.attributes, "actionSubject")
    ) {
      return;
    }
    const label = node.attributes.properties.find(
      (property) =>
        ts.isJsxAttribute(property) && property.name.getText() === "label",
    );
    labels.push(
      label && ts.isJsxAttribute(label) && label.initializer
        ? label.initializer.getText(parsed.sourceFile)
        : "",
    );
  });
  const matching = labels.filter(
    (label) =>
      requiredLabel.every((fragment) => label.includes(fragment)) &&
      forbiddenLabel.every((fragment) => !label.includes(fragment)),
  );
  if (matching.length !== 1) {
    fail(
      `${path} must render exactly one canonical variant with label fragments ${JSON.stringify(
        requiredLabel,
      )} and without ${JSON.stringify(forbiddenLabel)}; observed labels=${JSON.stringify(
        labels,
      )}.`,
    );
  }
}

function assertCanonicalModel(path) {
  const parsed = parse(path);
  const names = importedNames(
    parsed,
    "@/lib/actions/resourceActionRuntime",
    "useResourceActionMenuModel",
  );
  if (names.size === 0) {
    fail(
      `${path} must import useResourceActionMenuModel from the canonical runtime.`,
    );
  }
  let calls = 0;
  visit(parsed.sourceFile, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      names.has(node.expression.text) &&
      node.arguments.length === 1
    ) {
      calls += 1;
    }
  });
  if (calls === 0) {
    fail(
      `${path} imports useResourceActionMenuModel but does not resolve exactly one subject through it.`,
    );
  }
}

function actionSubjectInitializers(path) {
  const parsed = parse(path);
  const initializers = [];
  visit(parsed.sourceFile, (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(parsed.sourceFile) === "actionSubject"
    ) {
      initializers.push(node.initializer.getText(parsed.sourceFile));
    }
  });
  return initializers;
}

function assertPublishesSubject(path, requiredFragments) {
  const initializers = actionSubjectInitializers(path);
  const matching = initializers.find((initializer) =>
    requiredFragments.every((fragment) => initializer.includes(fragment)),
  );
  if (!matching) {
    fail(
      `${path} must publish actionSubject containing ${requiredFragments.join(
        " + ",
      )}; observed initializers=${JSON.stringify(initializers)}.`,
    );
  }
}

function assertNoJsxAttribute(path, moduleName, attributeName) {
  const parsed = parse(path);
  const names = importedNames(parsed, moduleName, "default");
  if (names.size === 0) {
    fail(`${path} no longer imports ${moduleName}; update the surface proof.`);
  }
  let prohibited = 0;
  visit(parsed.sourceFile, (node) => {
    if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) {
      return;
    }
    if (
      ts.isIdentifier(node.tagName) &&
      names.has(node.tagName.text) &&
      hasJsxAttribute(node.attributes, attributeName)
    ) {
      prohibited += 1;
    }
  });
  if (prohibited > 0) {
    fail(
      `${path} must not set ${attributeName} on ${moduleName}; location cannot suppress a canonical resource trigger.`,
    );
  }
}

function assertRowHub() {
  assertCanonicalMenu("src/components/collections/CollectionRow.tsx");
  const view = parse("src/components/collections/CollectionView.tsx");
  if (!view.text.includes("rowActionsAvailable = true")) {
    fail(
      "CollectionView must default rowActionsAvailable to true so a publisher's actionSubject reaches CollectionRow.",
    );
  }
}

function proveBrowseAcquiredRow() {
  assertPublishesSubject("src/lib/collections/presenters/browse.ts", [
    'candidate.resolution.kind === "InNexus"',
    "candidate.resolution.actionSubject",
  ]);
  assertNoJsxAttribute(
    "src/components/browse/BrowseSection.tsx",
    "@/components/collections/CollectionView",
    "rowActionsAvailable",
  );
}

function proveSearchResultRow() {
  assertPublishesSubject("src/lib/search/searchViewModel.ts", [
    "result.actionSubject",
  ]);
  assertPublishesSubject("src/lib/collections/presenters/search.ts", [
    "vm.actionSubject",
  ]);
}

const rowProofs = {
  "browse-acquired-row": proveBrowseAcquiredRow,
  "search-result-row": proveSearchResultRow,
  "library-item-row": () =>
    assertPublishesSubject("src/lib/collections/presenters/media.ts", [
      'scheme: "media"',
      "item.id",
    ]),
  "libraries-library-row": () =>
    assertPublishesSubject("src/lib/collections/presenters/library.ts", [
      'scheme: "library"',
      "item.id",
    ]),
  "lectern-item-row": () =>
    assertPublishesSubject("src/lib/collections/presenters/lectern.ts", [
      "item.actionSubject",
    ]),
  "chats-conversation-row": () =>
    assertPublishesSubject("src/lib/collections/presenters/conversation.ts", [
      'scheme: "conversation"',
      "item.id",
    ]),
  "podcasts-podcast-row": () =>
    assertPublishesSubject("src/lib/collections/presenters/podcast.ts", [
      'scheme: "podcast"',
      "item.id",
    ]),
  "podcast-episode-row": () =>
    assertPublishesSubject("src/lib/collections/presenters/episode.ts", [
      'scheme: "media"',
      "item.id",
    ]),
  "authors-contributor-row": () => {
    const normalized = parse("src/lib/search/normalizeSearchResult.ts");
    if (!normalized.text.includes('case "contributor":')) {
      fail(
        "Search contributor rows must retain an explicit same-resource actionSubject branch.",
      );
    }
    proveSearchResultRow();
  },
  "author-work-row": () =>
    assertPublishesSubject(
      "src/lib/collections/presenters/presentContributorWork.ts",
      ["work.actionSubject"],
    ),
  "pages-page-row": () =>
    assertPublishesSubject("src/lib/collections/presenters/note.ts", [
      "item.actionSubject",
    ]),
};

const directProofs = {
  "nexus-command-result": () => {
    assertCanonicalModel("src/components/switchboard/SwitchboardActions.tsx");
    assertCanonicalModel("src/components/switchboard/SwitchboardRow.tsx");
    assertCanonicalModel("src/components/nexus/desktop/DesktopNexusRow.tsx");
  },
  "chat-context-card": () =>
    assertCanonicalMenu(
      "src/components/chat/ConversationContextRefsSurface.tsx",
    ),
  "evidence-card": () =>
    assertCanonicalMenu(
      "src/components/reader/document-map/EvidenceItemRow.tsx",
    ),
  "connections-card": () =>
    assertCanonicalMenu("src/components/connections/ConnectionsSurface.tsx"),
  "resource-surface-note-block": () =>
    assertCanonicalMenuVariant(
      "src/components/resource-surface/ResourceSurfaceBodyEditor.tsx",
      {
        requiredLabel: ["label ||", "sourceIndex"],
      },
    ),
  "resource-surface-resource-item": () =>
    assertCanonicalMenuVariant(
      "src/components/resource-surface/ResourceSurfaceBodyEditor.tsx",
      {
        requiredLabel: ["More actions for ${label}"],
        forbiddenLabel: ["label ||"],
      },
    ),
  "existing-highlight": () => {
    assertCanonicalMenu(
      "src/components/highlights/HighlightResourceActionMenu.tsx",
    );
    assertRendersImportedComponent({
      path: "src/components/highlights/HighlightActionPopover.tsx",
      moduleName: "@/components/highlights/HighlightResourceActionMenu",
    });
  },
  "assistant-message": () =>
    assertCanonicalMenu("src/components/chat/AssistantMessage.tsx"),
  "user-message": () =>
    assertCanonicalMenu("src/components/chat/UserMessage.tsx"),
  "desktop-listening-shelf": () =>
    assertCanonicalMenu("src/components/player/DesktopListeningShelf.tsx"),
  "mobile-mini-player": () =>
    assertCanonicalMenu("src/components/player/MobileMiniPlayer.tsx"),
  "mobile-now-playing": () =>
    assertCanonicalMenu("src/components/player/MobileNowPlaying.tsx"),
  "desktop-pane-header": () =>
    assertCanonicalMenu("src/components/ui/SurfaceHeader.tsx"),
  "primary-mobile-pane-header": () =>
    assertCanonicalMenu("src/components/appnav/MobilePaneBar.tsx"),
  "secondary-mobile-pane-header": () =>
    assertCanonicalMenu("src/components/workspace/MobileSecondaryPaneHost.tsx"),
};

const canonicalConsumerClassifications = [
  {
    kind: "ResourceActionMenu",
    path: "src/components/collections/CollectionRow.tsx",
    occurrences: 1,
    surfaceIds: Object.keys(rowProofs),
  },
  {
    kind: "ResourceActionMenu",
    path: "src/components/chat/ConversationContextRefsSurface.tsx",
    occurrences: 1,
    surfaceIds: ["chat-context-card"],
  },
  {
    kind: "ResourceActionMenu",
    path: "src/components/reader/document-map/EvidenceItemRow.tsx",
    occurrences: 1,
    surfaceIds: ["evidence-card"],
  },
  {
    kind: "ResourceActionMenu",
    path: "src/components/connections/ConnectionsSurface.tsx",
    occurrences: 1,
    surfaceIds: ["connections-card"],
  },
  {
    kind: "ResourceActionMenu",
    path: "src/components/resource-surface/ResourceSurfaceBodyEditor.tsx",
    occurrences: 2,
    surfaceIds: [
      "resource-surface-note-block",
      "resource-surface-resource-item",
    ],
  },
  {
    kind: "ResourceActionMenu",
    path: "src/components/highlights/HighlightResourceActionMenu.tsx",
    occurrences: 1,
    surfaceIds: ["existing-highlight"],
  },
  {
    kind: "ResourceActionMenu",
    path: "src/components/chat/AssistantMessage.tsx",
    occurrences: 1,
    surfaceIds: ["assistant-message"],
  },
  {
    kind: "ResourceActionMenu",
    path: "src/components/chat/UserMessage.tsx",
    occurrences: 1,
    surfaceIds: ["user-message"],
  },
  {
    kind: "ResourceActionMenu",
    path: "src/components/player/DesktopListeningShelf.tsx",
    occurrences: 1,
    surfaceIds: ["desktop-listening-shelf"],
  },
  {
    kind: "ResourceActionMenu",
    path: "src/components/player/MobileMiniPlayer.tsx",
    occurrences: 1,
    surfaceIds: ["mobile-mini-player"],
  },
  {
    kind: "ResourceActionMenu",
    path: "src/components/player/MobileNowPlaying.tsx",
    occurrences: 2,
    surfaceIds: ["mobile-now-playing"],
  },
  {
    kind: "ResourceActionMenu",
    path: "src/components/ui/SurfaceHeader.tsx",
    occurrences: 1,
    surfaceIds: ["desktop-pane-header"],
  },
  {
    kind: "ResourceActionMenu",
    path: "src/components/appnav/MobilePaneBar.tsx",
    occurrences: 1,
    surfaceIds: ["primary-mobile-pane-header"],
  },
  {
    kind: "ResourceActionMenu",
    path: "src/components/workspace/MobileSecondaryPaneHost.tsx",
    occurrences: 1,
    surfaceIds: ["secondary-mobile-pane-header"],
  },
  {
    kind: "useResourceActionMenuModel",
    path: "src/components/switchboard/SwitchboardActions.tsx",
    occurrences: 1,
    surfaceIds: ["nexus-command-result"],
  },
  {
    kind: "useResourceActionMenuModel",
    path: "src/components/switchboard/SwitchboardRow.tsx",
    occurrences: 1,
    surfaceIds: ["nexus-command-result"],
  },
  {
    kind: "useResourceActionMenuModel",
    path: "src/components/nexus/desktop/DesktopNexusRow.tsx",
    occurrences: 1,
    surfaceIds: ["nexus-command-result"],
  },
  {
    kind: "useResourceActionMenuModel",
    path: "src/components/resources/ResourceActionMenu.tsx",
    occurrences: 1,
    owner: "Canonical ResourceActionMenu renderer",
    surfaceIds: [],
  },
];

const directActionMenuClassifications = [
  {
    path: "src/app/(authenticated)/media/[id]/MediaPaneBody.tsx",
    occurrences: 1,
    owners: ["Reader/pane view"],
  },
  {
    path: "src/app/(authenticated)/podcasts/[podcastId]/PodcastEpisodeList.tsx",
    occurrences: 1,
    owners: ["Podcast selection/batch"],
  },
  {
    path: "src/app/(authenticated)/search/SearchPaneBody.tsx",
    occurrences: 1,
    owners: ["Search filter"],
  },
  {
    path: "src/components/appnav/AccountMenu.tsx",
    occurrences: 1,
    owners: ["Account session"],
  },
  {
    path: "src/components/appnav/MobilePaneBar.tsx",
    occurrences: 2,
    owners: ["Reader/pane view"],
  },
  {
    path: "src/components/collections/CollectionRow.tsx",
    occurrences: 1,
    owners: ["Collection occurrence"],
  },
  {
    path: "src/components/highlights/SelectionActionDock.tsx",
    occurrences: 1,
    owners: ["Fresh text selection"],
  },
  {
    path: "src/components/libraries/LibraryMembersSurface.tsx",
    occurrences: 1,
    owners: ["Library membership"],
  },
  {
    path: "src/components/nexus/desktop/DesktopNexusRow.tsx",
    occurrences: 2,
    owners: ["Canonical resource renderer", "Nexus non-resource result"],
  },
  {
    path: "src/components/player/DesktopListeningShelf.tsx",
    occurrences: 1,
    owners: ["Player session"],
  },
  {
    path: "src/components/player/MobileMiniPlayer.tsx",
    occurrences: 1,
    owners: ["Player session"],
  },
  {
    path: "src/components/player/MobileNowPlaying.tsx",
    occurrences: 1,
    owners: ["Player session"],
  },
  {
    path: "src/components/resource-surface/ResourceSurfaceBodyEditor.tsx",
    occurrences: 1,
    owners: ["Collection occurrence"],
  },
  {
    path: "src/components/resources/ContextEdgeMenu.tsx",
    occurrences: 1,
    owners: ["Context edge"],
  },
  {
    path: "src/components/resources/ResourceActionMenu.tsx",
    occurrences: 1,
    owners: ["Canonical resource renderer"],
  },
  {
    path: "src/components/switchboard/SwitchboardRow.tsx",
    occurrences: 2,
    owners: ["Canonical resource renderer", "Nexus non-resource result"],
  },
  {
    path: "src/components/ui/SurfaceHeader.tsx",
    occurrences: 1,
    owners: ["Reader/pane view"],
  },
];

const surfaceProofs = new Map([
  ...Object.entries(rowProofs),
  ...Object.entries(directProofs),
]);
const oracleIds = REQUIRED_RESOURCE_ACTION_SURFACES.map(({ id }) => id);
const proofIds = [...surfaceProofs.keys()];
const missingProofs = oracleIds.filter((id) => !surfaceProofs.has(id));
const unclassifiedProofs = proofIds.filter((id) => !oracleIds.includes(id));
if (missingProofs.length > 0 || unclassifiedProofs.length > 0) {
  fail(
    `surface proof ledger diverged from the product oracle; missing=${JSON.stringify(
      missingProofs,
    )} unclassified=${JSON.stringify(unclassifiedProofs)}.`,
  );
}

assertRowHub();
for (const { id } of REQUIRED_RESOURCE_ACTION_SURFACES) {
  surfaceProofs.get(id)();
}

function productionSources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionSources(path);
    if (
      ![".ts", ".tsx"].includes(extname(entry.name)) ||
      entry.name.includes(".test.")
    ) {
      return [];
    }
    return [path];
  });
}

const RESOURCE_ACTION_MENU_IMPORT = {
  alias: "@/components/resources/ResourceActionMenu",
  targetPath: "src/components/resources/ResourceActionMenu",
  importedName: "default",
};
const RESOURCE_ACTION_MODEL_IMPORT = {
  alias: "@/lib/actions/resourceActionRuntime",
  targetPath: "src/lib/actions/resourceActionRuntime",
  importedName: "useResourceActionMenuModel",
};
const ACTION_MENU_IMPORT = {
  alias: "@/components/ui/ActionMenu",
  targetPath: "src/components/ui/ActionMenu",
  importedName: "default",
};

function countImportedJsxRenders(parsed, target) {
  const { names, namespaces } = importedBindingsForTarget(parsed, target);
  if (names.size === 0 && namespaces.size === 0) return null;
  if (namespaces.size > 0) {
    fail(
      `${parsed.relativePath} namespace-imports ${target.alias}; canonical menu consumers must use a named component import so the surface inventory remains explicit.`,
    );
  }
  let occurrences = 0;
  visit(parsed.sourceFile, (node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      ts.isIdentifier(node.tagName) &&
      names.has(node.tagName.text)
    ) {
      occurrences += 1;
    }
  });
  return occurrences;
}

function countImportedHookCalls(parsed, target) {
  const { names, namespaces } = importedBindingsForTarget(parsed, target);
  if (names.size === 0 && namespaces.size === 0) return null;
  let occurrences = 0;
  visit(parsed.sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    if (ts.isIdentifier(node.expression) && names.has(node.expression.text)) {
      occurrences += 1;
      return;
    }
    if (
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      namespaces.has(node.expression.expression.text) &&
      node.expression.name.text === target.importedName
    ) {
      occurrences += 1;
    }
  });
  return occurrences;
}

function discoverCanonicalConsumers(parsedSources) {
  const discovered = [];
  for (const parsed of parsedSources) {
    const menuOccurrences = countImportedJsxRenders(
      parsed,
      RESOURCE_ACTION_MENU_IMPORT,
    );
    if (menuOccurrences !== null) {
      discovered.push({
        kind: "ResourceActionMenu",
        path: parsed.relativePath,
        occurrences: menuOccurrences,
      });
    }
    const modelOccurrences = countImportedHookCalls(
      parsed,
      RESOURCE_ACTION_MODEL_IMPORT,
    );
    if (modelOccurrences !== null) {
      discovered.push({
        kind: "useResourceActionMenuModel",
        path: parsed.relativePath,
        occurrences: modelOccurrences,
      });
    }
  }
  return discovered;
}

function discoverDirectActionMenuConsumers(parsedSources) {
  const discovered = [];
  for (const parsed of parsedSources) {
    const occurrences = countImportedJsxRenders(parsed, ACTION_MENU_IMPORT);
    if (occurrences !== null) {
      discovered.push({ path: parsed.relativePath, occurrences });
    }
  }
  return discovered;
}

function canonicalConsumerKey({ kind, path }) {
  return `${kind}:${path}`;
}

function assertCanonicalConsumerInventory(parsedSources) {
  const oracleSurfaceIds = new Set(
    REQUIRED_RESOURCE_ACTION_SURFACES.map(({ id }) => id),
  );
  const coveredSurfaceIds = new Set();
  const classified = new Map();
  for (const classification of canonicalConsumerClassifications) {
    const key = canonicalConsumerKey(classification);
    if (classified.has(key)) {
      fail(`canonical consumer classification is duplicated: ${key}.`);
    }
    if (
      classification.surfaceIds.length === 0 &&
      classification.owner === undefined
    ) {
      fail(`${key} has neither a surface classification nor an infrastructure owner.`);
    }
    for (const surfaceId of classification.surfaceIds) {
      if (!oracleSurfaceIds.has(surfaceId)) {
        fail(`${key} classifies unknown surface ${surfaceId}.`);
      }
      coveredSurfaceIds.add(surfaceId);
    }
    classified.set(key, classification);
  }
  const uncoveredSurfaceIds = [...oracleSurfaceIds].filter(
    (id) => !coveredSurfaceIds.has(id),
  );
  if (uncoveredSurfaceIds.length > 0) {
    fail(
      `surface ledger entries have no canonical consumer classification: ${JSON.stringify(
        uncoveredSurfaceIds,
      )}.`,
    );
  }

  const discovered = new Map(
    discoverCanonicalConsumers(parsedSources).map((consumer) => [
      canonicalConsumerKey(consumer),
      consumer,
    ]),
  );
  const unclassified = [...discovered.keys()].filter(
    (key) => !classified.has(key),
  );
  const missing = [...classified.keys()].filter((key) => !discovered.has(key));
  if (unclassified.length > 0 || missing.length > 0) {
    fail(
      `canonical consumer discovery diverged from its classification; unclassified=${JSON.stringify(
        unclassified,
      )} missing=${JSON.stringify(missing)}.`,
    );
  }
  for (const [key, classification] of classified) {
    const actual = discovered.get(key);
    if (actual.occurrences !== classification.occurrences) {
      fail(
        `${key} renders/calls ${actual.occurrences} canonical consumers; classify all ${classification.occurrences} expected occurrences explicitly.`,
      );
    }
  }
  return discovered.size;
}

function assertDirectActionMenuInventory(parsedSources) {
  const nonResourceOwners = new Set(
    NON_RESOURCE_COMMANDS.map(({ owner }) => owner),
  );
  const canonicalOwner = "Canonical resource renderer";
  const classified = new Map();
  for (const classification of directActionMenuClassifications) {
    if (classified.has(classification.path)) {
      fail(`direct ActionMenu classification is duplicated: ${classification.path}.`);
    }
    for (const owner of classification.owners) {
      if (owner !== canonicalOwner && !nonResourceOwners.has(owner)) {
        fail(
          `${classification.path} names unknown non-resource ActionMenu owner ${owner}.`,
        );
      }
    }
    classified.set(classification.path, classification);
  }
  const discovered = new Map(
    discoverDirectActionMenuConsumers(parsedSources).map((consumer) => [
      consumer.path,
      consumer,
    ]),
  );
  const unclassified = [...discovered.keys()].filter(
    (path) => !classified.has(path),
  );
  const missing = [...classified.keys()].filter((path) => !discovered.has(path));
  if (unclassified.length > 0 || missing.length > 0) {
    fail(
      `direct ActionMenu discovery diverged from explicit ownership; unclassified=${JSON.stringify(
        unclassified,
      )} missing=${JSON.stringify(missing)}.`,
    );
  }
  for (const [path, classification] of classified) {
    const actual = discovered.get(path);
    if (actual.occurrences !== classification.occurrences) {
      fail(
        `${path} renders ${actual.occurrences} direct ActionMenu consumers; ownership classifies ${classification.occurrences}.`,
      );
    }
  }
  return discovered.size;
}

function assertDiscoverySensitivity() {
  const canonicalFixture = parseText(
    "src/policy-fixture/CanonicalConsumer.tsx",
    `
      import MenuAlias from "@/components/resources/ResourceActionMenu";
      import * as Runtime from "@/lib/actions/resourceActionRuntime";
      export function Consumer({ subject }) {
        const model = Runtime.useResourceActionMenuModel(subject);
        return <MenuAlias actionSubject={subject} data-count={model.descriptors.length} />;
      }
    `,
  );
  const canonical = discoverCanonicalConsumers([canonicalFixture]);
  if (
    canonical.length !== 2 ||
    canonical.some(({ occurrences }) => occurrences !== 1)
  ) {
    fail(
      `canonical consumer discovery is insensitive to aliases/namespaces: ${JSON.stringify(
        canonical,
      )}.`,
    );
  }
  const directFixture = parseText(
    "src/components/ui/PolicyFixture.tsx",
    `
      import Overflow from "./ActionMenu";
      export function Consumer({ options }) {
        return <Overflow options={options} />;
      }
    `,
  );
  const direct = discoverDirectActionMenuConsumers([directFixture]);
  if (direct.length !== 1 || direct[0].occurrences !== 1) {
    fail(
      `direct ActionMenu discovery is insensitive to relative imports: ${JSON.stringify(
        direct,
      )}.`,
    );
  }
}

assertDiscoverySensitivity();
const parsedProductSources = productionSources(join(APP_ROOT, "src")).map(
  (path) => parse(path.slice(APP_ROOT.length + 1)),
);
const canonicalConsumerCount = assertCanonicalConsumerInventory(
  parsedProductSources,
);
const directActionMenuConsumerCount = assertDirectActionMenuInventory(
  parsedProductSources,
);

const residueHits = [];
for (const { relativePath, text: source } of parsedProductSources) {
  for (const residue of RETIRED_RESOURCE_ACTION_RESIDUE) {
    if (source.includes(residue)) {
      residueHits.push({
        path: relativePath,
        residue,
      });
    }
  }
}
if (residueHits.length > 0) {
  fail(
    `retired surface-local action islands remain in product source: ${JSON.stringify(
      residueHits,
    )}.`,
  );
}

console.log(
  `resource-action-surface-policy: ${REQUIRED_RESOURCE_ACTION_SURFACES.length} canonical surfaces, ${canonicalConsumerCount} canonical consumer modules, and ${directActionMenuConsumerCount} direct ActionMenu owners classified; ${RETIRED_RESOURCE_ACTION_RESIDUE.length} retired islands absent`,
);
