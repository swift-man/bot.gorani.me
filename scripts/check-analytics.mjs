import { readFile } from 'node:fs/promises';

import yaml from 'js-yaml';
import { validateMeasurementId, verifyAnalyticsBuild } from './lib/verify-analytics.mjs';

const config = yaml.load(await readFile(new URL('../src/config.yaml', import.meta.url), 'utf8'));
const measurementId = config?.analytics?.vendors?.googleAnalytics?.id;
validateMeasurementId(measurementId);

let html;

try {
  html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
} catch (error) {
  if (error?.code === 'ENOENT') {
    throw new Error('dist/index.html was not found. Run "npm run build" before "npm run check:analytics".');
  }
  throw error;
}

verifyAnalyticsBuild({ html, measurementId });

console.log(`Analytics build check passed for ${measurementId}.`);
