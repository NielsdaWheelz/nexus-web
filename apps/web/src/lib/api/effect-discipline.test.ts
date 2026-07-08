import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const RAW_FETCH_FILES = new Set([
  "src/lib/api/client.ts",
  "src/lib/api/proxy.ts",
  "src/lib/api/server.ts",
  "src/lib/api/sse-client.ts",
  "src/lib/auth/SessionRefresher.tsx",
  "src/lib/auth/internal-fetch.ts",
  "src/lib/media/ingestionClient.ts",
  "src/lib/supabase/client-config.ts",
  // transcribeAudio uses raw fetch to send multipart FormData without Content-Type override
  "src/lib/walknotes/transcribeAudio.ts",
]);

type Source = {
  path: string;
  ast: ts.SourceFile;
};

type AdHocGetEffect = {
  path: string;
  line: number;
  calledLoaders: string[];
  directApiFetchGet: boolean;
};

type FullPaneRuntimeDependency = {
  path: string;
  line: number;
  hook: string;
  identifier: string;
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      if (
        !/\.(ts|tsx)$/.test(entry.name) ||
        /\.test\.(ts|tsx)$/.test(entry.name)
      ) {
        return [];
      }
      return [path];
    })
    .sort();
}

function repoPath(path: string): string {
  return relative(process.cwd(), path).split(sep).join("/");
}

function readSources(): Source[] {
  return sourceFiles(join(process.cwd(), "src")).map((path) => {
    const source = readFileSync(path, "utf8");
    return {
      path: repoPath(path),
      ast: ts.createSourceFile(
        path,
        source,
        ts.ScriptTarget.Latest,
        true,
        path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      ),
    };
  });
}

function sourceText(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

function lineNumber(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function isCallNamed(node: ts.Node, name: string): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === name
  );
}

function callName(node: ts.CallExpression): string | null {
  return ts.isIdentifier(node.expression) ? node.expression.text : null;
}

function isRawFetchCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ((ts.isIdentifier(node.expression) && node.expression.text === "fetch") ||
      (ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "fetch"))
  );
}

function apiFetchMethod(call: ts.CallExpression): string {
  const init = call.arguments[1];
  if (!init) return "GET";
  if (!ts.isObjectLiteralExpression(init)) return "UNKNOWN";

  const method = init.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === "method",
  );
  if (!method) return "GET";
  return ts.isStringLiteralLike(method.initializer)
    ? method.initializer.text.toUpperCase()
    : "UNKNOWN";
}

function containsAdHocGetApiFetch(node: ts.Node): boolean {
  let found = false;
  function visit(child: ts.Node) {
    const method = isCallNamed(child, "apiFetch") ? apiFetchMethod(child) : null;
    if (method === "GET" || method === "UNKNOWN") {
      found = true;
      return;
    }
    if (!found) ts.forEachChild(child, visit);
  }
  visit(node);
  return found;
}

function functionFromInitializer(initializer: ts.Expression): ts.Node | null {
  if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
    return initializer;
  }
  if (isCallNamed(initializer, "useCallback")) {
    const callback = initializer.arguments[0];
    if (
      callback &&
      (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
    ) {
      return callback;
    }
  }
  return null;
}

