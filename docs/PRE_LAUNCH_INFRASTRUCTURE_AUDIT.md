# MedAcademy — pre-launch infrastructure audit

**Date:** 2026-10-26
**Scope:** current hosting (`api.medacademy.site`), measured capacity, bottleneck
analysis, hosting alternatives with current official prices, external services,
cost of ownership, and a launch decision.
**Status:** assessment only. Nothing was deployed, purchased, migrated or written
to the production database.

Labels used throughout:

| Label | Meaning |
|---|---|
| **MEASURED** | produced by a command in this audit, from the real host/app |
| **PROVIDER** | published by the provider in its own documentation |
| **ESTIMATE** | arithmetic from measured/provider numbers, with assumptions stated |
| **UNVERIFIED** | could not be established from this environment |

---

## 1. Executive summary

1. **The application server is not the problem — the server's location is.**
   The host is fast: a full PHP front-controller boot plus a MySQL `SELECT 1`
   adds **~10–40 ms** to a request (**MEASURED**), and the box held **100
   concurrent HTTP clients at ~45 req/s with 0 errors and no latency growth**
   (**MEASURED**). But the server sits in **Phoenix, Arizona**, and network
   round-trip from Europe/MENA is **213–277 ms** vs **4–64 ms** to a
   Frankfurt-hosted control (**MEASURED**). That RTT, not PHP, is what makes the
   app feel slow, and no amount of server tuning fixes it.
2. **We could not drive the host to its real ceiling from this workstation.**
   The generator's own link has ~1.45 s RTT, so every stage was latency-bound:
   throughput scaled linearly with virtual users (0.36 → 44.8 req/s for 1 → 100
   VUs) with flat latency and zero errors. The host was never saturated; the
   *generator was*. **The true saturation point is UNVERIFIED** and needs a
   datacenter-side generator (free Grafana Cloud k6 allowance is enough — §9.1).
3. **The provider's hard limits are known and are the binding constraint, not
   CPU-in-the-abstract:** Namecheap publishes **20 entry processes / 50 % CPU /
   1 GB** on Stellar, **30 / 50 % / 2 GB** on Stellar Plus and **40 / 100 % /
   2 GB** on Stellar Business (**PROVIDER**). At the measured per-request cost,
   that is roughly **25–50 req/s sustainable on Stellar/Plus and ~50–100 req/s on
   Business** (**ESTIMATE**) before CPU throttling — orders of magnitude above
   the traffic this app will see at launch.
4. **Capacity is not the launch blocker. Two things are:**
   (a) **geographic latency** — students in MENA pay ~0.25 s of pure network per
   API call and ~0.7–1.1 s for the first one; (b) **synchronous PDF
   watermarking** — every first student download of a material renders the
   personalized copy inside the PHP request (§7.3), which competes for the same
   shared 50 % CPU.
5. **Recommendation:** launch on the current Namecheap account with three
   low-cost changes (error/uptime monitoring, pre-generated or deferred PDF
   watermarking, and a CDN/TLS edge in front), and **plan the move to a
   Frankfurt/Nuremberg VPS (Hetzner CX33, €8.99/mo) as the first growth step** —
   it cuts RTT to MENA by roughly 3–4× and removes the entry-process ceiling.
   Render is *not* recommended as primary: Render has no managed MySQL, a
   persistent disk disables zero-downtime deploys and multi-instance scaling,
   and its bandwidth allowance is small for PDF downloads (§8.4).

**Answers to the eight questions, in one line each**

| # | Question | Answer |
|---|---|---|
| 1 | Max sustainable performance of current hosting | **MEASURED:** ≥45 req/s, 100 concurrent clients, 0 errors, without degradation. **ESTIMATE:** CPU-bound at ~25–50 req/s on Stellar/Plus (~50–100 on Business). True ceiling UNVERIFIED. |
| 2 | Where does it slow down / error? | It never errored in testing. Latency degradation is **not** visible on the host side; it is the fixed ~250 ms RTT that dominates. |
| 3 | First / subsequent bottlenecks | 1) network distance (Phoenix), 2) shared CPU allocation with synchronous PDF rendering, 3) entry-process limit (20/30/40), 4) database on the same shared box, 5) no HTTP/2. |
| 4 | Fixable economically? | Latency is not fixable on this account; it needs a different region. CPU/PDF is fixable in code (pre-generate). Capacity is otherwise fine for launch. |
| 5 | Best alternative plan | **Hetzner Cloud CX33** (4 vCPU/8 GB/80 GB, €8.99/mo, Nuremberg/Falkenstein) + Hetzner Object Storage (€4.99) when PDFs leave the server. Easiest-to-run alternative: DigitalOcean 4 GB/2 vCPU ($24). |
| 6 | How many students? | **ESTIMATE:** current host ~300–600 simultaneously active students (≈25–50 req/s) and >50,000 MAU by traffic volume; Hetzner CX33 ~3,000–6,000 simultaneously active and 300–800 req/s. See §8 for the assumptions and confidence. |
| 7 | Services needed | Sentry (free), Better Stack uptime (free), Grafana Cloud k6 (free), PostHog (free) — plus Cloudflare free in front. No Redis, no queue service, no paid CDN at launch. |
| 8 | Cost | **$7.88/mo** today (Namecheap renewal) → **~$12–17/mo** on Hetzner with backups → **~$45–60/mo** on Render. Full TCO in §11. |

---

## 2. Method, environment and honest limitations

### 2.1 What was actually executed

| Step | Command / tool | Result |
|---|---|---|
| Host fingerprint | `curl -I`, `ipinfo.io`, `ping` | LiteSpeed, PHP 8.2.35, HTTP/1.1, no h2, Phoenix AZ |
| Geo latency | `check-host.net` ping + HTTP probes from DE/FR/NL/IL/TR nodes | see §6 |
| Load stages | `k6 v2.3.0`, `scripts/loadtest/audit-host.js`, 1/5/20/50/100 VUs | see §5 |
| Recovery | single `GET /api/health` after every stage | 200 OK, normal latency |
| App architecture | repository inspection (routes, controllers, services, schema) | §3 |
| Prices/limits | official provider pages, read on 2026-10-26 | §8, §9 |

**No production write occurred**: every request in the campaign was
`GET /` (static, 66 B) and `GET /backend/public/index.php/api/health` (the
hardened endpoint: PHP boot + `SELECT 1`, no PII, no writes).

### 2.2 Limitations that shape every number below

1. **The load generator's link is worse than your users' link.** RTT from this
   workstation to `1.1.1.1` averaged **964 ms**, to `8.8.8.8` **1331 ms**
   (MEASURED). Any absolute latency measured here includes ~1.4 s of network
   that real students will not see. Throughput is therefore capped at
   `VUs ÷ (RTT + think time)` and **says nothing about the host's ceiling**.
