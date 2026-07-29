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

const hasAnalyticsInitialization = (content, measurementId) => {
  const sourceFile = ts.createSourceFile('analytics.js', content, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  let hasDataLayer = false;
  let hasConfigCall = false;

  const visit = (node) => {
    if (ts.isIdentifier(node) && node.text === 'dataLayer') {
      hasDataLayer = true;
    }

    if (
      ts.isCallExpression(node) &&
      getStringValue(node.arguments[0]) === 'config' &&
      getStringValue(node.arguments[1]) === measurementId
    ) {
      hasConfigCall = true;
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return hasDataLayer && hasConfigCall;
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
