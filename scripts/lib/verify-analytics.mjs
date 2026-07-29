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

const isGlobalObject = (node) => ts.isIdentifier(node) && (node.text === 'window' || node.text === 'globalThis');

const isExplicitGlobalDataLayerReference = (node) =>
  (ts.isPropertyAccessExpression(node) && isGlobalObject(node.expression) && node.name.text === 'dataLayer') ||
  (ts.isElementAccessExpression(node) &&
    isGlobalObject(node.expression) &&
    getStringValue(node.argumentExpression) === 'dataLayer');

const isDataLayerReference = (node, checker) =>
  isExplicitGlobalDataLayerReference(node) ||
  (ts.isIdentifier(node) && node.text === 'dataLayer' && !checker.getSymbolAtLocation(node));

const isValidDataLayerValue = (node) =>
  ts.isArrayLiteralExpression(node) ||
  (ts.isBinaryExpression(node) &&
    [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind) &&
    isExplicitGlobalDataLayerReference(node.left) &&
    ts.isArrayLiteralExpression(node.right));

const isDataLayerInitialization = (node) =>
  ts.isBinaryExpression(node) &&
  node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
  isExplicitGlobalDataLayerReference(node.left) &&
  isValidDataLayerValue(node.right);

const isNestedFunction = (node) =>
  ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node);

const forwardsArgumentsToDataLayer = (body, checker) => {
  let forwardsArguments = false;

  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'push' &&
      isDataLayerReference(node.expression.expression, checker) &&
      node.arguments.length > 0 &&
      ts.isIdentifier(node.arguments[0]) &&
      node.arguments[0].text === 'arguments'
    ) {
      forwardsArguments = true;
      return;
    }

    if (isNestedFunction(node)) return;
    ts.forEachChild(node, visit);
  };

  visit(body);
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
  const forwardingFunctions = new Set();
  const configCallTargets = new Set();

  const visit = (node) => {
    if (isDataLayerInitialization(node)) {
      hasDataLayerInitialization = true;
    }

    if (ts.isFunctionDeclaration(node) && node.name && node.body && forwardsArgumentsToDataLayer(node.body, checker)) {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol) forwardingFunctions.add(symbol);
    }

    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isFunctionExpression(node.initializer) &&
      forwardsArgumentsToDataLayer(node.initializer.body, checker)
    ) {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol) forwardingFunctions.add(symbol);
    }

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      ts.isFunctionExpression(node.right) &&
      forwardsArgumentsToDataLayer(node.right.body, checker)
    ) {
      const symbol = checker.getSymbolAtLocation(node.left);
      if (symbol) forwardingFunctions.add(symbol);
    }

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      getStringValue(node.arguments[0]) === 'config' &&
      getStringValue(node.arguments[1]) === measurementId
    ) {
      const symbol = checker.getSymbolAtLocation(node.expression);
      if (symbol) configCallTargets.add(symbol);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return hasDataLayerInitialization && [...forwardingFunctions].some((symbol) => configCallTargets.has(symbol));
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
