# CHANGES — Lock File Sync for fast-text-encoding

## Problem

`npm ci` failed on CI because `package-lock.json` was not regenerated after
`fast-text-encoding@^1.0.6` was added to `package.json`.

`npm ci` requires that `package-lock.json` is consistent with `package.json`.
When a dependency is present in `package.json` but its resolved entry is missing
from `package-lock.json`, npm ci exits with:

```
npm error `npm ci` can only install packages when your package.json and
package-lock.json or npm-shrinkwrap.json are in sync.
```

## Root Cause

The package was previously installed using **pnpm** (which writes to
`pnpm-lock.yaml` only). The CI workflow uses `npm ci` which reads
`package-lock.json` exclusively. The `package-lock.json` did not contain
the resolved entry for `fast-text-encoding`.

## Fix

Ran `npm install --package-lock-only --ignore-scripts` to regenerate
`package-lock.json` from `package.json` without modifying `node_modules`.

This added the following entry to `package-lock.json`:

```json
"node_modules/fast-text-encoding": {
  "version": "1.0.6",
  "resolved": "https://registry.npmjs.org/fast-text-encoding/-/fast-text-encoding-1.0.6.tgz",
  "integrity": "sha512-VhXlQgj9ioXCqGstD37E/HBeqEGV/qOD/kmbVG8h5xKBYvM1L3lR1Zn4555cQ8GkYbJa8aJSipLPndE1k6zK2w==",
  "license": "Apache-2.0"
}
```

The integrity hash matches the npm registry exactly (`npm view fast-text-encoding@1.0.6 dist.integrity`).

## Verification

```
# Clean install from lockfile only
rm -rf node_modules
npm ci --ignore-scripts          → exit 0 ✓

# Package loads correctly
node -e "require('fast-text-encoding'); console.log(typeof global.TextEncoder)"
→ function ✓
```

## Files Changed

| File | Change |
|------|--------|
| `package-lock.json` | Regenerated via `npm install --package-lock-only` to include `fast-text-encoding@1.0.6` |

**No other files were modified.**
The TextEncoder polyfill (`src/polyfills/text-encoding.js`) and
`metro.config.js` are unchanged.
