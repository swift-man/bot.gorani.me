import ts from 'typescript';

const getAttribute = (attributes, name) => {
  const expectedName = name.toLowerCase();
  let index = 0;

  while (index < attributes.length) {
    while (index < attributes.length && /\s/.test(attributes[index])) index += 1;
    if (index >= attributes.length || attributes[index] === '>') break;
    if (attributes[index] === '/') {
      index += 1;
      continue;
    }

    const nameStart = index;
    while (index < attributes.length && !/[\s=/>]/.test(attributes[index])) index += 1;
    if (index === nameStart) {
      index += 1;
      continue;
    }

    const attributeName = attributes.slice(nameStart, index).toLowerCase();
    while (index < attributes.length && /\s/.test(attributes[index])) index += 1;

    let value = '';
    if (attributes[index] === '=') {
      index += 1;
      while (index < attributes.length && /\s/.test(attributes[index])) index += 1;

      const quote = attributes[index];
      if (quote === '"' || quote === "'") {
        index += 1;
        const valueStart = index;
        while (index < attributes.length && attributes[index] !== quote) index += 1;
        value = attributes.slice(valueStart, index);
        if (attributes[index] === quote) index += 1;
      } else {
        const valueStart = index;
        while (index < attributes.length && !/[\s>]/.test(attributes[index])) index += 1;
        value = attributes.slice(valueStart, index);
      }
    }

    if (attributeName === expectedName) return value;
  }
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

const preservesExistingDataLayer = (node, checker) =>
  ts.isBinaryExpression(node) &&
  [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind) &&
  isExplicitGlobalDataLayerReference(node.left, checker) &&
  ts.isArrayLiteralExpression(node.right);

const isValidDataLayerValue = (node, checker) =>
  ts.isArrayLiteralExpression(node) || preservesExistingDataLayer(node, checker);

const isAssignmentOperator = (kind) => kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;

const isDataLayerAssignment = (node, checker) =>
  ts.isBinaryExpression(node) &&
  isAssignmentOperator(node.operatorToken.kind) &&
  isExplicitGlobalDataLayerReference(node.left, checker);

const isDataLayerInitialization = (node, checker) =>
  isDataLayerAssignment(node, checker) &&
  node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
  isValidDataLayerValue(node.right, checker);

const isNestedFunction = (node) =>
  ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node);

const isImplicitArguments = (node, checker) => {
  if (!ts.isIdentifier(node) || node.text !== 'arguments') return false;
  return !hasExplicitBinding(node, checker);
};

const forwardsArgumentsToDataLayer = (functionNode, checker) => {
  const expressionForwardsArguments = (node) => {
    if (!node || isNestedFunction(node)) return false;

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'push' &&
      isDataLayerReference(node.expression.expression, checker) &&
      node.arguments.length > 0 &&
      isImplicitArguments(node.arguments[0], checker)
    ) {
      return true;
    }

    if (ts.isParenthesizedExpression(node)) return expressionForwardsArguments(node.expression);

    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      return (
        expressionForwardsArguments(node.expression) || (node.arguments?.some(expressionForwardsArguments) ?? false)
      );
    }

    if (ts.isBinaryExpression(node)) {
      if (
        [
          ts.SyntaxKind.AmpersandAmpersandToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.QuestionQuestionToken,
        ].includes(node.operatorToken.kind)
      ) {
        return expressionForwardsArguments(node.left);
      }
      return expressionForwardsArguments(node.left) || expressionForwardsArguments(node.right);
    }

    if (ts.isConditionalExpression(node)) return expressionForwardsArguments(node.condition);

    if (
      ts.isPrefixUnaryExpression(node) ||
      ts.isPostfixUnaryExpression(node) ||
      ts.isAwaitExpression(node) ||
      ts.isYieldExpression(node)
    ) {
      return expressionForwardsArguments(node.operand ?? node.expression);
    }

    if (ts.isPropertyAccessExpression(node)) return expressionForwardsArguments(node.expression);
    if (ts.isElementAccessExpression(node)) {
      return expressionForwardsArguments(node.expression) || expressionForwardsArguments(node.argumentExpression);
    }

    if (ts.isArrayLiteralExpression(node)) return node.elements.some(expressionForwardsArguments);
    if (ts.isObjectLiteralExpression(node)) {
      return node.properties.some((property) => {
        if (ts.isPropertyAssignment(property)) return expressionForwardsArguments(property.initializer);
        if (ts.isSpreadAssignment(property)) return expressionForwardsArguments(property.expression);
        return false;
      });
    }

    return false;
  };

  const visitStatement = (statement) => {
    if (ts.isFunctionDeclaration(statement)) return { forwards: false, continues: true };

    if (ts.isExpressionStatement(statement)) {
      return { forwards: expressionForwardsArguments(statement.expression), continues: true };
    }

    if (ts.isVariableStatement(statement)) {
      return {
        forwards: statement.declarationList.declarations.some((declaration) =>
          expressionForwardsArguments(declaration.initializer)
        ),
        continues: true,
      };
    }

    if (ts.isBlock(statement)) return visitStatements(statement.statements);
    if (ts.isLabeledStatement(statement)) return visitStatement(statement.statement);

    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
      return {
        forwards: expressionForwardsArguments(statement.expression),
        continues: false,
      };
    }

    return { forwards: false, continues: true };
  };

  const visitStatements = (statements) => {
    for (const statement of statements) {
      const result = visitStatement(statement);
      if (result.forwards || !result.continues) return result;
    }
    return { forwards: false, continues: true };
  };

  if (!ts.isBlock(functionNode.body)) return expressionForwardsArguments(functionNode.body);
  return visitStatements(functionNode.body.statements).forwards;
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

      if (isAssignmentOperator(expression.operatorToken.kind)) {
        if (isDataLayerAssignment(expression, checker)) {
          hasDataLayerInitialization = isDataLayerInitialization(expression, checker);
          if (!hasDataLayerInitialization || !preservesExistingDataLayer(expression.right, checker)) {
            hasConfigCall = false;
          }
        }

        if (ts.isIdentifier(expression.left)) {
          updateFunction(
            expression.left,
            expression.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isFunctionExpression(expression.right)
              ? expression.right
              : undefined
          );

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
    (script) =>
      isExecutable(script) &&
      getAttribute(script.attributes, 'src') === undefined &&
      hasAnalyticsInitialization(script.content, measurementId)
  );

  if (!initializationScript) {
    throw new Error(`Analytics initialization is missing for ${measurementId}.`);
  }
};
