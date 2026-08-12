#!/usr/bin/env python3
"""
patch_podfile_jsc.py  —  force :hermes_enabled => false in ios/Podfile
======================================================================
Usage:
    python3 scripts/patch_podfile_jsc.py ios/Podfile

Called by .github/workflows/ios-build.yml after `expo prebuild` and
before `pod install`.

Why this exists
---------------
`expo prebuild --clean` regenerates ios/Podfile from a template. In
Expo SDK 55 / React Native 0.83.2 the generated Podfile contains:

    use_react_native!(
      :hermes_enabled => podfile_properties['expo.jsEngine'] == nil ||
                         podfile_properties['expo.jsEngine'] == 'hermes',
      ...
    )

This dynamic expression is evaluated at CocoaPods dependency-resolution
time, inside use_react_native!, which immediately calls setup_hermes!
when the expression is true.  Even with expo.jsEngine=jsc correctly set
in Podfile.properties.json, RN 0.83 has a secondary jsengine.rb path
(use_hermes() / use_third_party_jsc()) that can re-enable Hermes after
the fact via the USE_HERMES build setting.

The only fully deterministic fix is to replace the dynamic expression
with the literal `false` *before* CocoaPods ever reads the Podfile.

What this script does
---------------------
1.  Locates the use_react_native!( ... ) block using brace-depth
    matching — not a regex over the whole file.
2.  Inside that block only:
    a. If :hermes_enabled is present with any value  → replace with false
    b. If :hermes_enabled is absent                  → insert as first arg
3.  Writes the patched content back to the same file.
4.  Re-reads and asserts exactly one :hermes_enabled => false exists in
    the use_react_native! block.
5.  Exits 0 on success, non-zero on any failure.

What this script does NOT do
-----------------------------
- Does not modify node_modules
- Does not modify React Native source
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
    # Matches:  :hermes_enabled => <value>   where value runs to , or ) or \n
    hermes_pat = re.compile(
        r':hermes_enabled\s*=>\s*[^,\n\)]+',
        re.MULTILINE
    )
    matches = hermes_pat.findall(block)

    if len(matches) > 1:
        print(f"WARN: {len(matches)} :hermes_enabled occurrences found — normalising all to false")

    if matches:
        new_block = hermes_pat.sub(':hermes_enabled => false', block)
        print(f"Replaced {len(matches)} :hermes_enabled occurrence(s): {matches} -> false")
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

    all_hermes = re.findall(r':hermes_enabled\s*=>\s*(\S+)', verify_block)

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