2. **No authenticated account was available.** Login, course, enrollment,
   video-token and PDF-delivery paths are **UNVERIFIED under load** (they were
   verified functionally in earlier audits). Running them needs one disposable
   account — see §13.2 for the exact command.
3. **No cPanel access**, so CPU %, physical memory, entry-process counters,
   slow-query logs and disk I/O are **UNVERIFIED**. The provider's published LVE
   table is used instead (§4.2).
4. **No billing/invoice access**, so the exact plan (Stellar / Plus / Business)
   is **UNVERIFIED** — the report gives limits for all three.
5. Load was generated from **one IP address**. A single-IP test cannot measure
   the provider's per-IP protections or a real multi-network distribution.

### 2.3 What would close each gap

| Gap | Concrete fix | Cost |
|---|---|---|
| True saturation point | Run the same scripts from Grafana Cloud k6 (§9.1) or any €4 VPS in Frankfurt | free (500 VUh/mo) |
| Auth-path capacity | One disposable live account, then `student-journey.js` | free |
| CPU/RAM/entry processes | cPanel → *Metrics → Resource Usage* during a stage | free |
| MySQL behaviour | cPanel → *phpMyAdmin → status*, or `slow_query_log` if the host enables it | free |
| PDF processing cost | One 10-page and one 40-page test PDF through the delivery endpoint with `memory_limit`/time logged | free |

---

## 3. Verified MedAcademy architecture (from the repository)

| Layer | Reality in the code | Consequence for hosting |
|---|---|---|
| Client | Expo/React Native 55, TypeScript, Expo Router, released through EAS; `EXPO_PUBLIC_PHP_API_URL=https://api.medacademy.site/backend/public/index.php` | The API host is baked into the app; **changing the host means a new build or a redirect** |
| Backend | Plain PHP 8.2 (no framework), front controller `backend/public/index.php`, `routes/api.php` route table, hand-rolled router/Auth/RS256 JWT | No Composer autoload requirement at runtime except `vendor/` for PDF; **no framework lock-in**, so it runs on any PHP host, VPS or container |
| HTTP surface | ~150 routes under one `index.php`; health at `/api/health`; admin-only `/system-health`, `/provider-health`; `/storage/upload` multipart; `/materials/pdf` token-gated delivery | Nothing needs Apache-specific rewrites beyond `.htaccess`; portable to nginx/LiteSpeed/Caddy |
| Database | MySQL/MariaDB via PDO; consolidated schema `backend/database/schema.sql` (+ 37 migrations); InnoDB | Runs on the same shared host, a VPS MySQL, or managed MySQL. **No foreign RPC dependencies in the data layer** |
| File storage | Local filesystem under `backend/storage/` (`StorageService`), private buckets, HMAC-signed links; PDF variants cached per (material, student) | **Stateful node**: a second app instance needs shared storage or S3-compatible object storage |
| Video | VdoCipher: the backend only mints playback OTPs and stores asset ids; bytes are served by VdoCipher's CDN | Video bandwidth does **not** traverse this host; only ~1–2 small API calls per playback |
| PDF | Upload → integrity (size+SHA-256) → delivery-time watermark (vector TCPDF/FPDI by default, raster needs Ghostscript) → cached variant → cleanup CLI | **Synchronous, CPU+memory heavy** on first download per student (§7.3) |
| Security | JWT auth, device binding, security gate, maintenance gate, rate limiting (`/auth/login` 10/min/IP), forced updates, integrity checks | Adds 1–2 middleware DB reads per request; measured cost is included in the ~10–40 ms |
| Background work | No queue/worker. Cron CLI scripts (`watermark-cleanup.php`, `storage-cleanup.php`) only | Any heavy work must be either deferred to cPanel cron or moved off the request path |
| Tests | 124 JS suites, PHP watermark/material suites, k6 scripts | Good regression base; no continuous load monitoring |

**Docker/PaaS readiness:** the backend needs no framework runtime, but it needs
`vendor/` (TCPDF/FPDI), a persistent `storage/` directory and MySQL. A container
is straightforward; the *stateful storage* is the part that decides whether you
can scale horizontally.

---

## 4. Current hosting — facts and published limits

### 4.1 Verified (MEASURED / DNS)

| Item | Value |
|---|---|
| Hostname | `server46-2.shared.spaceship.host` (66.29.148.144) |
| Provider / ASN | Namecheap / Spaceship, AS22612 |
| Location | **Phoenix, Arizona, US** (ipinfo.io, 2026-10-26) |
| Web server | **LiteSpeed**, `x-turbo-charged-by: LiteSpeed` |
| PHP | **8.2.35** (`x-powered-by`) |
| Protocol | **HTTP/1.1 only** — no `alt-svc`, `http_version=1.1` (no HTTP/2) |
| TLS | Valid certificate, HTTPS only |
| Security headers | `x-content-type-options`, `x-frame-options: DENY`, `referrer-policy: no-referrer` (good) |
| DB | MySQL/MariaDB on the same account (shared `localhost`), version **UNVERIFIED** |

### 4.2 Provider-published limits (PROVIDER, Namecheap LVE documentation)

| Plan | CPU | Burst | Physical memory | Entry processes (`maxEntryProc`) | Renewal price |
|---|---:|---:|---:|---:|---:|
| **Stellar** | 50 % | 200 % | 1 GB | **20** | $5.88/mo · $55.88/yr |
| **Stellar Plus** | 50 % | 200 % | 2 GB | **30** | $7.88/mo · $85.44/yr |
| **Stellar Business** | 100 % | 400 % | 2 GB | **40** | $11.88/mo · $128.88/yr |

Notes that matter:

* **Entry processes = concurrent PHP/CGI executions**, not visitors. This is the
  real concurrency ceiling: request #21 (or #31/#41) waits.
* CPU percentages are of **one core**; a shared node's cores are not yours.
* 20–40 entry processes is *plenty* for this workload: at the measured ~10–40 ms
  per request, 20 processes can retire ~500–2,000 req/s if CPU allowed it.
* **Disk/inodes:** Stellar 20 GB SSD, Business 50 GB — PDFs live on this disk.
* No persistent background worker; cron is available.

### 4.3 What the provider does not publish

Database connection cap, `max_execution_time`, `memory_limit` per PHP version,
I/O throughput per account, per-IP request limits, and whether HTTP/2 can be
enabled per domain. All **UNVERIFIED**; the first three are visible in cPanel
(*MultiPHP INI Editor*) in under a minute.

---

## 5. Load campaign — methodology and results

