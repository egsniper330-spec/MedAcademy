# Third-party notices

MedAcademy is proprietary software, but it is built on third-party components whose
licences require us to keep their copyright and permission notices. This file is
generated — do not edit it by hand:

```bash
node scripts/dependency-license-audit.cjs
```

Generated: 2026-10-25T21:12:17.752Z

Full licence texts are installed alongside each package:
`node_modules/<package>/LICENSE*` for JavaScript, `backend/vendor/<vendor>/<package>/`
for PHP. Where a package ships no separate licence file, the licence identifier in
its `package.json` / Composer metadata is authoritative.

## Components with a notice obligation outside the package managers

### plyr (vendored browser build)

- Version: 3.8.4
- Location: `public/player/plyr.js, public/player/plyr.css`
- Licence: MIT
- Used for: runtime (served to the WebView player)
- Evidence: npm plyr@3.8.4 package.json; upstream https://github.com/sampotts/plyr/blob/master/LICENSE.md
- Note: minified distribution copied into public/; attribution must ship beside it (see THIRD_PARTY_NOTICES.md)

### DejaVu Sans (PDF watermark face)

- Version: 2.34 (shipped inside tecnickcom/tcpdf)
- Location: `backend/vendor/tecnickcom/tcpdf/fonts/dejavu-fonts-ttf-2.34/`
- Licence: Bitstream Vera Fonts Licence + Arev/DejaVu public-domain additions
- Used for: runtime (glyph subset embedded in each delivered PDF)
- Evidence: backend/vendor/tecnickcom/tcpdf/fonts/dejavu-fonts-ttf-2.34/LICENSE
- Note: redistribution is allowed; the licence must accompany the font and derived names must not use the reserved names

### VdoCipher React Native bridge + native SDK

