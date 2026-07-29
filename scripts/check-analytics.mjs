import { readFile } from 'node:fs/promises';

import yaml from 'js-yaml';

const config = yaml.load(await readFile(new URL('../src/config.yaml', import.meta.url), 'utf8'));
const measurementId = config?.analytics?.vendors?.googleAnalytics?.id;

if (typeof measurementId !== 'string' || !/^G-[A-Z0-9]+$/.test(measurementId)) {
  throw new Error('A valid Google Analytics measurement ID is required in src/config.yaml.');
}

const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
const loaderUrl = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
const escapedMeasurementId = measurementId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const configCall = new RegExp(`["']config["']\\s*,\\s*["']${escapedMeasurementId}["']`);
const partytownScripts = html.match(/<script[^>]*type=["']text\/partytown["'][^>]*>[\s\S]*?<\/script>/gi) ?? [];

if (!html.includes(loaderUrl)) {
  throw new Error(`Analytics loader is missing from dist/index.html: ${loaderUrl}`);
}

if (!configCall.test(html)) {
  throw new Error(`Analytics initialization is missing for ${measurementId}.`);
}

if (partytownScripts.some((script) => script.includes(measurementId) || script.includes('googletagmanager.com'))) {
  throw new Error('Analytics is configured for Partytown, but the site does not enable the Partytown integration.');
}

console.log(`Analytics build check passed for ${measurementId}.`);
