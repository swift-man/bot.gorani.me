import ts from 'typescript';

const getAttribute = (attributes, name) => {
  const match = attributes.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, 'i'));
  return match?.[1] ?? match?.[2] ?? match?.[3];
};

const isExecutable = (script) => {
  const type = getAttribute(script.attributes, 'type')?.toLowerCase();
  return !type || ['application/javascript', 'module', 'text/javascript'].includes(type);
};

const getStringValue = (node) => {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text;
};

const isExplicitBinding = (declaration) =>
  ts.isVariableDeclaration(declaration) ||
  ts.isParameter(declaration) ||
  ts.isBindingElement(declaration) ||
  ts.isFunctionDeclaration(declaration) ||
  ts.isClassDeclaration(declaration) ||
  ts.isImportClause(declaration) ||
  ts.isImportSpecifier(declaration) ||
  ts.isNamespaceImport(declaration) ||
  ts.isImportEqualsDeclaration(declaration);

const hasExplicitBinding = (node, checker) =>
  checker.getSymbolAtLocation(node)?.declarations?.some(isExplicitBinding) ?? false;

const isUnshadowedIdentifier = (node, name, checker) =>
  ts.isIdentifier(node) && node.text === name && !hasExplicitBinding(node, checker);

const isGlobalObject = (node, checker) =>
  isUnshadowedIdentifier(node, 'window', checker) || isUnshadowedIdentifier(node, 'globalThis', checker);

const isExplicitGlobalDataLayerReference = (node, checker) =>
  (ts.isPropertyAccessExpression(node) && isGlobalObject(node.expression, checker) && node.name.text === 'dataLayer') ||
  (ts.isElementAccessExpression(node) &&
    isGlobalObject(node.expression, checker) &&
    getStringValue(node.argumentExpression) === 'dataLayer');

const isDataLayerReference = (node, checker) =>
  isExplicitGlobalDataLayerReference(node, checker) || isUnshadowedIdentifier(node, 'dataLayer', checker);

const isValidDataLayerValue = (node, checker) =>
  ts.isArrayLiteralExpression(node) ||
  (ts.isBinaryExpression(node) &&
    [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind) &&
    isExplicitGlobalDataLayerReference(node.left, checker) &&
    ts.isArrayLiteralExpression(node.right));

const isDataLayerAssignment = (node, checker) =>
  ts.isBinaryExpression(node) &&
  node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
  isExplicitGlobalDataLayerReference(node.left, checker);

const isDataLayerInitialization = (node, checker) =>
  isDataLayerAssignment(node, checker) && isValidDataLayerValue(node.right, checker);

const isNestedFunction = (node) =>
  ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node);

const isImplicitArguments = (node, checker) => {
  if (!ts.isIdentifier(node) || node.text !== 'arguments') return false;
  return !hasExplicitBinding(node, checker);
};

const forwardsArgumentsToDataLayer = (functionNode, checker) => {
  let forwardsArguments = false;

  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'push' &&
      isDataLayerReference(node.expression.expression, checker) &&
      node.arguments.length > 0 &&
      isImplicitArguments(node.arguments[0], checker)
    ) {
      forwardsArguments = true;
      return;
    }

    if (isNestedFunction(node)) return;
    ts.forEachChild(node, visit);
  };

  visit(functionNode.body);
  return forwardsArguments;
};

const createJavaScriptProgram = (content) => {
  const fileName = 'analytics.js';
  const options = {
    allowJs: true,
    checkJs: false,
    noLib: true,
    target: ts.ScriptTarget.Latest,
  };
  const sourceFile = ts.createSourceFile(fileName, content, options.target, true, ts.ScriptKind.JS);
  const host = {
    fileExists: (candidate) => candidate === fileName,
    getCanonicalFileName: (candidate) => candidate,
    getCurrentDirectory: () => '',
    getDefaultLibFileName: () => '',
    getDirectories: () => [],
    getNewLine: () => '\n',
    getSourceFile: (candidate) => (candidate === fileName ? sourceFile : undefined),
    readFile: (candidate) => (candidate === fileName ? content : undefined),
    useCaseSensitiveFileNames: () => true,
    writeFile: () => {},
  };
  const program = ts.createProgram([fileName], options, host);

  return {
    checker: program.getTypeChecker(),
    hasSyntaxErrors: program.getSyntacticDiagnostics(sourceFile).length > 0,
    sourceFile,
  };
};

