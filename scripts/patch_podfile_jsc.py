#!/usr/bin/env python3
"""
patch_podfile_jsc.py  —  force hermes_enabled=false in generated ios/Podfile
=============================================================================
Usage:
    python3 scripts/patch_podfile_jsc.py ios/Podfile

Called by .github/workflows/ios-build.yml after `expo prebuild --clean`
and before `pod install`.

Why this exists
---------------
`expo prebuild --clean` regenerates ios/Podfile from a template each build.
The generated Podfile passes a dynamic hermes_enabled expression to
use_react_native!() that may not evaluate to false even when expo.jsEngine=jsc
is set in Podfile.properties.json.

This script temporarily patches the freshly generated ios/Podfile to
explicitly set hermes_enabled=false before CocoaPods reads it.
The ios/ directory is discarded and regenerated on the next build — this
is an intentional ephemeral modification, not a permanent source change.

No node_modules, React Native source files, or any file outside
ios/Podfile are touched by this script.

What this script does
---------------------
1.  Reads the generated ios/Podfile.
2.  Locates the use_react_native!( ... ) block using balanced-paren
    matching — not a whole-file regex.
3.  Prints the located block to stdout BEFORE patching (CI log).
4.  Inside that block only:
    a. If hermes_enabled is present with any value  → replace with false
       Handles both Ruby hash syntaxes:
         :hermes_enabled => <expr>   (hash-rocket, Expo SDK 55 generated style)
         hermes_enabled: <expr>      (keyword style)
       Also handles multi-line values (e.g. || continuation expressions).
    b. If hermes_enabled is absent  → inserts :hermes_enabled => false
       as the first argument, preserving existing indentation.
5.  Writes the patched content back to the same file.
6.  Re-reads and prints the use_react_native!() block AFTER patching.
7.  Hard-asserts exactly one hermes_enabled=false exists in the block.
8.  Exits 0 on success, non-zero on any failure — workflow halts before
    pod install if this step fails.

What this script does NOT do
-----------------------------
- Does not modify node_modules
- Does not modify React Native source files
- Does not modify Podfile.lock
- Does not touch any file other than the single Podfile path given as argv[1]
- Does not affect Android configuration
"""

import sys
import re


def find_block(text, needle):
    """Return (start, end) char indices of needle(...) with balanced parens."""
    start = text.find(needle)
    if start == -1:
        return None, None
    paren_start = start + len(needle) - 1  # position of the opening '('
    depth = 0
    for i in range(paren_start, len(text)):
        if text[i] == '(':
            depth += 1
        elif text[i] == ')':
            depth -= 1
            if depth == 0:
                return start, i
    return start, -1  # unmatched


def main():
    if len(sys.argv) != 2:
        print("Usage: patch_podfile_jsc.py <path/to/Podfile>")
        sys.exit(1)

    podfile_path = sys.argv[1]

    try:
        with open(podfile_path, 'r') as f:
            original = f.read()
    except OSError as e:
        print(f"FAIL: Cannot read {podfile_path}: {e}")
        sys.exit(1)

    # ── Step 1: locate use_react_native!( block ──────────────────────────────
    start, end = find_block(original, 'use_react_native!(')

    if start is None:
        print("FAIL: 'use_react_native!(' not found in Podfile")
        print("      First 60 lines of Podfile:")
        for i, line in enumerate(original.splitlines()[:60], 1):
            print(f"  {i:3}: {line}")
        sys.exit(1)

    if end == -1:
        print("FAIL: Unmatched parentheses — could not find closing ')' of use_react_native!( block")
        sys.exit(1)

    block = original[start:end + 1]
    print("=== Generated Podfile detected ===")
    print("Patching use_react_native! block to force hermes_enabled => false...")
    print()
    print(f"Located use_react_native! block (chars {start}\u2013{end}):")
    for line in block.splitlines():
        print(f"  {line}")
    print()

    # ── Step 2: normalise or insert :hermes_enabled ──────────────────────────
    # Matches both Ruby hash syntaxes:
    #   :hermes_enabled => <value>   (hash-rocket, Expo SDK 55 generated style)
    #   hermes_enabled: <value>      (keyword style)
    # Value runs to the next comma, closing paren, or newline.
    # Uses re.DOTALL so the value can span continuation lines (e.g. multiline
    # boolean expressions ending in || or &&).
    hermes_pat = re.compile(
        r'(?::hermes_enabled\s*=>\s*|hermes_enabled:\s*)[^,\)]+',
        re.MULTILINE | re.DOTALL
    )
    matches = hermes_pat.findall(block)

    if len(matches) > 1:
        print(f"WARN: {len(matches)} hermes_enabled occurrences found — normalising all to false")

    if matches:
        # Determine replacement syntax to match what was found
        if ':hermes_enabled =>' in matches[0]:
            replacement = ':hermes_enabled => false'
        else:
            replacement = 'hermes_enabled: false'
        new_block = hermes_pat.sub(replacement, block)
        print(f"Replaced {len(matches)} hermes_enabled occurrence(s): {[m.strip() for m in matches]} -> false")
    else:
        # Insert as first argument, preserving existing indentation style
        insert_at = len('use_react_native!(')
        rest = block[insert_at:]
        indent_match = re.search(r'\n(\s+)', rest)
        indent = indent_match.group(1) if indent_match else '    '
        new_block = (
            block[:insert_at]
            + f'\n{indent}:hermes_enabled => false,'
            + block[insert_at:]
        )
        print(f"Inserted :hermes_enabled => false as first argument (indent: {repr(indent)})")

    # ── Step 3: write patched Podfile ─────────────────────────────────────────
    patched = original[:start] + new_block + original[end + 1:]

    try:
        with open(podfile_path, 'w') as f:
            f.write(patched)
    except OSError as e:
        print(f"FAIL: Cannot write {podfile_path}: {e}")
        sys.exit(1)

    # ── Step 4: re-read and assert ────────────────────────────────────────────
    with open(podfile_path, 'r') as f:
        verify_content = f.read()

    v_start, v_end = find_block(verify_content, 'use_react_native!(')
    if v_start is None or v_end == -1:
        print("FAIL: use_react_native!( block not found in patched Podfile")
        sys.exit(1)

    verify_block = verify_content[v_start:v_end + 1]

    print()
    print("=== Patched use_react_native! block ===")
    for line in verify_block.splitlines():
        print(f"  {line}")
    print()

    all_hermes = re.findall(
        r'(?::hermes_enabled\s*=>\s*|hermes_enabled:\s*)(\S+)',
        verify_block
    )

    if len(all_hermes) != 1:
        print(f"FAIL: Expected exactly 1 :hermes_enabled in block, found {len(all_hermes)}: {all_hermes}")
        sys.exit(1)

    value = all_hermes[0].rstrip(',')
    if value != 'false':
        print(f"FAIL: :hermes_enabled value is '{value}', expected 'false'")
        sys.exit(1)

    print("hermes_enabled => false")
    print("Podfile JSC configuration verified.")
    sys.exit(0)


if __name__ == '__main__':
    main()
