// Loaded via `node --require tests/fixed-clock.js ...` to pin the process's notion of "now"
// to a constant instant, so a spawned copy of token-audit.js (which reads Date.now() exactly
// once, to compute its window) produces byte-identical output regardless of the real wall-clock
// time the test suite happens to run at. See tests/readme-sample.test.js for why this exists.
//
// Opt-in and no-op by default: only patches Date when TOKEN_AUDIT_TEST_NOW (an ISO 8601
// string) is set in the environment. Any other test/process that doesn't set it, or doesn't
// `--require` this file, sees the real, unpatched Date.
//
// Only two things are pinned: Date.now() and the argless `new Date()` — both readings of
// "the current instant". Every other Date entry point that builds or inspects an explicit
// timestamp (new Date(ms), new Date(str), Date.UTC(...), Date.parse(...), instance getters,
// `instanceof Date`) passes straight through to the real Date, via `extends`. Not supported:
// calling `Date()` as a plain function (no `new`) — a class can't be invoked without `new`, so
// this would throw instead of returning a fixed string. The script never does this.
'use strict';

const iso = process.env.TOKEN_AUDIT_TEST_NOW;
if (iso) {
  const RealDate = Date;
  const fixed = RealDate.parse(iso);
  if (Number.isNaN(fixed)) {
    throw new Error(`fixed-clock.js: TOKEN_AUDIT_TEST_NOW is not a valid date: ${iso}`);
  }

  class FixedDate extends RealDate {
    constructor(...args) {
      super(...(args.length === 0 ? [fixed] : args));
    }
    static now() {
      return fixed;
    }
  }

  global.Date = FixedDate;
}
