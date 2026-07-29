### JavaScript / TypeScript module system

- **Environment / module-system mismatch** — every NEW or moved file must
  actually RUN in its package's environment. Check the nearest `package.json`
  (`"type": "module"` vs CommonJS) and runner config: CJS globals (`__dirname`,
  `__filename`, `require`) in an ESM package throw `ReferenceError` at load; a
  test file that crashes at collection breaks the WHOLE suite — that is **P1**,
  not a nit. Also: imports that don't resolve, wrong file extension for the
  module system, config the runner never picks up.