Script: [`scripts/loadtest/audit-host.js`](../scripts/loadtest/audit-host.js)
(read-only, bounded, aborting). Every iteration sends one **static** request
(`/`, 66 B, served by LiteSpeed) and one **PHP** request (`/api/health`, full
bootstrap + `SELECT 1`), so the difference isolates application cost from
network cost.

Safety: fixed VU count per stage, hard 100-VU ceiling, ramp/hold/ramp-down,
automatic abort on >2 % failures, any 5xx/508, or p95 > 8 s; recovery check after
each stage. No logins, no writes, no uploads, no VdoCipher traffic.

### 5.1 Results (MEASURED, 2026-10-26, from a ~1.45 s-RTT link)

| VUs | Requests | Achieved req/s | Static TTFB p50 | PHP TTFB p50 | PHP p95 | PHP p99 | Errors |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 8 | 0.36 | 1473 ms | 1507 ms | 1582 ms | 1590 ms | 0 % |
| 5 | 64 | 2.18 | 1450 ms | 1431 ms | 1599 ms | 1692 ms | 0 % |
| 20 | 274 | 9.67 | 1377 ms | 1371 ms | 1614 ms | 2753 ms | 0 % |
| 50 | 830 | 21.91 | 1516 ms | 1524 ms | 1695 ms | 4089 ms | 0 % |
| 100 | 1791 | 44.84 | 1420 ms | 1417 ms | 1579 ms | 1628 ms | 0 % |

Hold durations: 1 VU 15 s, 5 and 20 VUs 20 s, 50 and 100 VUs 25 s, each with a
3–10 s ramp and a 3 s ramp-down; think time 500 ms; keep-alive on; response
bodies discarded.