- Version: vdocipher-rn-bridge 2.0.1 + com.vdocipher SDK (Maven, https://github.com/VdoCipher/maven-repo)
- Location: `node_modules/vdocipher-rn-bridge, patches/vdocipher-rn-bridge+2.0.1.patch`
- Licence: (none declared)
- Used for: runtime (video playback / DRM)
- Evidence: node_modules/vdocipher-rn-bridge/package.json — "license": "" and no LICENSE file in the tarball
- Note: no licence grant is shipped with the bridge, and we additionally patch its Java source
- Note: commercial use rests on the VdoCipher service agreement, not on an OSS licence — obtain written terms

### AndroidX / Jetpack + Kotlin + Expo native modules

- Version: resolved graph — see docs/android-dependency-report.txt
- Location: `android/ (Gradle-resolved Maven artifacts)`
- Licence: Apache-2.0 (dominant) / MIT
- Used for: native app runtime
- Evidence: individually audited: every artifact on releaseRuntimeClasspath is in the inventory android section, most with the licence read from its POM
- Note: this entry is the platform layer at a glance; the per-artifact verdicts (including the 14 proprietary Google artifacts) are authoritative
- Note: transitive and non-replaceable on Android; notices are carried by the artifacts themselves

### iOS CocoaPods (Expo modules, React Native)

- Version: unresolved locally — no Podfile.lock/Pods in this checkout
- Location: `ios/Podfile`
- Licence: MIT / Apache-2.0 (per upstream package)
- Used for: native app runtime
- Evidence: cannot be verified without a macOS `pod install`; declared versions come from package.json only
- Note: flagged unverified: the audited npm versions are the input, the resolved pods are not

### PDFium (pdfium-render helper)

- Version: 158.0.8125.0 (bblanchon/pdfium-binaries, chromium/8125)
- Location: `backend/bin/pdfium_render` and `backend/pdfium/lib/libpdfium.so`
- Licence: BSD-3-Clause (PDFium source); the builder scripts are MIT
- Used for: student PDF raster engine (production)
- Evidence: backend/docs/PDF_WATERMARK_LICENSING.md

## PHP backend

| Package | Version | Licence |
|---|---|---|
| setasign/fpdf | 1.9.0 | [MIT](https://opensource.org/license/mit) |
| setasign/fpdi | v2.6.9 | [MIT](https://opensource.org/license/mit) |
| tecnickcom/tcpdf | 6.11.4 | [LGPL-3.0-or-later](https://www.gnu.org/licenses/lgpl-3.0.html) |

## Android / Maven (resolved graph)

`releaseRuntimeClasspath` resolves to **286 artifacts**
(read from `docs/android-dependency-report.txt`; licence evidence: `pom` × 244, `group-map` × 39, `none` × 1, `artifact` × 2).

The Apache-2.0 artifacts below carry their own `NOTICE` files, which the Android Gradle
Plugin merges into the APK; they are not re-listed here. Artifacts whose licence is
neither MIT nor Apache-2.0 are listed explicitly:

| Artifact | Version | Licence | Evidence |
|---|---|---|---|
| androidx.datastore:datastore-preferences-external-protobuf | 1.1.7 | BSD-3-Clause | pom |
| com.android.installreferrer:installreferrer | 2.2 | Proprietary | pom |
| com.facebook.device.yearclass:yearclass | 2.1.0 | BSD-3-Clause | pom |
| com.github.bumptech.glide:annotations | 5.0.5 | BSD-2-Clause OR Apache-2.0 | pom |
| com.github.bumptech.glide:avif-integration | 5.0.5 | BSD-2-Clause OR Apache-2.0 | pom |
| com.github.bumptech.glide:disklrucache | 5.0.5 | BSD-2-Clause OR Apache-2.0 | pom |
| com.github.bumptech.glide:gifdecoder | 5.0.5 | BSD-2-Clause OR Apache-2.0 | pom |
| com.github.bumptech.glide:glide | 5.0.5 | BSD-2-Clause OR Apache-2.0 | pom |
| com.github.bumptech.glide:okhttp3-integration | 5.0.5 | BSD-2-Clause OR Apache-2.0 | pom |
| com.google.android.gms:play-services-base | 18.5.0 | Proprietary | pom |
| com.google.android.gms:play-services-basement | 18.5.0 | Proprietary | pom |
| com.google.android.gms:play-services-cast | 22.1.0 | Proprietary | pom |
| com.google.android.gms:play-services-cast-framework | 22.1.0 | Proprietary | pom |
| com.google.android.gms:play-services-cloud-messaging | 17.2.0 | Proprietary | pom |
| com.google.android.gms:play-services-cronet | 18.0.1 | Proprietary | pom |
| com.google.android.gms:play-services-flags | 18.1.0 | Proprietary | pom |
| com.google.android.gms:play-services-stats | 17.0.2 | Proprietary | pom |
| com.google.android.gms:play-services-tasks | 18.2.0 | Proprietary | pom |
| com.google.android.play:core-common | 2.0.4 | Proprietary | pom |
| com.google.android.play:integrity | 1.5.0 | Proprietary | pom |
| com.google.firebase:firebase-iid-interop | 17.1.0 | Proprietary | pom |
| com.google.firebase:firebase-measurement-connector | 19.0.0 | Proprietary | pom |
| com.google.protobuf:protobuf-javalite | 4.26.1 | BSD-3-Clause | group-map |
| com.parse.bolts:bolts-tasks | 1.4.0 | BSD-3-Clause | pom |
| com.vdocipher.aegis:vdocipher-android | 1.29.9 | (not resolved) | none |
| org.aomedia.avif.android:avif | 1.1.1.14d8e3c4 | BSD-2-Clause | pom |
| org.chromium.net:cronet-api | 72.3626.96 | Chromium and built-in dependencies | pom |

## JavaScript / npm

1122 installed packages. The table lists every non-MIT licence; all remaining packages
are MIT and are covered by the same notice text (see `node_modules/<package>/LICENSE`).

| Package | Version | Licence |
|---|---|---|
| @eslint/config-array | 0.21.2 | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| @eslint/config-helpers | 0.4.2 | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| @eslint/core | 0.17.0 | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| @eslint/object-schema | 2.1.7 | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| @eslint/plugin-kit | 0.4.1 | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| @expo-google-fonts/material-symbols | 0.4.43 | MIT AND Apache-2.0 |
| @humanfs/core | 0.19.2 | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| @humanfs/node | 0.16.8 | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| @humanfs/types | 0.15.0 | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| @humanwhocodes/module-importer | 1.0.1 | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| @humanwhocodes/retry | 0.4.3 | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| @isaacs/ttlcache | 1.4.1 | [ISC](https://opensource.org/license/isc-license-txt) |
| @istanbuljs/load-nyc-config | 1.1.0 | [ISC](https://opensource.org/license/isc-license-txt) |
| @react-native/debugger-frontend | 0.83.10 | [BSD-3-Clause](https://opensource.org/license/bsd-3-clause) |
| @sinonjs/commons | 3.0.1 | [BSD-3-Clause](https://opensource.org/license/bsd-3-clause) |
| @sinonjs/fake-timers | 10.3.0 | [BSD-3-Clause](https://opensource.org/license/bsd-3-clause) |
| @ungap/structured-clone | 1.3.3 | [ISC](https://opensource.org/license/isc-license-txt) |
| @yarnpkg/lockfile | 1.1.0 | [BSD-2-Clause](https://opensource.org/license/bsd-2-clause) |
| anymatch | 3.1.3 | [ISC](https://opensource.org/license/isc-license-txt) |
| argparse | 2.0.1 | [Python-2.0](https://opensource.org/license/python-2.0) |
| babel-plugin-istanbul | 6.1.1 | [BSD-3-Clause](https://opensource.org/license/bsd-3-clause) |
| baseline-browser-mapping | 2.11.13 | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| big-integer | 1.6.52 | [Unlicense](https://unlicense.org/) |
| boolbase | 1.0.0 | [ISC](https://opensource.org/license/isc-license-txt) |
| bser | 2.1.1 | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| buffers | 0.1.1 | (none declared) |
| caniuse-lite | 1.0.30001809 | [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) |
| chrome-launcher | 0.15.2 | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| chromium-edge-launcher | 0.2.0 | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| class-variance-authority | 0.7.1 | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| cliui | 8.0.1 | [ISC](https://opensource.org/license/isc-license-txt) |
| crc-32 | 1.2.2 | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| css-select | 5.2.2 | [BSD-2-Clause](https://opensource.org/license/bsd-2-clause) |
| css-what | 6.2.2 | [BSD-2-Clause](https://opensource.org/license/bsd-2-clause) |
| detect-libc | 1.0.3 | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| detect-libc | 2.1.2 | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| didyoumean | 1.2.2 | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| doctrine | 2.1.0 | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| domelementtype | 2.3.0 | [BSD-2-Clause](https://opensource.org/license/bsd-2-clause) |
| domhandler | 5.0.3 | [BSD-2-Clause](https://opensource.org/license/bsd-2-clause) |
| domutils | 3.2.2 | [BSD-2-Clause](https://opensource.org/license/bsd-2-clause) |
| duplexer2 | 0.1.4 | [BSD-3-Clause](https://opensource.org/license/bsd-3-clause) |
| electron-to-chromium | 1.5.405 | [ISC](https://opensource.org/license/isc-license-txt) |
| entities | 4.5.0 | [BSD-2-Clause](https://opensource.org/license/bsd-2-clause) |
| eslint-import-resolver-typescript | 3.10.1 | [ISC](https://opensource.org/license/isc-license-txt) |
| eslint-scope | 8.4.0 | [BSD-2-Clause](https://opensource.org/license/bsd-2-clause) |
| eslint-visitor-keys | 3.4.3 | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| eslint-visitor-keys | 4.2.1 | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| eslint-visitor-keys | 5.0.1 | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| espree | 10.4.0 | [BSD-2-Clause](https://opensource.org/license/bsd-2-clause) |
| esprima | 4.0.1 | [BSD-2-Clause](https://opensource.org/license/bsd-2-clause) |
| esquery | 1.7.0 | [BSD-3-Clause](https://opensource.org/license/bsd-3-clause) |
| esrecurse | 4.3.0 | [BSD-2-Clause](https://opensource.org/license/bsd-2-clause) |
| estraverse | 5.3.0 | [BSD-2-Clause](https://opensource.org/license/bsd-2-clause) |
| esutils | 2.0.3 | [BSD-2-Clause](https://opensource.org/license/bsd-2-clause) |
| exponential-backoff | 3.1.3 | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| fastq | 1.20.1 | [ISC](https://opensource.org/license/isc-license-txt) |
| fb-watchman | 2.0.2 | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| find-yarn-workspace-root | 2.0.0 | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| flatted | 3.4.4 | [ISC](https://opensource.org/license/isc-license-txt) |
| fontfaceobserver | 2.3.0 | [BSD-2-Clause](https://opensource.org/license/bsd-2-clause) |
| fs.realpath | 1.0.0 | [ISC](https://opensource.org/license/isc-license-txt) |
| fstream | 1.0.12 | [ISC](https://opensource.org/license/isc-license-txt) |
| get-caller-file | 2.0.5 | [ISC](https://opensource.org/license/isc-license-txt) |
| glob | 13.0.6 | [BlueOak-1.0.0](https://blueoakcouncil.org/license/1.0.0) |
| glob | 7.2.3 | [ISC](https://opensource.org/license/isc-license-txt) |
| glob-parent | 5.1.2 | [ISC](https://opensource.org/license/isc-license-txt) |
| glob-parent | 6.0.2 | [ISC](https://opensource.org/license/isc-license-txt) |
| graceful-fs | 4.2.11 | [ISC](https://opensource.org/license/isc-license-txt) |
| hoist-non-react-statics | 3.3.2 | [BSD-3-Clause](https://opensource.org/license/bsd-3-clause) |
| hosted-git-info | 7.0.2 | [ISC](https://opensource.org/license/isc-license-txt) |
| hyphenate-style-name | 1.1.0 | [BSD-3-Clause](https://opensource.org/license/bsd-3-clause) |
| ieee754 | 1.2.1 | [BSD-3-Clause](https://opensource.org/license/bsd-3-clause) |
| inflight | 1.0.6 | [ISC](https://opensource.org/license/isc-license-txt) |
| inherits | 2.0.4 | [ISC](https://opensource.org/license/isc-license-txt) |
| isexe | 2.0.0 | [ISC](https://opensource.org/license/isc-license-txt) |
| istanbul-lib-coverage | 3.2.2 | [BSD-3-Clause](https://opensource.org/license/bsd-3-clause) |
| istanbul-lib-instrument | 5.2.1 | [BSD-3-Clause](https://opensource.org/license/bsd-3-clause) |
| jsc-safe-url | 0.2.4 | [0BSD](https://opensource.org/license/0bsd) |
| jsonify | 0.0.1 | Public Domain |
| lighthouse-logger | 1.4.2 | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| lightningcss | 1.27.0 | [MPL-2.0](https://www.mozilla.org/MPL/2.0/) |
| lightningcss | 1.33.0 | [MPL-2.0](https://www.mozilla.org/MPL/2.0/) |
| lightningcss-win32-x64-msvc | 1.27.0 | [MPL-2.0](https://www.mozilla.org/MPL/2.0/) |
| lightningcss-win32-x64-msvc | 1.33.0 | [MPL-2.0](https://www.mozilla.org/MPL/2.0/) |
| listenercount | 1.0.1 | [ISC](https://opensource.org/license/isc-license-txt) |
| lru-cache | 10.4.3 | [ISC](https://opensource.org/license/isc-license-txt) |
| lru-cache | 11.5.2 | [BlueOak-1.0.0](https://blueoakcouncil.org/license/1.0.0) |
| lru-cache | 5.1.1 | [ISC](https://opensource.org/license/isc-license-txt) |
| lucide-react-native | 1.31.0 | [ISC](https://opensource.org/license/isc-license-txt) |
| makeerror | 1.0.12 | [BSD-3-Clause](https://opensource.org/license/bsd-3-clause) |
| marky | 1.3.0 | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| mdn-data | 2.0.14 | CC0-1.0 |
| minimatch | 10.2.6 | [BlueOak-1.0.0](https://blueoakcouncil.org/license/1.0.0) |
| minimatch | 3.1.5 | [ISC](https://opensource.org/license/isc-license-txt) |
| minimatch | 5.1.9 | [ISC](https://opensource.org/license/isc-license-txt) |
| minipass | 7.1.3 | [BlueOak-1.0.0](https://blueoakcouncil.org/license/1.0.0) |
| node-forge | 1.4.0 | (BSD-3-Clause OR GPL-2.0) |
| npm-package-arg | 11.0.3 | [ISC](https://opensource.org/license/isc-license-txt) |
| nth-check | 2.1.1 | [BSD-2-Clause](https://opensource.org/license/bsd-2-clause) |
| once | 1.4.0 | [ISC](https://opensource.org/license/isc-license-txt) |
| pako | 1.0.11 | (MIT AND Zlib) |
| path-scurry | 2.0.2 | [BlueOak-1.0.0](https://blueoakcouncil.org/license/1.0.0) |
| php-parser | 3.7.0 | [BSD-3-Clause](https://opensource.org/license/bsd-3-clause) |
| picocolors | 1.1.1 | [ISC](https://opensource.org/license/isc-license-txt) |
| proc-log | 4.2.0 | [ISC](https://opensource.org/license/isc-license-txt) |
| readdir-glob | 1.1.3 | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| regjsparser | 0.13.2 | [BSD-2-Clause](https://opensource.org/license/bsd-2-clause) |
| rimraf | 2.7.1 | [ISC](https://opensource.org/license/isc-license-txt) |
| rimraf | 3.0.2 | [ISC](https://opensource.org/license/isc-license-txt) |
| rtl-detect | 1.1.2 | [BSD-3-Clause](https://opensource.org/license/bsd-3-clause) |
| sax | 1.6.1 | [BlueOak-1.0.0](https://blueoakcouncil.org/license/1.0.0) |
| saxes | 5.0.1 | [ISC](https://opensource.org/license/isc-license-txt) |
| semver | 6.3.1 | [ISC](https://opensource.org/license/isc-license-txt) |
| semver | 7.6.3 | [ISC](https://opensource.org/license/isc-license-txt) |
| semver | 7.7.3 | [ISC](https://opensource.org/license/isc-license-txt) |
| semver | 7.8.5 | [ISC](https://opensource.org/license/isc-license-txt) |
| setprototypeof | 1.2.0 | [ISC](https://opensource.org/license/isc-license-txt) |
| signal-exit | 3.0.7 | [ISC](https://opensource.org/license/isc-license-txt) |
| source-map | 0.5.7 | [BSD-3-Clause](https://opensource.org/license/bsd-3-clause) |
| source-map | 0.6.1 | [BSD-3-Clause](https://opensource.org/license/bsd-3-clause) |
| source-map-js | 1.2.2 | [BSD-3-Clause](https://opensource.org/license/bsd-3-clause) |
| sprintf-js | 1.0.3 | [BSD-3-Clause](https://opensource.org/license/bsd-3-clause) |
| stream-buffers | 2.2.0 | [Unlicense](https://unlicense.org/) |
| terser | 5.50.0 | [BSD-2-Clause](https://opensource.org/license/bsd-2-clause) |
| test-exclude | 6.0.0 | [ISC](https://opensource.org/license/isc-license-txt) |
| tmpl | 1.0.5 | [BSD-3-Clause](https://opensource.org/license/bsd-3-clause) |
| ts-interface-checker | 0.1.13 | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| tslib | 2.8.1 | [0BSD](https://opensource.org/license/0bsd) |
| typescript | 5.9.3 | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| uri-js | 4.4.1 | [BSD-2-Clause](https://opensource.org/license/bsd-2-clause) |
| validate-npm-package-name | 5.0.1 | [ISC](https://opensource.org/license/isc-license-txt) |
| vdocipher-rn-bridge | 2.0.1 | (none declared) |
| walker | 1.0.8 | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| webidl-conversions | 3.0.1 | [BSD-2-Clause](https://opensource.org/license/bsd-2-clause) |
| which | 2.0.2 | [ISC](https://opensource.org/license/isc-license-txt) |
| wrappy | 1.0.2 | [ISC](https://opensource.org/license/isc-license-txt) |
| write-file-atomic | 4.0.2 | [ISC](https://opensource.org/license/isc-license-txt) |
| xcode | 4.0.0 | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| y18n | 5.0.8 | [ISC](https://opensource.org/license/isc-license-txt) |
| yallist | 3.1.1 | [ISC](https://opensource.org/license/isc-license-txt) |
| yaml | 2.9.0 | [ISC](https://opensource.org/license/isc-license-txt) |
| yargs-parser | 21.1.1 | [ISC](https://opensource.org/license/isc-license-txt) |

Packages whose licence is MIT (or MIT chosen from a dual licence) are not listed
individually here to keep this file reviewable; the machine-readable inventory at
`docs/dependency-license-inventory.json` lists every one of them with its version.

## Fonts and media

- DejaVu Sans (embedded in watermarked PDFs) — Bitstream Vera Fonts Licence,
  shipped at `backend/vendor/tecnickcom/tcpdf/fonts/dejavu-fonts-ttf-2.34/LICENSE`.
- Plyr 3.8.4 (`public/player/plyr.js`, `public/player/plyr.css`) — MIT,
  see `public/player/THIRD_PARTY_NOTICES.txt`.

## What this file does not do

A notice is not a licence verification. The verdicts, versions and open gaps are
argued in `DEPENDENCY_LICENSE_AUDIT.md`; read that before shipping to a store or
signing a customer contract.
