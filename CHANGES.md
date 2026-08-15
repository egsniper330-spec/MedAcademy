# Fix: SyntaxError in src/lib/useScreenCapture.ts

## Problem

The previous edit that restored the `interface Options` block accidentally
omitted the `export function useScreenCapture` declaration, merging the closing
brace of the interface directly with the function's parameter list:

```ts
// BROKEN (line 48)
  isSuperAdmin?: boolean;
}(opts: Options = {}) {   ← closing brace of interface fused to function params
```

Babel/Metro reported:
  SyntaxError: Missing semicolon  src/lib/useScreenCapture.ts (48:21)

## Fix

Inserted the missing blank line and `export function useScreenCapture` declaration
between the interface closing brace and the function body:

```ts
// FIXED
  isSuperAdmin?: boolean;
}

export function useScreenCapture(opts: Options = {}) {
```

## Verification

- `npx tsc --noEmit --skipLibCheck` → exit 0, zero errors
- Node sanity check confirms all required tokens present, broken pattern absent
- No logic, imports, dependencies, or other files changed