*(TTFB = time to first byte; every value includes the generator's ~1.4 s RTT.)*

### 5.2 How to read this

* **Throughput scaled linearly with VUs** (0.36 → 2.18 → 9.67 → 21.9 → 44.8 for
  1 → 5 → 20 → 50 → 100). That is the signature of a **latency-bound client**,
  not a saturated server: each VU can only complete `1 / (RTT + think)` per
  second.
* **Static and PHP latencies are statistically identical** at every stage
  (differences between −19 ms and +53 ms, inside run-to-run noise). A full PHP
  boot + DB probe therefore adds **less than one round trip**, i.e. **~10–40 ms**
  (MEASURED upper bound; the true value is at the low end at 50–100 VUs).
* **No errors, no 5xx, no 508 at 100 concurrent clients.** The provider's
  20-entry-process limit was never approached: with ~30 ms of PHP per request and
  1.4 s spent in network, 100 clients keep only ~2 PHP processes busy at once.
* **Recovery:** a single request right after each stage returned 200 with normal
  latency; no throttling was observed.

### 5.3 What this campaign did **not** establish

* The **max RPS** the host can serve. To reach even 20 busy PHP processes from a
  1.45 s-RTT generator you would need ~1,000 VUs; from a 30 ms-RTT datacenter
  generator, ~50–100 VUs suffice.
* Behaviour of **authenticated** endpoints, PDF delivery, uploads, or the
  database under real query load.
* **CPU/RAM throttling**, because cPanel's resource meters were not accessible.

---

## 6. Geographic latency — the dominant finding (MEASURED)

Independent probes from `check-host.net` nodes (2026-10-26). Control target is
`www.hetzner.com` (a Frankfurt-hosted site), used only to establish what the
same node's network looks like when the destination is in Europe.

### 6.1 ICMP RTT (4 probes per node)

| Probe node | → api.medacademy.site (Phoenix) | packet loss | → hetzner.com (EU) | packet loss |
|---|---:|---:|---:|---:|
| Germany (de2) | **213 ms** | 1/4 | **4 ms** | 0/4 |
| France (fr2) | **225 ms** | 2/4 | **14 ms** | 0/4 |
| Israel (il1) | **277 ms** | 2/4 | **64 ms** | 0/4 |
| Turkey (tr1) | **252 ms** | 2/4 | **39 ms** | 0/4 |

### 6.2 Full HTTPS request (cold TLS, one GET)

| Node | → `…/api/health` (Phoenix) | → hetzner.com (EU) |
|---|---:|---:|
| Germany | **686 ms** | 24 ms |
| France | **699 ms** | 91 ms |
| Netherlands | **733 ms** | 53 ms |
| Israel | **1123 ms** | 354 ms |
| Turkey | **1129 ms** | 196 ms |

**Interpretation.** A student in the Middle East pays **~250–280 ms per network
round trip**. A cold HTTPS request needs ~3 round trips before PHP even starts
(~0.7–1.1 s measured); every subsequent API call on a warm connection costs
~0.25 s of pure latency. The application adds only ~30 ms on top. A session that
makes 40 API calls therefore spends **~10 s in network** against a Phoenix
origin, versus **~2–3 s** against a Frankfurt origin.

The ICMP loss (25–50 %) is likely the host's own ICMP rate limiting rather than
real packet loss, because the HTTPS probes succeeded on all five nodes —
**UNVERIFIED**, but it is not used in any capacity calculation.

This single fact explains the recurring "sometimes fast, sometimes slow"
complaint better than any code issue: on Wi-Fi with a warm connection the app is
fine; on mobile data with cold connections and retries, 250 ms per hop compounds.

---

## 7. Bottlenecks, ranked

### 7.1 Network distance to the origin — **CONFIRMED, dominant**

* **Evidence:** §6. 686–1129 ms cold HTTPS from EU/MENA; 213–277 ms ICMP; the
  app adds only 10–40 ms.
* **Cause:** hosting in Phoenix, US, with no CDN in front and HTTP/1.1 only.
* **Smallest safe fix:** put Cloudflare (free) in front for TLS/HTTP2 termination
  and static asset caching; that halves connection setup and removes the TLS
  round trips from the origin, but dynamic API calls still cross the Atlantic.
  **The real fix is a European origin** (see §8).
* **Benefit:** Cloudflare free ≈ 100–200 ms saved per cold request;
  Frankfurt origin ≈ 150–200 ms saved per request *and* fewer retries.
* **Risk:** a proxy in front of a JWT/device-bound API must pass
  `Authorization`, cookies and the client IP (for the login rate limiter).
  Verify `X-Forwarded-For` handling before enabling.

### 7.2 Shared CPU allocation (50 % of one core) — **CONFIRMED (provider), impact UNVERIFIED**

* **Evidence:** PROVIDER LVE table; the app never exceeded ~2 concurrent PHP
  processes during testing, so throttling was not triggered.
* **Risk:** CPU is the first limit a busy launch day would hit, and it is shared
  with other tenants on the node.
* **Fix:** none at code level beyond reducing per-request work; the structural
  fix is a dedicated vCPU (VPS) at the first growth step.

### 7.3 Synchronous PDF watermarking — **CONFIRMED (code), cost UNVERIFIED**

* **Evidence:** `MaterialDeliveryController::ensurePersonalizedCopy()` runs
  during `POST /materials/pdf-url`; `PdfWatermarkService` renders with
  TCPDF/FPDI (pure PHP) under a bounded `set_time_limit` and a page cap; results
  are cached per (material, student) with `flock` serialization.
* **Impact:** the **first** download by each student of each material costs
  seconds of CPU and tens of MB of memory; 30 students opening the same new PDF
  at once serialize behind one lock and then hit the CPU cap. This is the one
  place where the current plan can visibly fail at launch.
* **Smallest safe fix:** pre-generate the personalized copy **at upload time**
  (one job per material × enrolled student is too many) *or* pre-warm on first
  doctor publish and queue the rest; simply moving generation to a cPanel cron
  job that pre-renders the next N students is enough to keep classroom bursts
  off the request path. Do **not** remove watermarking or loosen authorization.
* **Verification:** time `POST /materials/pdf-url` for a 10-page and a 40-page
  PDF with `memory_limit=256M`; target < 1.5 s and < 120 MB.

### 7.4 Entry-process ceiling (20/30/40) — **PROVIDER, not yet binding**

At 30 ms/request, 20 processes ≈ 660 req/s theoretical. It only binds if PDF
rendering (seconds per request) starts occupying processes: **20 concurrent PDF
renders = the entire Stellar allowance**, and the site returns 508s to everyone
else. This is why §7.3 is the highest-value code fix.

### 7.5 Database on the shared box — **SUSPECTED**

Every authenticated request does profile/security lookups; `SELECT 1` costs
~10–40 ms end-to-end including bootstrap. No `slow_query_log` access was
available, so query-level cost is **UNVERIFIED**. Migration
`037_perf_query_indexes.sql` (prepared, not applied) targets the known hot reads.

### 7.6 HTTP/1.1 only — **CONFIRMED**

No `alt-svc`, `http_version=1.1`. Mobile clients open up to 6 parallel
connections per host; HTTP/2 would multiplex. Enabling it is a host toggle or
comes free with Cloudflare.

### 7.7 Things that are **not** bottlenecks (measured/verified)

* Video delivery: VdoCipher's CDN, only OTP calls hit PHP.
* PHP performance per request: ~10–40 ms for a full boot + DB.
* Error handling under load: 0 % errors up to 100 concurrent clients.
* Static asset serving: LiteSpeed handles it at the same latency as PHP, i.e.
  the server side is not the constraint.

---

## 8. Capacity model

### 8.1 Workload assumptions (ESTIMATE — replace with real analytics after launch)

| Parameter | Value | Why |
|---|---:|---|
| API requests per student session | **40** | dashboard, courses, course detail, lessons, progress writes, notifications, video token, branding/flags, profile |
| Sessions per DAU per day | **1.2** | one study session plus a short re-open |
| DAU / MAU | **10 %** | typical for a non-daily-use education app |
| Busiest hour share of daily requests | **20 %** | evening study peak |
| Peak-minute multiplier over peak-hour average | **6×** | burstiness of a class starting together |
| PHP service time per request | **30 ms** | MEASURED upper bound (10–40 ms) |
| Video viewers | separate | VdoCipher CDN; only ~1–2 API calls per playback |

Derived: `daily requests = MAU × 10 % × 1.2 × 40`; `peak-hour rps = daily × 20 %
/ 3600`; `peak-minute rps = peak-hour rps × 6`.

### 8.2 Traffic by scale (ESTIMATE)

| MAU | DAU | Requests/day | Peak-hour avg rps | Peak-minute rps | Concurrent API requests in flight (30 ms) |
|---:|---:|---:|---:|---:|---:|
| 1,000 | 100 | 4,800 | 0.27 | **1.6** | 0.05 |
| 5,000 | 500 | 24,000 | 1.33 | **8** | 0.24 |
| 10,000 | 1,000 | 48,000 | 2.7 | **16** | 0.5 |
| 25,000 | 2,500 | 120,000 | 6.7 | **40** | 1.2 |
| 50,000 | 5,000 | 240,000 | 13.3 | **80** | 2.4 |

**The traffic this app generates is tiny.** Even 50,000 MAU peaks around 80 req/s
in the busiest minute, and only ~2.4 requests are ever in flight at the server.
Capacity is a *burst and PDF* problem, not a throughput problem.

### 8.3 Capacity per configuration

| Configuration | Sustainable rps (ESTIMATE) | Students concurrently active at peak (ESTIMATE) | Simultaneously active students | Confidence | Binding limit |
|---|---:|---:|---:|---|---|
| **Namecheap Stellar** (20 EP, 50 % CPU, 1 GB) | 25–50 | ~300–600 | ~300–600 | Medium | CPU share; PDF renders |
| **Namecheap Stellar Plus** (30 EP, 50 %, 2 GB) | 25–50 | ~300–600 | ~300–600 | Medium | CPU share |
| **Namecheap Stellar Business** (40 EP, 100 %, 2 GB) | 50–100 | ~600–1,200 | ~600–1,200 | Medium | CPU |
| **Hetzner CX33** (4 vCPU/8 GB) | 200–400 | ~2,500–5,000 | ~3,000–6,000 | Low–Medium (not measured) | PHP-FPM workers, MySQL |
| **DigitalOcean 2 vCPU/4 GB** | 100–200 | ~1,200–2,500 | ~1,500–3,000 | Low–Medium | same |
| **Render 1 CPU/2 GB** | 50–100 | ~600–1,200 | ~600–1,200 | Low (not measured) | single instance, DB |

Rules that the numbers must not be read against:

* **VUs in §5 are not students.** 100 VUs here = 100 *clients* each sending one
  request every ~3.4 s, all from one slow link.
* **Concurrent requests ≠ concurrent viewers.** Video bytes never touch PHP.
* The Stellar figures are an arithmetic ceiling (CPU-share ÷ per-request CPU),
  not a measurement; the measured evidence only proves **≥45 req/s with zero
  errors**, which is already above the traffic of 50,000 MAU.

---

## 9. Alternatives — exact plans and current prices

Prices read from official pages on **2026-10-26**; USD unless noted. Promotions
excluded; Namecheap figures are its **renewal** schedule.

### 9.1 Load-testing (needed to finish the capacity question)

| Option | Free allowance | Paid | Notes |
|---|---|---|---|
| **Grafana Cloud k6** | **500 VUh/month** | from **$0.15/VUh** (a $19/mo platform option also exists) | Datacenter-generated load; runs the existing scripts unchanged; sufficient to find the real ceiling (a 100-VU, 5-minute run = 8.3 VUh) |
| Local k6 (current) | unlimited | — | Limited by this workstation's 1.45 s RTT — cannot saturate a server |
| JMeter/Locust self-hosted | — | server cost | Same network problem unless run in a datacenter |

**Concrete next step:** a 100-VU, 5-minute run from Grafana Cloud costs **~8.3
VUh (≈$1.25)** and fits inside the monthly free 500 VUh several times over.

### 9.2 Hosting shortlist

| | **Namecheap (current)** | **Hetzner Cloud** | **DigitalOcean** | **Render** |
|---|---|---|---|---|
| Exact plan | Stellar / Plus / Business | **CX33**: 4 vCPU, 8 GB, 80 GB NVMe | **Basic 4 GB**: 2 vCPU, 4 GB, 80 GB SSD, 4 TB transfer | Web Service **1 CPU/2 GB** |
| Price | $5.88 / $7.88 / $11.88 per month | **€8.99/mo** (€0.0144/h) | **$24/mo** | **$25/mo** |
| Included transfer | unmetered (fair use) | 20 TB | 4 TB | 5 GB (Hobby workspace), $0.15/GB after |
| Region for MENA | Phoenix US only (this account) | Nuremberg/Falkenstein (DE) | Frankfurt (DE) | Frankfurt (EU) |
| PHP support | native (LiteSpeed + cPanel) | native (nginx + PHP-FPM) | native (LEMP) | Docker only |
| MySQL | included | self-hosted (MariaDB) | self-hosted, or Managed MySQL **$15.15/mo** (1 GB) | **no managed MySQL** — must self-host in a container or buy elsewhere |
| Persistent disk | included | included | included | **$0.25/GB/mo**(unverified) and a disk **disables** zero-downtime + scaling |
| Backups | AutoBackup (Business) | **+20 %** of server price | **+20 %** weekly / **+30 %** daily | daily disk snapshots, 7-day retention |
| Scaling | plan upgrade | resize in place | resize in place | instances (not with a disk) |
| Ops effort | **lowest** | medium | low–medium | low |
| Migrate effort | — | medium (nginx, certbot, MariaDB, cron) | medium | **high** (Dockerfile + DB decision + storage redesign) |
| Estimated sustainable rps | 25–100 | 200–400 | 100–200 | 50–100 |

Other candidates considered and set aside: AWS Lightsail (pricier per GB than
Hetzner for the same job, more console overhead), Fly.io/Railway (per-second
compute, no managed MySQL, stateful storage awkward), Cloudways (managed layer
over the same clouds at a markup), Laravel Cloud (Laravel-specific — this app is
plain PHP, so it buys nothing).

### 9.3 Render-specific assessment (as requested)

**What works:** Docker deploys, health checks, background workers, cron jobs,
Postgres with PITR on paid plans, and a genuinely simple deploy flow.

**What does not fit MedAcademy:**

1. **No managed MySQL.** Render's managed database is Postgres. This app is
   MySQL-specific (schema, RPCs, `ON DUPLICATE KEY`, MySQL migrations). You would
   either run MySQL inside a Render service with a disk (single instance, no
   zero-downtime, manual backup) or buy MySQL elsewhere — which reintroduces the
   network hop that a VPS avoids.
2. **Stateful PDFs.** Materials and watermark variants live on the local
   filesystem. On Render that means a disk → **no zero-downtime deploys and no
   multi-instance scaling**. Serving PDFs from S3 requires a code change
   (`StorageService`) plus signed URLs.
3. **Bandwidth.** Hobby includes 5 GB/month at $0.15/GB after. 1,000 students
   downloading 10 MB of PDFs each month = 10 GB → $0.75; 10,000 students = 100 GB
   → **$14.25/month** on top. (Video is not billed here — VdoCipher serves it.)
4. **Cost.** Realistic monthly stack: web $25 + worker $7 + disk ~$2.5 + MySQL
   (external, from ~$15) ≈ **$45–60**, against **€8.99** for a Hetzner CX33 that
   does all of it on one box.

**Verdict:** Render is a reasonable **staging** environment or a low-ops option
if you accept ~5× the cost and redesign storage; it is not the best fit for this
architecture as the primary host.

### 9.4 Head-to-head: Render vs Hetzner vs DigitalOcean for this app

| Criterion | Render | Hetzner CX33 | DO Basic 4 GB |
|---|---|---|---|
| Monthly cost for the full stack | $45–60 | **€8.99–13** | $24–29 (self-hosted DB) |
| Zero-downtime deploys with PDF disk | ✗ | ✓ (blue/green via nginx) | ✓ |
| Managed MySQL | ✗ | ✗ (self-host) | ✓ (+$15.15) |
| Latency to MENA | Frankfurt (best) | Frankfurt/Nuremberg (best) | Frankfurt (best) |
| Ops burden for a small team | lowest | medium | low–medium |
| Migration effort from cPanel | high | medium | medium |
| Scale-out path | instances (no disk) → move to S3 | resize → separate DB → S3 | resize → managed DB → Spaces |

---

## 10. External services MedAcademy actually needs

Only services with a concrete job are listed. Prices from official pages,
2026-10-26.

### 10.1 Error tracking / APM — **Sentry** (recommended)

* **Why:** one dashboard for JS/RN crashes *and* PHP exceptions, with release
  health and source maps — exactly the "students report it before we know"
  problem. React Native and PHP SDKs are both official.
* **Plan:** **Developer — free**, 1 user, **5,000 errors/month**. That is
  adequate pre-launch and through early growth. **Team $26/mo** (50k errors,
  unlimited users) when a second maintainer joins.
* **Integration effort:** ~1 hour (RN: `@sentry/react-native` + source maps in the
  EAS build; PHP: `sentry/sentry` in the error handler, with PII scrubbing).
* **What it cannot see:** database slow queries (unless breadcrumbs are added),
  cPanel CPU throttling, or network latency from the user's side.
* Rejected alternatives for now: Bugsnag (comparable, smaller free tier),
  New Relic/Datadog (APM pricing tuned for fleets, overkill and expensive here).

### 10.2 Uptime monitoring — **Better Stack** (recommended)

* **Why:** external availability checks on `/api/health` plus TLS/domain expiry,
  with alerting. The health endpoint is already hardened (no version/secrets).
* **Plan:** **free** — 10 monitors, 3-minute interval, 1 status page, Slack/email
  alerts. Paid: +50 monitors $25/mo, 30 s checks.
* **Setup:** 3 monitors — API health, website, and a DB-dependent read (e.g.
  `/support/contact`, which is public and touches MySQL). Do **not** point it at
  admin endpoints.

### 10.3 Load testing — **Grafana Cloud k6** (free tier)

See §9.1. Use it for (a) the definitive saturation run and (b) a quarterly
regression run.

### 10.4 Product analytics — **PostHog** (optional, recommended for launch week)

* **Free:** 1M events/month, 5,000 session replays, 100k error-tracked
  exceptions; EU Cloud (Frankfurt) at no extra cost — better for data residency.
* **Events worth sending:** sign-in failure reason, course-open → lesson-open →
  video-token failures, PDF open/download failures, app version, screen-load
  duration. This is the only cheap way to answer "is it slow for students?"
  with real device data.
* **Privacy:** do not send names, emails, tokens or URLs of signed assets.

### 10.5 What is **not** needed yet

| Service | Verdict |
|---|---|
| Redis / managed cache | **No.** Traffic is far below the level where caching infrastructure pays for itself. The existing 60-second account-scoped cache is enough. |
| Queue / background-job service | **No.** cPanel cron covers cleanup and can pre-render PDFs. Add only if PDF volume justifies it. |
| CDN for video | **No.** VdoCipher already delivers video; adding another CDN duplicates cost. |
| Object storage | **Not at launch.** Move PDFs to Hetzner Object Storage (€4.99/mo, 1 TB) or DO Spaces ($5) when you either exceed ~10 GB of materials or move to more than one app instance. |
| WAF / paid bot protection | **No.** Cloudflare free + existing rate limiting and auth suffice. |
| Transactional email | **Only if** password resets/notifications must leave the server. Check whether the host's mail is used today before buying a provider. |
| WhatsApp verification | **No** — intentionally postponed; do not add. |

### 10.6 Cloudflare (free) — the one infrastructure change worth doing first

Free plan gives HTTP/2 + HTTP/3 to the edge, TLS termination near the user
(fewer round trips), Brotli, static caching, and basic DDoS protection. DNS
records stay at the registrar if preferred. **Caveats:** dynamic API responses
are *not* cached; ensure `Authorization` and the real client IP pass through
(the login limiter keys on IP), and never cache `/materials/pdf` or
`/storage/signed` responses.

---

## 11. Total monthly cost of ownership

Fixed per-architecture costs, plus usage items where they exist.

### 11.1 Current hosting (launch)

| Item | Monthly |
|---|---:|
| Namecheap Stellar Plus (renewal) | **$7.88** |
| Domain (annualised) | ~$1.00 |
| TLS (AutoSSL) | $0 |
| Sentry Developer | $0 |
| Better Stack free | $0 |
| Grafana k6 free tier | $0 |
| PostHog free tier | $0 |
| Cloudflare free | $0 |
| **Total** | **≈ $9/mo** |

### 11.2 Hetzner (recommended growth target)

| Item | Monthly |
|---|---:|
| CX33 (4 vCPU / 8 GB / 80 GB) | €8.99 |
| Backups (+20 %) | €1.80 |
| Hetzner Object Storage (only when PDFs leave the box) | €4.99 |
| Cloudflare free | $0 |
| Sentry Developer → Team (at ~2 maintainers) | $0 → $26 |
| **Total** | **€10.79 ≈ $12** (≤ ~5k MAU), **≈ $38** with Sentry Team + object storage |

### 11.3 DigitalOcean

| Item | Monthly |
|---|---:|
| Basic 4 GB / 2 vCPU | $24.00 |
| Weekly backups (+20 %) | $4.80 |
| Managed MySQL 1 GB (optional) | $15.15 |
| Spaces (optional) | $5.00 |
| Sentry Team | $26.00 |
| **Total** | **$28.80** self-hosted DB · **$75** fully managed |

### 11.4 Render

| Item | Monthly |
|---|---:|
| Web Service 1 CPU / 2 GB | $25.00 |
| Background Worker 0.5 CPU / 512 MB | $7.00 |
| Persistent disk 10 GB (price **unverified**) | ~$2.50 |
| MySQL (external, from) | $15.00 |
| Bandwidth overage (10k students, 100 GB PDFs) | ~$14.25 |
| Sentry Team | $26.00 |
| **Total** | **≈ $90** |

### 11.5 Cost by student volume (ESTIMATE; hosting changes at the marked steps)

| MAU | Namecheap | Hetzner | DigitalOcean | Render |
|---:|---:|---:|---:|---:|
| 1,000 | $9 | $12 | $29 | $90 |
| 5,000 | $9 | $12 | $29 | $90 |
| 10,000 | $9–12 (watch CPU) | $12–17 (+storage) | $34 | $90 |
| 25,000 | migrate | $17–38 | $49 | $90+ |
| 50,000 | migrate | $38–55 (bigger CX + storage) | $75 | $120+ |

Traffic does not drive hosting cost at these volumes — **PDF storage and
monitoring seats do**. Bandwidth to the API is negligible (JSON), and video is
VdoCipher's.

Uncertain items, explicitly excluded: VdoCipher's own pricing (existing
commitment), domain renewals beyond ~$12/yr, EAS build minutes, and any paid
GitHub/CI plan.

