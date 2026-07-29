import { readFile } from 'node:fs/promises';

import yaml from 'js-yaml';

const config = yaml.load(await readFile(new URL('../src/config.yaml', import.meta.url), 'utf8'));
const measurementId = config?.analytics?.vendors?.googleAnalytics?.id;

if (typeof measurementId !== 'string' || !/^G-[A-Z0-9]+$/.test(measurementId)) {
  throw new Error('A valid Google Analytics measurement ID is required in src/config.yaml.');
}

let html;

try {
  html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
} catch (error) {
  if (error?.code === 'ENOENT') {
    throw new Error('dist/index.html was not found. Run "npm run build" before "npm run check:analytics".');
  }
  throw error;
}

const loaderUrl = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
const escapedMeasurementId = measurementId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const configCall = new RegExp(`["']config["']\\s*,\\s*["']${escapedMeasurementId}["']`);
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].map((match) => ({
  attributes: match[1],
  content: match[2],
}));

const getAttribute = (attributes, name) => {
  const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, 'i'));
  return match?.[1] ?? match?.[2] ?? match?.[3];
};

const isExecutable = (script) => {
  const type = getAttribute(script.attributes, 'type')?.toLowerCase();
  return !type || ['application/javascript', 'module', 'text/javascript'].includes(type);
};

const partytownScript = scripts.find((script) => {
  if (getAttribute(script.attributes, 'type')?.toLowerCase() !== 'text/partytown') return false;
  const source = getAttribute(script.attributes, 'src') ?? '';
  return source.includes('googletagmanager.com') || script.content.includes(measurementId);
});

if (partytownScript) {
  throw new Error('Analytics is configured for Partytown, but the site does not enable the Partytown integration.');
}

const loaderScript = scripts.find(
  (script) => isExecutable(script) && getAttribute(script.attributes, 'src') === loaderUrl
);

if (!loaderScript) {
  throw new Error(`Analytics loader is missing from dist/index.html: ${loaderUrl}`);
}

const initializationScript = scripts.find(
  (script) => isExecutable(script) && script.content.includes('dataLayer') && configCall.test(script.content)
);

if (!initializationScript) {
  throw new Error(`Analytics initialization is missing for ${measurementId}.`);
}

console.log(`Analytics build check passed for ${measurementId}.`);
