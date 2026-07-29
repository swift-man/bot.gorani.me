import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { verifyAnalyticsBuild } from './lib/verify-analytics.mjs';

const measurementId = 'G-TEST123456';
const loaderUrl = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
const loader = `<script async src="${loaderUrl}"></script>`;
const initializationBody = `
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('config', '${measurementId}');
`;
const initialization = `<script>${initializationBody}</script>`;

const html = (...scripts) => `<!doctype html><html><head>${scripts.join('')}</head></html>`;

describe('verifyAnalyticsBuild', () => {
  it('accepts an executable loader and initialization', () => {
    assert.doesNotThrow(() => verifyAnalyticsBuild({ html: html(loader, initialization), measurementId }));
  });

  it('accepts the minified IIFE initialization emitted by the production build', () => {
    const minifiedInitialization = `<script>!function(){function a(){window.dataLayer.push(arguments)}window.dataLayer=window.dataLayer||[],a("js",new Date),a("config","${measurementId}")}()</script>`;

    assert.doesNotThrow(() => verifyAnalyticsBuild({ html: html(loader, minifiedInitialization), measurementId }));
  });

  it('rejects an invalid measurement ID', () => {
    assert.throws(
      () => verifyAnalyticsBuild({ html: html(loader, initialization), measurementId: 'invalid' }),
      /valid Google Analytics measurement ID/
    );
  });

  it('rejects measurement IDs with an invalid suffix length', () => {
    for (const invalidMeasurementId of ['G-SHORT', 'G-TOOLONG12345']) {
      assert.throws(
        () => verifyAnalyticsBuild({ html: html(loader, initialization), measurementId: invalidMeasurementId }),
        /valid Google Analytics measurement ID/
      );
    }
  });

  it('rejects a missing loader', () => {
    assert.throws(
      () => verifyAnalyticsBuild({ html: html(initialization), measurementId }),
      /Analytics loader is missing/
    );
  });

  it('does not treat data-src as a loader source', () => {
    const disguisedLoader = `<script data-src="${loaderUrl}"></script>`;

    assert.throws(
      () => verifyAnalyticsBuild({ html: html(disguisedLoader, initialization), measurementId }),
      /Analytics loader is missing/
    );
  });

  it('does not treat src text inside another attribute as a loader source', () => {
    const disguisedLoader = `<script data-note='src="${loaderUrl}"'></script>`;

    assert.throws(
      () => verifyAnalyticsBuild({ html: html(disguisedLoader, initialization), measurementId }),
      /Analytics loader is missing/
    );
  });

  it('does not treat data-type as the script type', () => {
    const dataTypeInitialization = `<script data-type="application/json">${initializationBody}</script>`;

    assert.doesNotThrow(() => verifyAnalyticsBuild({ html: html(loader, dataTypeInitialization), measurementId }));
  });

  it('rejects a missing initialization', () => {
    assert.throws(
      () => verifyAnalyticsBuild({ html: html(loader), measurementId }),
      /Analytics initialization is missing/
    );
  });

  it('ignores initialization text in a non-executable script', () => {
    const jsonInitialization = `<script type="application/json">${initializationBody}</script>`;

    assert.throws(
      () => verifyAnalyticsBuild({ html: html(loader, jsonInitialization), measurementId }),
      /Analytics initialization is missing/
    );
  });

  it('ignores initialization calls inside comments and strings', () => {
    const commentInitialization = `
      <script>
        window.dataLayer = window.dataLayer || [];
        // gtag('config', '${measurementId}');
      </script>
    `;
    const stringInitialization = `
      <script>
        window.dataLayer = window.dataLayer || [];
        const example = "gtag('config', '${measurementId}')";
      </script>
    `;

    for (const fakeInitialization of [commentInitialization, stringInitialization]) {
      assert.throws(
        () => verifyAnalyticsBuild({ html: html(loader, fakeInitialization), measurementId }),
        /Analytics initialization is missing/
      );
    }
  });

  it('rejects syntactically invalid initialization code', () => {
    const invalidInitialization = `<script>${initializationBody}}</script>`;

    assert.throws(
      () => verifyAnalyticsBuild({ html: html(loader, invalidInitialization), measurementId }),
      /Analytics initialization is missing/
    );
  });

  it('rejects an unrelated function call with Analytics arguments', () => {
    const unrelatedCall = `
      <script>
        window.dataLayer = window.dataLayer || [];
        console.log('config', '${measurementId}');
      </script>
    `;

    assert.throws(
      () => verifyAnalyticsBuild({ html: html(loader, unrelatedCall), measurementId }),
      /Analytics initialization is missing/
    );
  });

  it('rejects a forwarding function when the data layer is not initialized', () => {
    const missingDataLayerInitialization = `
      <script>
        function gtag(){dataLayer.push(arguments);}
        gtag('config', '${measurementId}');
      </script>
    `;

    assert.throws(
      () => verifyAnalyticsBuild({ html: html(loader, missingDataLayerInitialization), measurementId }),
      /Analytics initialization is missing/
    );
  });

  it('rejects a config function that does not forward to the data layer', () => {
    const unrelatedConfigFunction = `
      <script>
        window.dataLayer = window.dataLayer || [];
        function fakeConfig(){console.log(arguments);}
        fakeConfig('config', '${measurementId}');
      </script>
    `;

    assert.throws(
      () => verifyAnalyticsBuild({ html: html(loader, unrelatedConfigFunction), measurementId }),
      /Analytics initialization is missing/
    );
  });

  it('rejects a data layer attached to an unrelated object', () => {
    const unrelatedDataLayer = `
      <script>
        const tracker = {};
        tracker.dataLayer = tracker.dataLayer || [];
        function gtag(){tracker.dataLayer.push(arguments);}
        gtag('config', '${measurementId}');
      </script>
    `;

    assert.throws(
      () => verifyAnalyticsBuild({ html: html(loader, unrelatedDataLayer), measurementId }),
      /Analytics initialization is missing/
    );
  });

  it('rejects a locally declared data layer', () => {
    const localDataLayer = `
      <script>
        const dataLayer = [];
        function gtag(){dataLayer.push(arguments);}
        gtag('config', '${measurementId}');
      </script>
    `;

    assert.throws(
      () => verifyAnalyticsBuild({ html: html(loader, localDataLayer), measurementId }),
      /Analytics initialization is missing/
    );
  });

  it('rejects a local data layer that shadows the global queue', () => {
    const shadowedDataLayer = `
      <script>
        window.dataLayer = window.dataLayer || [];
        const dataLayer = [];
        function gtag(){dataLayer.push(arguments);}
        gtag('config', '${measurementId}');
      </script>
    `;

    assert.throws(
      () => verifyAnalyticsBuild({ html: html(loader, shadowedDataLayer), measurementId }),
      /Analytics initialization is missing/
    );
  });

  it('rejects a config call whose function binding is shadowed', () => {
    const shadowedConfigFunction = `
      <script>
        window.dataLayer = window.dataLayer || [];
        function gtag(){window.dataLayer.push(arguments);}
        {
          const gtag = console.log;
          gtag('config', '${measurementId}');
        }
      </script>
    `;

    assert.throws(
      () => verifyAnalyticsBuild({ html: html(loader, shadowedConfigFunction), measurementId }),
      /Analytics initialization is missing/
    );
  });

  it('rejects invalid data layer initialization values', () => {
    for (const invalidValue of ['null', 'undefined', '{}', 'window.dataLayer || null']) {
      const invalidDataLayer = `
        <script>
          window.dataLayer = ${invalidValue};
          function gtag(){window.dataLayer.push(arguments);}
          gtag('config', '${measurementId}');
        </script>
      `;

      assert.throws(
        () => verifyAnalyticsBuild({ html: html(loader, invalidDataLayer), measurementId }),
        /Analytics initialization is missing/
      );
    }
  });

  it('rejects an arrow function that forwards an outer arguments object', () => {
    const arrowFunction = `
      <script>
        window.dataLayer = window.dataLayer || [];
        (function initialize(){
          const gtag = () => window.dataLayer.push(arguments);
          gtag('config', '${measurementId}');
        })();
      </script>
    `;

    assert.throws(
      () => verifyAnalyticsBuild({ html: html(loader, arrowFunction), measurementId }),
      /Analytics initialization is missing/
    );
  });

  it('rejects a local object that shadows the global window', () => {
    const shadowedWindow = `
      <script>
        (function initialize(window){
          window.dataLayer = window.dataLayer || [];
          function gtag(){window.dataLayer.push(arguments);}
          gtag('config', '${measurementId}');
        })({});
      </script>
    `;

    assert.throws(
      () => verifyAnalyticsBuild({ html: html(loader, shadowedWindow), measurementId }),
      /Analytics initialization is missing/
    );
  });

  it('rejects a forwarding function whose arguments object is shadowed', () => {
    const shadowedArguments = `
      <script>
        window.dataLayer = window.dataLayer || [];
        function gtag(arguments){window.dataLayer.push(arguments);}
        gtag('config', '${measurementId}');
      </script>
    `;

    assert.throws(
      () => verifyAnalyticsBuild({ html: html(loader, shadowedArguments), measurementId }),
      /Analytics initialization is missing/
    );
  });

  it('rejects initialization inside an uncalled function', () => {
    const uncalledInitialization = `
      <script>
        window.dataLayer = window.dataLayer || [];
        function neverCalled(){
          function gtag(){window.dataLayer.push(arguments);}
          gtag('config', '${measurementId}');
        }
      </script>
    `;

    assert.throws(
      () => verifyAnalyticsBuild({ html: html(loader, uncalledInitialization), measurementId }),
      /Analytics initialization is missing/
    );
  });

  it('rejects a data layer invalidated after valid initialization', () => {
    const invalidatedDataLayer = `
      <script>
        window.dataLayer = window.dataLayer || [];
        function gtag(){window.dataLayer.push(arguments);}
        window.dataLayer = null;
        gtag('config', '${measurementId}');
      </script>
    `;

    assert.throws(
      () => verifyAnalyticsBuild({ html: html(loader, invalidatedDataLayer), measurementId }),
      /Analytics initialization is missing/
    );
  });

  it('rejects a compound assignment that can invalidate the data layer', () => {
    const invalidatedDataLayer = `
      <script>
        window.dataLayer = window.dataLayer || [];
        function gtag(){window.dataLayer.push(arguments);}
        window.dataLayer &&= null;
        gtag('config', '${measurementId}');
      </script>
    `;

    assert.throws(
      () => verifyAnalyticsBuild({ html: html(loader, invalidatedDataLayer), measurementId }),
      /Analytics initialization is missing/
    );
  });

  it('rejects a forwarding function that is reassigned before config', () => {
    const reassignedFunction = `
      <script>
        window.dataLayer = window.dataLayer || [];
        function gtag(){window.dataLayer.push(arguments);}
        gtag = console.log;
        gtag('config', '${measurementId}');
      </script>
    `;

    assert.throws(
      () => verifyAnalyticsBuild({ html: html(loader, reassignedFunction), measurementId }),
      /Analytics initialization is missing/
    );
  });

  it('rejects initialization after an abrupt IIFE exit', () => {
    for (const exitStatement of ['return;', 'throw new Error();']) {
      const unreachableInitialization = `
        <script>
          (function initialize(){
            ${exitStatement}
            window.dataLayer = window.dataLayer || [];
            function gtag(){window.dataLayer.push(arguments);}
            gtag('config', '${measurementId}');
          })();
        </script>
      `;

      assert.throws(
        () => verifyAnalyticsBuild({ html: html(loader, unreachableInitialization), measurementId }),
        /Analytics initialization is missing/
      );
    }
  });

  it('rejects a forwarding call after an abrupt function exit', () => {
    for (const exitStatement of ['return;', 'throw new Error();']) {
      const unreachableForwardingCall = `
        <script>
          window.dataLayer = window.dataLayer || [];
          function gtag(){
            ${exitStatement}
            window.dataLayer.push(arguments);
          }
          gtag('config', '${measurementId}');
        </script>
      `;

      assert.throws(
        () => verifyAnalyticsBuild({ html: html(loader, unreachableForwardingCall), measurementId }),
        /Analytics initialization is missing/
      );
    }
  });

  it('rejects a forwarding function with an empty data layer push', () => {
    const emptyDataLayerPush = `
      <script>
        window.dataLayer = window.dataLayer || [];
        function gtag(){dataLayer.push();}
        gtag('config', '${measurementId}');
      </script>
    `;

    assert.throws(
      () => verifyAnalyticsBuild({ html: html(loader, emptyDataLayerPush), measurementId }),
      /Analytics initialization is missing/
    );
  });

  it('rejects a Partytown Analytics script', () => {
    const partytown = `<script type="text/partytown" src="${loaderUrl}"></script>`;

    assert.throws(
      () => verifyAnalyticsBuild({ html: html(partytown, initialization), measurementId }),
      /text\/partytown is not supported/
    );
  });
});