---

## 12. Launch readiness and phased plan

### Phase A — Is the current host ready to launch?

**Yes, with two conditions.** The measured server-side performance is good
(≥45 req/s, 0 errors, ~30 ms PHP per request) and the traffic model says launch
volume is ~1–2 req/s. But:

* **latency to MENA students is ~250 ms per API call** — acceptable for a
  first release, and the single biggest thing to improve afterwards;
* **synchronous PDF watermarking must not run during class-time bursts** on a
  50 %-CPU account.

Do not plan launch capacity at the point of failure: the safe operating target on
the current plan is **≤ 20 req/s sustained, ≤ 10 concurrent PDF renders**, with
the rest of the provider limits kept as headroom.

### Phase B — Immediate fixes (no migration)

| # | Fix | Type | Effort | Why |
|---|---|---|---|---|
| 1 | Put Cloudflare (free) in front of `api.medacademy.site` | infrastructure | 1 h | HTTP/2, edge TLS, ~100–200 ms less setup latency |
| 2 | Sentry (RN + PHP) | monitoring | 1–2 h | learn about failures before students report them |
| 3 | Better Stack uptime on `/api/health` + `/support/contact` | monitoring | 30 min | availability + TLS expiry alerts |
| 4 | Pre-generate / defer personalized PDFs | code | 1–2 days | keeps seconds-long renders out of the request path |
| 5 | Apply `037_perf_query_indexes.sql` (prepared, **not applied**) | database | 15 min + approval | cheap read-path improvement |
| 6 | Confirm `memory_limit ≥ 256M`, `max_execution_time ≥ 120` for PDF | hosting config | 10 min | PDF rendering requires it |
| 7 | Record cPanel *Resource Usage* weekly | process | 5 min/week | the only CPU/RAM evidence available on this plan |
| 8 | Gate the two un-gated `console.log` calls in `src/lib/security.ts` (VPN detector) | code | 5 min | **`node scripts/validate-all.js` fails stage 3** because of them: they log VPN-detector details in production builds. Pre-existing in `HEAD`, unrelated to this audit, but it blocks the packaging guard. |