const hasAnalyticsInitialization = (content, measurementId) => {
  const { checker, hasSyntaxErrors, sourceFile } = createJavaScriptProgram(content);
  if (hasSyntaxErrors) return false;

  let hasDataLayerInitialization = false;
  let hasConfigCall = false;
  const forwardingFunctions = new Set();

  const updateFunction = (name, functionNode) => {
    if (!name) return;
    const symbol = checker.getSymbolAtLocation(name);
    if (!symbol) return;

    if (functionNode && forwardsArgumentsToDataLayer(functionNode, checker)) {
      forwardingFunctions.add(symbol);
    } else {
      forwardingFunctions.delete(symbol);
    }
  };

  const unwrapExpression = (node) => {
    let current = node;
    while (ts.isParenthesizedExpression(current)) current = current.expression;
    return current;
  };

  const visitExecutedStatements = (statements) => {
    for (const statement of statements) {
      if (ts.isFunctionDeclaration(statement)) {
        updateFunction(statement.name, statement);
      }
    }

    for (const statement of statements) {
      if (!visitExecutedStatement(statement)) return false;
    }

    return true;
  };

  const visitExecutedFunction = (functionNode) => {
    if (ts.isBlock(functionNode.body)) {
      return visitExecutedStatements(functionNode.body.statements);
    } else {
      visitExecutedExpression(functionNode.body);
      return true;
    }
  };

  const visitExecutedExpression = (node) => {
    const expression = unwrapExpression(node);

    if (ts.isCallExpression(expression)) {
      if (
        hasDataLayerInitialization &&
        ts.isIdentifier(expression.expression) &&
        getStringValue(expression.arguments[0]) === 'config' &&
        getStringValue(expression.arguments[1]) === measurementId
      ) {
        const symbol = checker.getSymbolAtLocation(expression.expression);
        if (symbol && forwardingFunctions.has(symbol)) hasConfigCall = true;
      }

      const callee = unwrapExpression(expression.expression);
      if (ts.isFunctionExpression(callee) || ts.isArrowFunction(callee)) {
        visitExecutedFunction(callee);
      }

      for (const argument of expression.arguments) {
        visitExecutedExpression(argument);
      }
      return;
    }

    if (ts.isBinaryExpression(expression)) {
      if (expression.operatorToken.kind === ts.SyntaxKind.CommaToken) {
        visitExecutedExpression(expression.left);
        visitExecutedExpression(expression.right);
        return;
      }

      if (expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        if (isDataLayerAssignment(expression, checker)) {
          hasDataLayerInitialization = isDataLayerInitialization(expression, checker);
          if (!hasDataLayerInitialization) hasConfigCall = false;
        }

        if (ts.isIdentifier(expression.left)) {
          updateFunction(expression.left, ts.isFunctionExpression(expression.right) ? expression.right : undefined);

          if (!ts.isFunctionExpression(expression.right) && !ts.isArrowFunction(expression.right)) {
            visitExecutedExpression(expression.right);
          }
          return;
        }

        if (!ts.isFunctionExpression(expression.right) && !ts.isArrowFunction(expression.right)) {
          visitExecutedExpression(expression.right);
        }
      }
      return;
    }

    if (ts.isPrefixUnaryExpression(expression) || ts.isPostfixUnaryExpression(expression)) {
      visitExecutedExpression(expression.operand);
      return;
    }

    if (ts.isConditionalExpression(expression)) {
      visitExecutedExpression(expression.condition);
    }
  };

  const visitExecutedStatement = (statement) => {
    if (ts.isFunctionDeclaration(statement)) return true;

    if (ts.isExpressionStatement(statement)) {
      visitExecutedExpression(statement.expression);
      return true;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!declaration.initializer) continue;

        if (ts.isIdentifier(declaration.name)) {
          updateFunction(
            declaration.name,
            ts.isFunctionExpression(declaration.initializer) ? declaration.initializer : undefined
          );
        }

        if (!ts.isFunctionExpression(declaration.initializer) && !ts.isArrowFunction(declaration.initializer)) {
          visitExecutedExpression(declaration.initializer);
        }
      }
      return true;
    }

    if (ts.isBlock(statement)) {
      return visitExecutedStatements(statement.statements);
    }

    if (ts.isLabeledStatement(statement)) {
      return visitExecutedStatement(statement.statement);
    }

    if (ts.isReturnStatement(statement)) {
      if (statement.expression) visitExecutedExpression(statement.expression);
      return false;
    }

    if (ts.isThrowStatement(statement)) {
      visitExecutedExpression(statement.expression);
      return false;
    }

    return true;
  };

  visitExecutedStatements(sourceFile.statements);
  return hasConfigCall;
};

export const validateMeasurementId = (measurementId) => {
  if (typeof measurementId !== 'string' || !/^G-[A-Z0-9]{10}$/.test(measurementId)) {
    throw new Error('A valid Google Analytics measurement ID is required in src/config.yaml.');
  }
};

export const verifyAnalyticsBuild = ({ html, measurementId }) => {
  validateMeasurementId(measurementId);
  const loaderUrl = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].map((match) => ({
    attributes: match[1],
    content: match[2],
  }));

  const partytownScript = scripts.find((script) => {
    if (getAttribute(script.attributes, 'type')?.toLowerCase() !== 'text/partytown') return false;
    const source = getAttribute(script.attributes, 'src') ?? '';
    return source.includes('googletagmanager.com') || script.content.includes(measurementId);
  });

  if (partytownScript) {
    throw new Error(
      'Analytics must be emitted as executable JavaScript; text/partytown is not supported by this deployment.'
    );
  }

  const loaderScript = scripts.find(
    (script) => isExecutable(script) && getAttribute(script.attributes, 'src') === loaderUrl
  );

  if (!loaderScript) {
    throw new Error(`Analytics loader is missing from dist/index.html: ${loaderUrl}`);
  }

  const initializationScript = scripts.find(
    (script) => isExecutable(script) && hasAnalyticsInitialization(script.content, measurementId)
  );

  if (!initializationScript) {
    throw new Error(`Analytics initialization is missing for ${measurementId}.`);
  }
};
