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

const isDataLayerReference = (node) =>
  (ts.isIdentifier(node) && node.text === 'dataLayer') ||
  (ts.isPropertyAccessExpression(node) && isGlobalObject(node.expression) && node.name.text === 'dataLayer') ||
  (ts.isElementAccessExpression(node) &&
    isGlobalObject(node.expression) &&
    getStringValue(node.argumentExpression) === 'dataLayer');

const isDataLayerInitialization = (node) =>
  (ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    isDataLayerReference(node.left)) ||
  (ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text === 'dataLayer' &&
    Boolean(node.initializer));

const isFunctionExpression = (node) => ts.isFunctionExpression(node) || ts.isArrowFunction(node);

const forwardsArgumentsToDataLayer = (body) => {
  let forwardsArguments = false;

  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'push' &&
      isDataLayerReference(node.expression.expression) &&
      node.arguments.length > 0 &&
      ts.isIdentifier(node.arguments[0]) &&
      node.arguments[0].text === 'arguments'
    ) {
      forwardsArguments = true;
      return;
    }

    if (ts.isFunctionDeclaration(node) || isFunctionExpression(node)) return;
    ts.forEachChild(node, visit);
  };

  visit(body);
  return forwardsArguments;
};

const hasAnalyticsInitialization = (content, measurementId) => {
  const sourceFile = ts.createSourceFile('analytics.js', content, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  if (sourceFile.parseDiagnostics.length > 0) return false;

  let hasDataLayerInitialization = false;
  const forwardingFunctions = new Set();
  const configCallTargets = new Set();

  const visit = (node) => {
    if (isDataLayerInitialization(node)) {
      hasDataLayerInitialization = true;
    }

    if (ts.isFunctionDeclaration(node) && node.name && node.body && forwardsArgumentsToDataLayer(node.body)) {
      forwardingFunctions.add(node.name.text);
    }

    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isFunctionExpression(node.initializer) &&
      forwardsArgumentsToDataLayer(node.initializer.body)
    ) {
      forwardingFunctions.add(node.name.text);
    }

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      isFunctionExpression(node.right) &&
      forwardsArgumentsToDataLayer(node.right.body)
    ) {
      forwardingFunctions.add(node.left.text);
    }

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      getStringValue(node.arguments[0]) === 'config' &&
      getStringValue(node.arguments[1]) === measurementId
    ) {
      configCallTargets.add(node.expression.text);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return (
    hasDataLayerInitialization && [...forwardingFunctions].some((functionName) => configCallTargets.has(functionName))
  );
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