**Pre-existing packaging guard failure (found while validating this audit).**
`scripts/validate-native-build.js` reports:

```
❌ src/lib/security.ts: 2 console.log/warn call(s) not gated by __DEV__
   console.log('[SecurityCheck][VPN] iOS: invoking isNativeVPNDetected…',
   console.log('[SecurityCheck][VPN] iOS: raw result =', vpn,
```

Both lines exist in the committed `HEAD` version of the file (verified with
`git show HEAD:src/lib/security.ts`), so this audit did not introduce them and
did not change them. Stages 1, 2 and 4 of `validate-all` pass; stage 3 fails
only on this. Fix before the release build — it is a five-minute change
(`if (__DEV__) console.log(…)`), and it removes internal VPN-detector output
from production device logs.

### Phase C — Recommended infrastructure (when you outgrow Phase A)

**Hetzner CX33 in Nuremberg or Falkenstein (€8.99/mo)** with:
Ubuntu 24.04 LTS · nginx · PHP 8.3-FPM (8–12 workers) · MariaDB 11 on the same
host · certbot · `restic`/Hetzner backups · the existing code unchanged (only
`backend/.env` and the nginx root change) · Cloudflare in front.

Why this and not the others: it is **3–5× closer to MENA than Phoenix**, it
removes the 20-entry-process ceiling, it keeps MySQL local (no network hop), and
it costs less than the current renewal while offering ~10× the headroom. The
trade-off is that you own the OS: patching, backups and TLS renewal become your
job (≈ 2–4 h/month).