function getLoaderNames(source: Source): Set<string> {
  const names = new Set<string>();
  function visit(node: ts.Node) {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      containsAdHocGetApiFetch(node)
    ) {
      names.add(node.name.text);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const body = functionFromInitializer(node.initializer);
      if (body && containsAdHocGetApiFetch(body)) {
        names.add(node.name.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source.ast);
  return names;
}

function calledNames(node: ts.Node): string[] {
  const names = new Set<string>();
  function visit(child: ts.Node) {
    if (ts.isCallExpression(child) && ts.isIdentifier(child.expression)) {
      names.add(child.expression.text);
    }
    ts.forEachChild(child, visit);
  }
  visit(node);
  return [...names].sort();
}

function adHocGetEffects(source: Source): AdHocGetEffect[] {
  const loaders = getLoaderNames(source);
  const offenders: AdHocGetEffect[] = [];

  function visit(node: ts.Node) {
    if (isCallNamed(node, "useEffect")) {
      const callback = node.arguments[0];
      if (callback) {
        const directApiFetchGet = containsAdHocGetApiFetch(callback);
        const calledLoaders = calledNames(callback).filter((name) =>
          loaders.has(name),
        );
        if (directApiFetchGet || calledLoaders.length > 0) {
          offenders.push({
            path: source.path,
            line: lineNumber(source.ast, node),
            calledLoaders,
            directApiFetchGet,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source.ast);
  return offenders;
}

function formatAdHocGetEffect(offender: AdHocGetEffect): string {
  const causes = [
    offender.directApiFetchGet ? "direct apiFetch GET" : null,
    offender.calledLoaders.length > 0
      ? `calls ${offender.calledLoaders.join(", ")}`
      : null,
  ].filter(Boolean);
  return `${offender.path}:${offender.line} ${causes.join("; ")}`;
}

function paneRuntimeIdentifiers(source: Source): Set<string> {
  const identifiers = new Set<string>();

  function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isCallNamed(node.initializer, "usePaneRuntime")
    ) {
      identifiers.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(source.ast);
  return identifiers;
}

function fullPaneRuntimeDependencies(
  source: Source,
): FullPaneRuntimeDependency[] {
  const runtimeIdentifiers = paneRuntimeIdentifiers(source);
  if (runtimeIdentifiers.size === 0) {
    return [];
  }

  const offenders: FullPaneRuntimeDependency[] = [];

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const hook = callName(node);
      const dependencies = node.arguments[1];
      if (
        (hook === "useEffect" || hook === "useCallback" || hook === "useMemo") &&
        dependencies &&
        ts.isArrayLiteralExpression(dependencies)
      ) {
        for (const dependency of dependencies.elements) {
          if (
            ts.isIdentifier(dependency) &&
            runtimeIdentifiers.has(dependency.text)
          ) {
            offenders.push({
              path: source.path,
              line: lineNumber(source.ast, dependencies),
              hook,
              identifier: dependency.text,
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source.ast);
  return offenders;
}

function formatFullPaneRuntimeDependency(
  offender: FullPaneRuntimeDependency,
): string {
  return `${offender.path}:${offender.line} ${offender.hook} depends on ${offender.identifier}`;
}

describe("effect discipline source shape", () => {
  it("keeps the browser API client navigation-free", () => {
    expect(sourceText("src/lib/api/client.ts")).not.toMatch(
      /window\.location|location\.(assign|replace|href)|router\.(push|replace)|redirectToLoginForCurrentLocation|buildLoginUrlForCurrentLocation|client-return-target|next\/navigation/,
    );
  });

  it("keeps auth return-target query construction in the auth owner", () => {
    const offenders = readSources()
      .filter((source) => source.path !== "src/lib/auth/redirects.ts")
      .flatMap((source) => {
        const text = source.ast.getFullText();
        return /searchParams\.set\((["'])next\1/.test(text)
          ? [source.path]
          : [];
      });

    expect(offenders).toEqual([]);
  });

  it("requires caught client API errors to classify unauthenticated errors", () => {
    const catchPattern = /\bcatch\s*(?:\(|\{)|\.catch\s*\(/;
    const authHandlerPattern =
      /handleUnauthenticatedApiError|isUnauthenticatedApiError|useUnauthenticatedApiHandler/;
    const offenders = sourceFiles(join(process.cwd(), "src"))
      .map((path) => ({ path: repoPath(path), text: readFileSync(path, "utf8") }))
      .filter((source) => source.path !== "src/lib/api/server.ts")
      .filter((source) => catchPattern.test(source.text))
      .filter((source) =>
        /from "@\/lib\/api\/client"|apiFetch\(|apiPostFormData\(|apiKeepaliveJson\(/.test(
          source.text,
        ),
      )
      .filter((source) => !authHandlerPattern.test(source.text))
      .map((source) => source.path);

    expect(offenders).toEqual([]);
  });

  it("requires caught feedback errors to classify unauthenticated errors", () => {
    const catchPattern = /\bcatch\s*(?:\(|\{)|\.catch\s*\(/;
    const authHandlerPattern =
      /handleUnauthenticatedApiError|isUnauthenticatedApiError|useUnauthenticatedApiHandler/;
    const offenders = sourceFiles(join(process.cwd(), "src"))
      .map((path) => ({ path: repoPath(path), text: readFileSync(path, "utf8") }))
      .filter((source) =>
        source.path.startsWith("src/app/(authenticated)") ||
        source.path.startsWith("src/components") ||
        source.path.startsWith("src/lib"),
      )
      .filter((source) => catchPattern.test(source.text))
      .filter((source) => /toFeedback\(/.test(source.text))
      .filter((source) => !authHandlerPattern.test(source.text))
      .map((source) => source.path);

    expect(offenders).toEqual([]);
  });

  it("keeps raw fetch in explicit boundary modules", () => {
    const offenders = readSources()
      .filter((file) => {
        let found = false;
        function visit(node: ts.Node) {
          if (isRawFetchCall(node)) {
            found = true;
            return;
          }
          if (!found) ts.forEachChild(node, visit);
        }
        visit(file.ast);
        return found;
      })
      .map((file) => file.path)
      .filter((path) => !RAW_FETCH_FILES.has(path));

    expect(offenders).toEqual([]);
  });

  it("requires polling call sites to carry justify-polling", () => {
    const offenders = sourceFiles(join(process.cwd(), "src"))
      .map((path) => ({
        path: repoPath(path),
        lines: readFileSync(path, "utf8").split("\n"),
      }))
      .flatMap((file) =>
        file.lines.flatMap((line, index) => {
          if (
            !line.includes("useIntervalPoll(") ||
            file.path === "src/lib/useIntervalPoll.ts"
          ) {
            return [];
          }
          const nearby = file.lines
            .slice(Math.max(0, index - 3), index)
            .join("\n");
          return nearby.includes("justify-polling")
            ? []
            : [`${file.path}:${index + 1}`];
        }),
      );

    expect(offenders).toEqual([]);
  });

  it("keeps full pane runtime objects out of reactive dependencies", () => {
    const offenders = readSources()
      .flatMap(fullPaneRuntimeDependencies)
      .map(formatFullPaneRuntimeDependency);

    expect(offenders).toEqual([]);
  });

  it("keeps GET requests out of ad hoc effects", () => {
    const offenders = readSources()
      .flatMap(adHocGetEffects)
      .map(formatAdHocGetEffect);

    expect(offenders).toEqual([]);
  });
});