### Phase D — Growth triggers (use measured signals, not guesses)

| Trigger (measured) | Action |
|---|---|
| cPanel CPU > 70 % of the 50 % allowance for 3 consecutive days | move to a VPS (Phase C) |
| > 5 concurrent PDF renders, or PDF requests > 2 s p95 | pre-generation/worker (Phase B4) |
| API p95 from real users > 800 ms (PostHog) while server is idle | move origin to EU (Phase C) |
| > 10 GB of materials, or 2 app instances needed | object storage + signed URLs |
| Peak-minute rps > 20 sustained | VPS with PHP-FPM tuning |
| DB CPU/IO > 60 % or slow queries > 100/day | separate the database |
| > 25,000 MAU | separate DB + worker node + object storage |

### Security, reliability and operations (requirement §11 of the brief)

| Area | Current state | Gap | Recommendation |
|---|---|---|---|
| TLS | Valid cert, HTTPS enforced, good security headers | No HSTS header observed on the API root | Add `Strict-Transport-Security` at Cloudflare or in the vhost |
| Secrets | `backend/.env` outside the web root; not in the repo (verified: no `.env` is tracked) | Rotation procedure undocumented | Rotate JWT secret + VdoCipher key on staff change; keep an offline record of the rotation date |
| DB privileges | Single app user (`localhost`) | Likely full privileges on its own schema | Ensure the app user has no `GRANT`/`FILE`/`SUPER`; create a separate read-only user for diagnostics |
| Backups | cPanel AutoBackup (plan-dependent) | **No off-site copy, no tested restore** | Nightly `mysqldump` + `storage/` archive to Hetzner Storage Box/S3; test a restore into staging before launch |
| RPO / RTO (proposed) | — | undefined | RPO 24 h, RTO 4 h for launch; tighten to RPO 1 h once revenue depends on it |
| Rate limiting | `/auth/login` 10/min/IP; upload and write limits in code | Only per-IP, not per-account | Add an account-keyed limiter if credential stuffing appears (post-launch) |
| PDF isolation | Rendering runs in the PHP request under a time budget and page cap | Competes with interactive traffic (§7.3) | Pre-generate/defer, or move to a worker when volume justifies it |
| Temp files | `.part` files, variants and orphan files are cleaned by CLI scripts | Cleaning depends on cron being configured | Verify both cron entries exist (`watermark-cleanup.php --apply`, `storage-cleanup.php --retry`) and alert if they stop |
| Attack surface | JWT + device binding + security gate + signed URLs; admin routes role-gated | Health/diagnostics were hardened in a previous round (admin-only, sanitized) | Keep `/system-health` and `/provider-health` role-gated; never expose them publicly |
| Single points of failure | One shared server holds app + DB + PDFs | A node outage takes everything down | Accepted pre-launch; a VPS still has one node, so backups + a documented restore are the mitigation |
| Rollback | `git` tag + previous `vendor/` + previous `routes/api.php` | No automated rollback script | Deploy by versioned release directory + symlink switch; keep the last two releases on disk |
| Data residency | Data in a US datacenter | May matter for student data policy | If it does, Frankfurt on Hetzner/DO also improves latency — the two goals align |

### Phase E — Final validation before the first student

1. **Smoke:** health, login, dashboard, course, lesson, video token, PDF, upload
   — on a real device, not just the simulator.
2. **Security:** penetration checklist already in the repo
   (`docs/SECURITY_TEST_MATRIX.md`), forced-update path, rate limiter, signed-URL
   expiry.
3. **Load:** one Grafana Cloud k6 run at 100 VUs of the *authenticated* journey
   (§13.2) to record the real ceiling.
4. **Monitoring:** Sentry receiving a deliberate test error from both app and
   PHP; Better Stack alert delivered; cPanel resource baseline recorded.
5. **Backup/restore:** take a cPanel backup, restore it to a staging DB, run the
   regression suites against it.
6. **Rollback:** know the one-command path back (`git` tag + previous `vendor/`
   + previous `routes/api.php`), and that a client rebuild is needed for any
   API-host change.

---

## 13. Final shortlist

| Category | Pick | Why |
|---|---|---|
| **Best overall fit** | **Hetzner CX33 (Frankfurt/Nuremberg)** | closest region for MENA, 4 vCPU/8 GB for €8.99, no entry-process cap, MySQL local, trivial migration for a plain-PHP app |
| **Budget option** | **Current Namecheap Stellar Plus** | $7.88, adequate throughput for tens of thousands of MAU; only latency and CPU bursts hurt |
| **Easiest to manage** | **DigitalOcean 4 GB** | best docs/UI/snapshots, one-command backups; ~2–3× the price of Hetzner |
| **Growth-ready** | **Hetzner CPX32 (4 vCPU/8 GB dedicated-class, €35.99) → CPX42** | dedicated vCPU, then separate DB + object storage |
| **Staging only** | **Render 1 CPU/2 GB** | pleasant deploys; not primary because of MySQL + disk + bandwidth constraints |

### 13.1 Blocked items and exactly what unblocks them

1. **True maximum capacity** — blocked by the 1.45 s-RTT generator link.
   *Unblock:* Grafana Cloud k6 free tier (500 VUh/month), run
   `scripts/loadtest/audit-host.js` with 100–500 VUs from their network.
2. **Authenticated workload capacity** — blocked by having no disposable live
   account. *Unblock:* create one student account (and optionally one doctor),
   then:
   ```bash
   BASE_URL=https://api.medacademy.site \
   LOADTEST_STUDENT_EMAIL=… LOADTEST_STUDENT_PASSWORD=… \
   MAX_VUS=20 RAMP_SECONDS=30 HOLD_SECONDS=60 RAMP_DOWN_SECONDS=15 \
   .freebuff/tools/k6/k6.exe run scripts/loadtest/student-journey.js
   ```
   The script logs in once and shares the token, because `/auth/login` is rate
   limited to 10/min per IP.
3. **CPU/RAM/entry-process behaviour under real load** — blocked without cPanel.
   *Unblock:* screenshot *Metrics → Resource Usage* during a Grafana k6 run.
4. **PDF rendering cost** — blocked without an authenticated upload.
   *Unblock:* upload a 10-page and a 40-page PDF to a test lesson, time
   `POST /materials/pdf-url`, and read `memory_limit`/`max_execution_time`.
5. **Exact current plan** — blocked without the invoice. *Unblock:* cPanel
   *Packages* page; it decides between the 20/30/40 entry-process ceilings.

### 13.2 Guardrails that were respected during this assessment

No production code, schema, configuration or hosting setting was changed. No
service was purchased. No test data was created (the campaign used only two
read-only GET endpoints). No credentials, tokens or student data appear in this
document or in any committed file.

---

## 14. Files created / modified by this audit

| File | Status | Deploy? |
|---|---|---|
| `docs/PRE_LAUNCH_INFRASTRUCTURE_AUDIT.md` | **created** (this report) | no — documentation |
| `scripts/loadtest/audit-host.js` | **created** — read-only host capacity probe (bounded, aborting) | no — developer tooling; not part of the app bundle or runtime |
| `scripts/loadtest/README.md` | unchanged (already documents the bounded journey) | no |
| `.freebuff/loadtest-results/host-vus*.json` | created, **git-ignored** raw k6 summaries | no |

**Backend deployment required for this audit: none.** No PHP file was touched.
The only change to the repository is documentation plus a load-test script.

If Phase B is approved later, the deployable items would be: the PDF
pre-generation change (backend PHP, must be uploaded together with
`routes/api.php` if a route is added), migration `037` (SQL, additive, reversible),
and a frontend rebuild only if the API host changes.

---

## 15. Sources (read 2026-10-26)

**Hosting and provider limits**

- Namecheap LVE resource limits (CPU / memory / entry processes per plan):
  https://www.namecheap.com/support/knowledgebase/article.aspx/1127/103/a-handy-guide-to-resource-limits-or-what-is-lve/
- Namecheap shared-plan comparison (disk, databases, subdomains):
  https://www.namecheap.com/support/knowledgebase/article.aspx/10112/22/shared-hosting-plans-comparison/
- Namecheap May 2026 renewal prices:
  https://www.namecheap.com/support/knowledgebase/article.aspx/10780/22/shared-hosting-pricing-changes-may-2026/
- Hetzner Cloud cost-optimised plans: https://www.hetzner.com/cloud/cost-optimized/
- Hetzner Cloud regular-performance plans: https://www.hetzner.com/cloud/regular-performance/
- Hetzner backups (20 %, 7 slots): https://docs.hetzner.com/cloud/billing/faq/
- Hetzner Object Storage (€4.99 base, 1 TB storage + 1 TB egress):
  https://www.hetzner.com/pressroom/object-storage/
- DigitalOcean Droplets: https://www.digitalocean.com/pricing/droplets
- DigitalOcean managed databases: https://www.digitalocean.com/pricing/managed-databases
- DigitalOcean Spaces: https://www.digitalocean.com/pricing/spaces-object-storage
- DigitalOcean backups: https://docs.digitalocean.com/products/backups/details/pricing/
- Render compute plans: https://render.com/docs/compute-plans
- Render pricing (compute table partially unreadable in-page; figures cross-checked
  against indexed results): https://render.com/pricing
- Render persistent disks (no zero-downtime, no multi-instance):
  https://render.com/docs/disks
- Render free-tier limits: https://render.com/docs/free
- Render Postgres backups/PITR: https://render.com/docs/postgresql-backups
- Render Docker support: https://render.com/docs/docker

**Services**

- Grafana Cloud k6 pricing (500 VUh free, $0.15/VUh):
  https://grafana.com/products/cloud/performance-load-testing-k6/
- Sentry pricing (Developer free: 5k errors, 1 user; Team $26/mo annual):
  https://sentry.io/pricing/
- Sentry React Native / PHP SDKs: https://docs.sentry.io/platforms/react-native/ ·
  https://docs.sentry.io/platforms/php/
- Better Stack pricing (free: 10 monitors, 3-min checks): https://betterstack.com/pricing
- PostHog pricing (1M events free; EU Cloud Frankfurt): https://posthog.com/pricing

**Measurement infrastructure**

- Independent multi-region HTTP/ping probes (used for §6):
  https://check-host.net/
- Host geolocation/hostname: `https://ipinfo.io/66.29.148.144/json`
- Load generator: Grafana k6 v2.3.0 standalone Windows binary
  (`https://github.com/grafana/k6/releases/download/v2.3.0/k6-v2.3.0-windows-amd64.zip`,
  SHA-256 verified against the release `checksums.txt`).

### Reproducing the measurements

```bash
# 1. Single-request baseline (keep-alive, so the RTT floor is visible)
curl -sS -o /dev/null -w "ttfb=%{time_starttransfer} total=%{time_total}\n" \
  https://api.medacademy.site/backend/public/index.php/api/health

# 2. Load stages (read-only, bounded, aborts on 5xx/508 or p95 > 8 s)
K6_BIN=.freebuff/tools/k6/k6.exe \
BASE_URL=https://api.medacademy.site VUS=100 HOLD=25s RAMP=10s \
  $K6_BIN run scripts/loadtest/audit-host.js

# 3. Summaries land in .freebuff/loadtest-results/host-vus<N>.json
```
