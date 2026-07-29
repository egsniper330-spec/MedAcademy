# Requirements Document

## 1. Application Overview

### Application Name
MedAcademy

### Application Description
MedAcademy is an enterprise-grade medical education platform designed for mobile devices (Android and iOS). It enables medical professionals to create and deliver educational courses, while students access structured learning content with secure video playback, PDF materials, and progress tracking. The platform supports multiple user roles with granular permission controls and emphasizes security, device management, and audit compliance. The Enterprise Administration Panel V2 provides comprehensive management capabilities for universities, faculties, academic levels, credits, activation codes, system health, revenue tracking, and advanced administrative operations. The platform includes a complete Enterprise Device Management System with configurable device limits, device registration, device reset, device blocking, login history, and audit logging. The platform now includes advanced course lifecycle management with estimated study time tracking, course archive system, archive management, course restoration, permanent deletion controls, student safety guarantees, search filtering, analytics tracking, and comprehensive audit logging. Doctors can now create student accounts directly, assign courses via activation codes or credits, and perform bulk student imports. The platform features production-grade Enterprise Security Hardening with root/jailbreak detection, VPN detection, proxy detection, SSL pinning, debug detection, screenshot protection, screen recording protection, app integrity verification, device risk scoring, security event logging, Super Admin security dashboard, and configurable policy engine. The platform now includes Content Protection & Security Policy with Android screen protection (FLAG_SECURE), iOS screen recording detection, iOS screenshot detection, strike system for violations, auto logout, account suspension, admin recovery, security logs, and Super Admin configuration interface. The platform now includes Production Hardening Sprint enhancements with database integrity constraints (unique constraints, check constraints, foreign key cascades), transaction ID tracking for all business events, enhanced credit ledger with full transaction history, structured error responses, Health Check Dashboard for system diagnostics, self-test runner for automated validation, DB audit panel for detecting inconsistencies, auto repair capabilities, and comprehensive export functionality. The platform now includes Video Provider Management system enabling Super Admin to control global video provider availability (Plyr, VdoCipher) and configure per-teacher provider permissions with scalable architecture supporting future providers.

## 2. Target Users and Usage Scenarios

### Target Users
- **Students**: Medical learners accessing courses, watching videos, downloading PDFs, tracking progress, viewing estimated study time and time remaining
- **Doctors**: Course creators managing content, students, credits, setting lesson estimated study time, archiving courses, restoring archived courses, creating student accounts, assigning courses via credits or activation codes, bulk importing students, uploading videos via enabled providers
- **Assistants**: Support staff with configurable permissions assigned by Admin or Doctor
- **Admins**: Platform managers controlling users, courses, credits, activation codes, universities, faculties, academic levels, device limits, device resets, device blocking, archiving courses, restoring archived courses, viewing archived courses, removing account suspensions, resetting violations, clearing strike counts, restoring accounts, accessing Health Check Dashboard, running system diagnostics, viewing DB audit panel, executing auto repair, exporting system reports, and system operations
- **Super Admins**: Full platform access including admin management, system configuration, security diagnostics, maintenance mode, branding, feature flags, impersonation, revenue tracking, unlimited device access, archiving courses, restoring archived courses, viewing archived courses, permanently deleting courses, configuring security policies, configuring content protection policies, monitoring security events, accessing Health Check Dashboard, running full system checks, viewing DB audit panel, executing auto repair, exporting system reports, managing video providers globally, configuring per-teacher video provider permissions

### Core Usage Scenarios
- Students enroll in courses via activation codes or admin assignment, watch secure videos with content protection (screenshot and screen recording blocked), download PDFs, track learning progress, view estimated study time and time remaining, change password on first login
- Doctors create courses with sections and lessons, set estimated study time per lesson, upload videos via enabled providers (Plyr or VdoCipher based on global and per-teacher permissions), upload PDFs, manage enrolled students, consume credits, manage assistants, archive courses, restore archived courses, create student accounts, assign courses via credits or activation codes, bulk import students
- Assistants perform assigned tasks based on permissions granted by doctors or admins
- Admins manage users, universities, faculties, academic levels, allocate credits, generate activation codes, monitor device registrations, configure device limits, reset devices, block/unblock devices, review login history, review audit logs, archive courses, restore archived courses, view archived courses, remove account suspensions, reset violations, clear strike counts, restore accounts, access system health metrics, run system diagnostics via Health Check Dashboard, view DB audit panel, execute auto repair, export system reports
- Super Admins configure platform settings, manage admins, control feature flags, enable maintenance mode, customize branding, impersonate users, monitor revenue, oversee system health, access unlimited devices without restrictions, archive courses, restore archived courses, view archived courses, permanently delete courses, configure security policies, configure content protection policies (screenshot policy, recording policy, violation limit, warning message, auto logout toggle, auto suspend toggle), monitor security events, access Health Check Dashboard, run full system checks, view DB audit panel, execute auto repair, export system reports, manage video providers globally (enable/disable Plyr, enable/disable VdoCipher), configure per-teacher video provider permissions (allow/disallow Plyr uploads, allow/disallow VdoCipher uploads)

## 3. Page Structure and Functionality

### Page Hierarchy

```
MedAcademy Mobile App
├── Authentication Flow
│   ├── Login Screen
│   ├── Register Screen
│   ├── Forgot Password Screen
│   ├── Force Password Change Screen (First Login)
│   ├── Security Warning Screen
│   └── Account Suspended Screen
├── Global Navigation (Side Drawer)
│   ├── Dashboard
│   ├── Courses
│   ├── Archived Courses (Doctor/Admin/Super Admin only)
│   ├── Profile
│   ├── Devices (Student/Assistant/Admin/Super Admin only)
│   ├── Notifications
│   ├── Settings
│   ├── Health Check Dashboard (Admin/Super Admin only)
│   └── Logout
├── Student Flow
│   ├── Student Dashboard
│   ├── My Courses Screen
│   ├── Course Details Screen
│   ├── Lesson Screen
│   ├── Activation Code Redemption Screen
│   ├── Student Profile Screen
│   ├── Devices Screen
│   ├── Security Center Screen
│   ├── Notifications Screen
│   └── Content Protection Warning Screen
├── Doctor Flow
│   ├── Doctor Dashboard
│   ├── Course Builder Screen
│   ├── Course Content Management Screen
│   ├── Lesson Management Screen
│   ├── Archived Courses Screen
│   ├── Student Management Screen
│   ├── Create Student Screen
│   ├── Student Creation Confirmation Screen
│   ├── Student Credentials Screen
│   ├── Bulk Import Students Screen
│   ├── Bulk Import Report Screen
│   ├── Add Student via Credits Screen
│   ├── Assistant Management Screen
│   ├── Credit History Screen
│   ├── Doctor Profile Screen
│   └── Security Center Screen
├── Assistant Flow
│   ├── Assistant Dashboard
│   ├── Assigned Features Screen
│   ├── Assistant Profile Screen
│   ├── Devices Screen
│   └── Security Center Screen
├── Admin Flow
│   ├── Admin Dashboard
│   ├── User Management Screen
│   ├── Doctor Management Screen
│   ├── Assistant Management Screen
│   ├── Device Management Screen
│   ├── Course Management Screen
│   ├── Archived Courses Screen
│   ├── Lesson Management Screen
│   ├── University Management Screen
│   ├── Faculty Management Screen
│   ├── Academic Level Management Screen
│   ├── Credits Management Screen
│   ├── Activation Codes Management Screen
│   ├── Video Monitor Screen
│   ├── System Health Screen
│   ├── Health Check Dashboard
│   ├── DB Audit Panel
│   ├── Storage Monitor Screen
│   ├── Audit Logs Screen
│   ├── Reports Screen
│   ├── Notification Center Screen
│   ├── Global Search Screen
│   ├── CMS Pages Management Screen
│   ├── Settings Screen
│   ├── Admin Profile Screen
│   ├── Devices Screen
│   ├── Security Center Screen
│   └── Violation Management Screen
└── Super Admin Flow
    ├── Super Admin Dashboard
    ├── Admin Management Screen
    ├── User Management Screen
    ├── Doctor Management Screen
    ├── Assistant Management Screen
    ├── Device Management Screen
    ├── Course Management Screen
    ├── Archived Courses Screen
    ├── Lesson Management Screen
    ├── University Management Screen
    ├── Faculty Management Screen
    ├── Academic Level Management Screen
    ├── Credits Management Screen
    ├── Activation Codes Management Screen
    ├── Maintenance Mode Screen
    ├── Video Monitor Screen
    ├── System Health Screen
    ├── Health Check Dashboard
    ├── DB Audit Panel
    ├── Revenue Dashboard Screen
    ├── CMS Pages Management Screen
    ├── Branding Screen
    ├── Feature Flags Screen
    ├── Impersonation Screen
    ├── Global Search Screen
    ├── Notification Center Screen
    ├── Audit Logs Screen
    ├── Storage Monitor Screen
    ├── Reports Screen
    ├── Settings Screen
    ├── Devices Screen
    ├── Security Diagnostics Screen
    ├── Security Dashboard Screen
    ├── Security Policy Configuration Screen
    ├── Content Protection Policy Configuration Screen
    ├── Violation Management Screen
    └── Video Providers Management Screen (New)
```

### 3.1 Authentication Flow

(No changes to existing authentication flow)

### 3.2 Global Navigation (Side Drawer)

(No changes to existing navigation)

### 3.3 Student Flow

(No changes to existing student flow)

### 3.4 Doctor Flow

#### Lesson Management Screen
- Lesson details: Title, Description, Estimated Study Time (input field with units: minutes/hours), Duration
- Upload Video button: Display enabled providers only (Plyr, VdoCipher, or both based on global and per-teacher permissions)
- If both providers disabled globally: Hide Upload Video button, display message \"Video uploads are currently disabled by the administrator.\"
- If specific provider disabled for teacher: Hide that provider option or disable with message \"[Provider Name] uploads have been disabled for your account.\"
- Upload PDFs button (multiple files)
- Replace Video button
- Replace PDFs button
- Delete PDF button
- Publish, Hide, Schedule actions

(All other Doctor Flow screens remain unchanged)

### 3.5 Assistant Flow

(No changes to existing assistant flow)

### 3.6 Admin Flow

(No changes to existing admin flow)

### 3.7 Super Admin Flow

#### Video Providers Management Screen (New)
- Global Providers section:
  + Provider list displaying: Provider Name (Plyr, VdoCipher), Status (Enabled/Disabled), Last Updated
  + Toggle switch per provider to enable/disable globally
  + Possible states: Both enabled, Only Plyr enabled, Only VdoCipher enabled, Both disabled
  + If both disabled: Display warning message \"Video uploads are currently disabled for all teachers.\"
- Teachers section:
  + Search bar to find teachers by name, email
  + Teacher list displaying: Teacher Name, Email, Plyr Permission (Enabled/Disabled), VdoCipher Permission (Enabled/Disabled)
  + Toggle switches per teacher per provider to allow/disallow uploads
  + Permission resolution displayed: Final Permission = Global Provider Enabled AND Teacher Provider Enabled
  + If global provider disabled: Display indicator \"Global provider disabled\" and disable teacher toggle
- Save button
- Neumorphic design style: Soft shadows, pillowy tactile look, rounded corners, subtle depth
- On save: Update video_providers table (is_globally_enabled), update teacher_provider_permissions table (is_enabled), generate transaction_id, record audit event with transaction_id

(All other Super Admin Flow screens remain unchanged)

## 4. Business Rules and Logic

### 4.1 Database Integrity Constraints

(Existing constraints remain unchanged)

### 4.2 Transaction ID System

(Existing transaction ID rules remain unchanged, add new business events: Video provider enabled/disabled globally, Teacher provider permission enabled/disabled)

### 4.3 Enhanced Credit Ledger

(No changes)

### 4.4 Structured Error Responses

(Add new error code: PROVIDER_DISABLED)

### 4.5 Health Check Dashboard Rules

(No changes)

### 4.6 DB Audit Panel Rules

(No changes)

### 4.7 Device Registration Policy

(No changes)

### 4.8 Device Limit Configuration

(No changes)

### 4.9 Device Management Rules

(No changes)

### 4.10 Login History Rules

(No changes)

### 4.11 Audit Logging Rules for Device Management

(No changes)

### 4.12 Performance Requirements for Device Management

(No changes)

### 4.13 Credit System Rules

(No changes)

### 4.14 Activation Code Rules

(No changes)

### 4.15 Course Access Rules

(No changes)

### 4.16 Video Playback Rules

(No changes)

### 4.17 PDF Access Rules

(No changes)

### 4.18 Role-Based Access Control

(No changes)

### 4.19 Session Management

(No changes)

### 4.20 Audit Logging Rules

(Add new audit events: Video provider enabled globally, Video provider disabled globally, Teacher provider permission enabled, Teacher provider permission disabled)

### 4.21 Notification Rules

(No changes)

### 4.22 University, Faculty, and Academic Level Rules

(No changes)

### 4.23 Maintenance Mode Rules

(No changes)

### 4.24 Video Monitor Rules

(No changes)

### 4.25 System Health Rules

(No changes)

### 4.26 Revenue Dashboard Rules

(No changes)

### 4.27 CMS Pages Rules

(No changes)

### 4.28 Branding Rules

(No changes)

### 4.29 Feature Flags Rules

(No changes)

### 4.30 Impersonation Rules

(No changes)

### 4.31 Global Search Rules

(No changes)

### 4.32 Storage Monitor Rules

(No changes)

### 4.33 Reports Rules

(No changes)

### 4.34 Settings Rules

(No changes)

### 4.35 Security Requirements

(No changes)

### 4.36 Performance Requirements

(No changes)

### 4.37 Estimated Study Time Rules

(No changes)

### 4.38 Course Archive System Rules

(No changes)

### 4.39 Archive Management Rules

(No changes)

### 4.40 Course Restoration Rules

(No changes)

### 4.41 Permanent Deletion Rules

(No changes)

### 4.42 Student Safety Rules

(No changes)

### 4.43 Search and Filter Rules for Archived Courses

(No changes)

### 4.44 Analytics and Tracking Rules for Archived Courses

(No changes)

### 4.45 Audit Logging Rules for Course Lifecycle

(No changes)

### 4.46 Doctor Create Student Account Rules

(No changes)

### 4.47 Bulk Import Students Rules

(No changes)

### 4.48 First Login Force Password Change Rules

(No changes)

### 4.49 Credit Activation Transaction Rules

(No changes)

### 4.50 Credit Balance Display Rules

(No changes)

### 4.51 Root/Jailbreak Detection Rules

(No changes)

### 4.52 VPN Detection Rules

(No changes)

### 4.53 Proxy Detection Rules

(No changes)

### 4.54 SSL Pinning Rules

(No changes)

### 4.55 Debug Detection Rules

(No changes)

### 4.56 Screenshot Protection Rules

(No changes)

### 4.57 Screen Recording Protection Rules

(No changes)

### 4.58 App Integrity Verification Rules

(No changes)

### 4.59 Device Risk Score Rules

(No changes)

### 4.60 Security Event Logging Rules

(No changes)

### 4.61 Security Dashboard Rules

(No changes)

### 4.62 Security Policy Engine Rules

(No changes)

### 4.63 Content Protection Policy Rules

(No changes)

### 4.64 Strike System Rules

(No changes)

### 4.65 Auto Logout Rules

(No changes)

### 4.66 Account Suspension Rules

(No changes)

### 4.67 Admin Recovery Rules

(No changes)

### 4.68 Violation Logging Rules

(No changes)

### 4.69 Violation Management Rules

(No changes)

### 4.70 Content Protection Analytics Rules

(No changes)

### 4.71 Video Provider Management Rules (New)

#### Global Provider Control
- Super Admin can enable/disable each video provider (Plyr, VdoCipher) independently via Video Providers Management Screen
- Possible global states: Both enabled, Only Plyr enabled, Only VdoCipher enabled, Both disabled
- Global provider status stored in video_providers table with fields: id, provider_key (plyr, vdocipher), display_name (Plyr, VdoCipher), is_globally_enabled (boolean)
- If both providers disabled globally: Teachers cannot upload any videos, Upload Video button is hidden, message displayed \"Video uploads are currently disabled by the administrator.\"

#### Per-Teacher Provider Permissions
- Each teacher has per-provider permissions stored in teacher_provider_permissions table with fields: teacher_id, provider_key (plyr, vdocipher), is_enabled (boolean)
- Super Admin can enable/disable each provider per teacher via Video Providers Management Screen
- If teacher is blocked from a provider: Hide that upload option or disable with message \"[Provider Name] uploads have been disabled for your account.\"

#### Permission Resolution
- Final Permission = Global Provider Enabled AND Teacher Provider Enabled
- If global provider disabled: Teacher permission is irrelevant, provider is unavailable
- If global provider enabled AND teacher permission disabled: Provider is unavailable for that teacher
- If global provider enabled AND teacher permission enabled: Provider is available for that teacher

#### Backend Validation
- Backend must validate provider permissions before: Creating uploads, Generating upload URLs, Creating VdoCipher upload requests, Creating Plyr upload requests
- If blocked provider is requested: Return HTTP 403 with structured error response {success: false, code: \"PROVIDER_DISABLED\", message: \"This upload provider has been disabled.\", transactionId: UUID, timestamp}

#### Database Structure
- video_providers table: Global registry of available providers
  + id (UUID, primary key)
  + provider_key (text, unique, values: plyr, vdocipher)
  + display_name (text, values: Plyr, VdoCipher)
  + is_globally_enabled (boolean, default: true)
  + created_at (timestamptz)
  + updated_at (timestamptz)
- teacher_provider_permissions table: Per-teacher provider overrides
  + id (UUID, primary key)
  + teacher_id (UUID, foreign key to users table)
  + provider_key (text, values: plyr, vdocipher)
  + is_enabled (boolean, default: true)
  + created_at (timestamptz)
  + updated_at (timestamptz)
  + Unique constraint on (teacher_id, provider_key)

#### Scalability
- Database structure supports future providers (Bunny Stream, Vimeo, Cloudflare Stream, Mux) by adding new rows to video_providers table with new provider_key values
- No business logic changes required to add new providers
- UI dynamically renders provider list from video_providers table

#### Audit Logging
- All provider management actions are logged: Video provider enabled globally, Video provider disabled globally, Teacher provider permission enabled, Teacher provider permission disabled
- Audit logs include: Timestamp, Actor (Super Admin), Target (Provider Key or Teacher ID + Provider Key), Action, Old Values (JSONB), New Values (JSONB), Reason (optional), Transaction ID

#### UI Design
- Neumorphic design style: Soft shadows, pillowy tactile look, rounded corners, subtle depth, light background with raised/inset elements
- Global Providers section: Card-based layout with provider name, status badge, toggle switch
- Teachers section: List view with search bar, teacher cards showing name, email, per-provider toggle switches
- Permission resolution indicator: Visual feedback showing final permission state (Enabled/Disabled) based on global and teacher settings

## 5. Exception and Boundary Conditions

| Scenario | Handling |
|----------|----------|
| Doctor attempts to upload video when both providers disabled globally | Hide Upload Video button, display message \"Video uploads are currently disabled by the administrator.\", block upload |
| Doctor attempts to upload video via disabled provider | Hide that provider option or disable with message \"[Provider Name] uploads have been disabled for your account.\", block upload |
| Backend receives upload request for disabled provider | Return HTTP 403 with structured error response {success: false, code: \"PROVIDER_DISABLED\", message: \"This upload provider has been disabled.\", transactionId: UUID, timestamp}, block upload |
| Super Admin disables provider while teachers are actively uploading | Display warning message, gracefully disable provider, cancel in-progress uploads, notify affected teachers |
| Super Admin enables provider after being disabled | Provider becomes immediately available, teachers can upload via enabled provider |
| Super Admin attempts to disable all providers without confirmation | Display confirmation dialog \"Disabling all providers will prevent all teachers from uploading videos. Continue?\", require explicit confirmation |
| Teacher attempts to upload video via provider not in database | Return HTTP 400 with structured error response {success: false, code: \"INVALID_PROVIDER\", message: \"Invalid video provider.\", transactionId: UUID, timestamp}, block upload |
| Teacher provider permission record does not exist | Default to enabled (is_enabled=true), create record on first access |
| Global provider status retrieval fails | Display error message, retry button, use cached status if available |
| Teacher provider permissions retrieval fails | Display error message, retry button, default to disabled for safety |
| Video Providers Management Screen data retrieval fails | Display error message, retry button |
| Video Providers Management Screen save fails | Display error message, rollback changes |
| User attempts to access Video Providers Management Screen without Super Admin role | Display access denied message, redirect to dashboard |
| User attempts to modify provider settings without Super Admin role | Display access denied message, block action |
| Audit log recording fails for provider action | Log error, continue operation, alert Super Admin |
| Future provider added to video_providers table | UI dynamically renders new provider, no code changes required |

(All other existing exception scenarios remain unchanged)

## 6. Acceptance Criteria

1. User opens app, enters email and password, taps Login button, app performs security checks, computes device risk score, applies security policy, checks account status, if force_password_change flag is true then navigate to Force Password Change Screen, else if security warning required navigate to Security Warning Screen, else device is registered automatically, login attempt is recorded to login history with transaction_id, security events are recorded to security event logs with transaction_id, user is navigated to role-specific dashboard
2. Student with temporary password logs in for first time, is redirected to Force Password Change Screen, enters current temporary password, new password, confirm new password, taps Change Password button, password is updated, force_password_change flag is set to false, transaction_id is generated, audit event is recorded with transaction_id, student is navigated to Student Dashboard
3. Student navigates to My Courses, taps a course, views course details with sections and lessons, views course duration, views estimated time remaining, views completed study time, views progress percentage, taps a lesson, watches video with dynamic watermark, SSL pinning enforced, Android: screenshot and screen recording blocked via FLAG_SECURE, content hidden from recent apps switcher, iOS: screen recording detected, screenshot detected, downloads PDF attachment
4. Student navigates to Activation Code Redemption, enters valid code for non-archived course, taps Redeem button, receives confirmation message with transaction_id, course appears in My Courses
5. Doctor navigates to Course Builder, taps Create Course, enters course details, creates sections and lessons, sets estimated study time per lesson, uploads video via enabled provider (Plyr or VdoCipher based on permissions), uploads PDFs, publishes course, course duration is auto-calculated, transaction_id is generated for course creation
6. Doctor navigates to Lesson Management Screen, taps Upload Video button, views enabled providers only (Plyr, VdoCipher, or both based on global and per-teacher permissions), selects provider, uploads video, video upload is validated by backend (provider permissions checked), on success video is uploaded, on failure structured error response is returned with transaction_id
7. Doctor navigates to Lesson Management Screen when both providers disabled globally, Upload Video button is hidden, message displayed \"Video uploads are currently disabled by the administrator.\", doctor cannot upload videos
8. Doctor navigates to Lesson Management Screen when specific provider disabled for teacher, that provider option is hidden or disabled with message \"[Provider Name] uploads have been disabled for your account.\", doctor can only upload via enabled providers
9. Super Admin navigates to Video Providers Management Screen, views Global Providers section showing Plyr (Enabled), VdoCipher (Enabled), taps toggle switch to disable VdoCipher, confirms action, VdoCipher is disabled globally, transaction_id is generated, audit event is recorded with transaction_id, all teachers lose access to VdoCipher uploads
10. Super Admin navigates to Video Providers Management Screen, views Teachers section, searches for teacher by name, views teacher card showing Plyr Permission (Enabled), VdoCipher Permission (Enabled), taps toggle switch to disable Plyr for that teacher, confirms action, teacher loses access to Plyr uploads, transaction_id is generated, audit event is recorded with transaction_id
11. Super Admin navigates to Video Providers Management Screen, disables both Plyr and VdoCipher globally, warning message displayed \"Video uploads are currently disabled for all teachers.\", taps Save, all teachers lose access to video uploads, transaction_id is generated, audit event is recorded with transaction_id
12. Super Admin navigates to Video Providers Management Screen, enables Plyr globally, disables VdoCipher globally, taps Save, teachers can upload via Plyr only, VdoCipher uploads are blocked, transaction_id is generated, audit event is recorded with transaction_id
13. Super Admin navigates to Video Providers Management Screen, enables both Plyr and VdoCipher globally, disables Plyr for specific teacher, taps Save, that teacher can upload via VdoCipher only, Plyr uploads are blocked for that teacher, transaction_id is generated, audit event is recorded with transaction_id
14. Doctor attempts to upload video via disabled provider, backend validates provider permissions, returns HTTP 403 with structured error response {success: false, code: \"PROVIDER_DISABLED\", message: \"This upload provider has been disabled.\", transactionId: UUID, timestamp}, upload is blocked, error message is displayed to doctor
15. Super Admin navigates to Audit Logs, filters by action type (Video provider enabled globally, Video provider disabled globally, Teacher provider permission enabled, Teacher provider permission disabled), views log entries with transaction_ids, taps Export, downloads CSV/Excel/PDF file

(All other existing acceptance criteria remain unchanged)

## 7. Out of Scope for This Release

- Payment gateway integration and e-commerce checkout
- Live streaming functionality
- Social media integration (except WhatsApp deep link)
- Third-party LMS integrations
- Video editing or transcoding within the app
- Gamification features (badges, leaderboards, achievements)
- Discussion forums or community features
- Calendar or scheduling system
- Certificate generation and issuance
- Multi-language content management (UI localization is in scope)
- Advanced analytics and reporting dashboards beyond specified reports
- Mobile web version or desktop application
- Offline video playback (videos remain online-only)
- Custom branding per doctor or institution
- API for third-party integrations
- ZIP One-Click Update (not compatible with App Store/Play Store policies)
- Raw secret editing/viewing in mobile app
- Subscription management and recurring billing
- Advanced role customization beyond predefined roles
- Multi-factor authentication
- Single Sign-On (SSO) integration
- Advanced video analytics (watch time heatmaps, engagement metrics)
- Automated course recommendations
- Student-to-student messaging or collaboration tools
- Course marketplace or public course catalog
- Advanced search filters beyond specified criteria
- Custom report builder
- Data export to external systems
- Automated backup and restore functionality
- Advanced security features (intrusion detection, anomaly detection) beyond specified security hardening
- Custom notification templates
- Advanced impersonation features (impersonate multiple users simultaneously)
- Advanced storage management (automatic cleanup, archiving)
- Advanced system diagnostics (performance profiling, memory leak detection) beyond Health Check Dashboard
- Advanced revenue analytics (forecasting, trend analysis)
- Advanced CMS features (version control, content scheduling)
- Advanced branding features (custom themes, white-labeling per institution)
- Advanced feature flags (A/B testing, gradual rollout)
- Advanced audit log features (log retention policies, automated alerts) beyond specified audit logging
- Automatic device cleanup (removing inactive devices after X days)
- Device fingerprinting or advanced device identification beyond specified methods
- Geolocation-based device restrictions
- Device trust scoring beyond specified device risk score
- Automatic device blocking based on suspicious activity patterns beyond specified security policies
- Device usage analytics (session duration, feature usage per device)
- Device-specific permissions or feature access control
- Cross-device synchronization of user preferences or settings
- Device migration wizard for transferring data between devices
- Device health monitoring (battery, storage, network quality)
- Push notification targeting by device type or OS version
- Automatic course archiving based on inactivity or age
- Bulk archive/restore operations
- Archive scheduling (archive course on specific date)
- Archive notifications to enrolled students
- Archive reason templates or predefined categories
- Archive approval workflow (require admin approval before archiving)
- Soft delete with recovery period before permanent deletion
- Automatic cleanup of archived courses after retention period
- Archive analytics dashboard with trends and insights beyond specified analytics
- Archive export/import functionality
- Archive versioning or snapshots
- Partial course archiving (archive specific sections or lessons)
- Archive access control (restrict who can view archived courses) beyond specified rules
- Archive search within archived courses content
- Archive tagging or categorization system
- Advanced student creation features (custom fields, student groups)
- Automated student onboarding workflows
- Student import from external systems
- Student merge or duplicate detection beyond specified validation
- Advanced temporary password policies (expiration, complexity)
- Automated temporary password delivery (SMS, email)
- Student self-service password reset
- Advanced credit management (credit packages, credit expiration)
- Credit transfer between doctors (marked as future-ready)
- Credit refund or rollback beyond specified rules
- Credit usage forecasting
- Advanced activation code features (multi-use codes, code groups)
- Activation code analytics (redemption rates, usage patterns) beyond specified reports
- Behavioral biometrics for user authentication
- Advanced threat intelligence integration
- Real-time security alerts and notifications beyond specified logging
- Automated security incident response
- Security compliance reporting (GDPR, HIPAA, etc.)
- Advanced encryption beyond SSL pinning
- Hardware security module (HSM) integration
- Blockchain-based integrity verification
- AI-powered anomaly detection
- Advanced forensics and incident investigation tools beyond specified audit logs
- Watermark customization per user or institution
- Dynamic watermark position randomization algorithms beyond specified implementation
- Advanced content protection features (DRM, token-based access) beyond specified protection
- Automated violation appeals process
- Violation dispute resolution workflow
- Advanced strike system features (custom strike thresholds per user, role-based strike limits) beyond specified configuration
- Automated suspension expiration and account restoration (marked as future-ready)
- Violation analytics dashboard with trends and insights beyond specified analytics
- Violation export/import functionality beyond specified export
- Violation tagging or categorization system
- Advanced violation reporting (violation heatmaps, violation patterns) beyond specified reports
- Automated violation notifications to admins beyond specified logging
- Violation whitelist (users exempt from content protection policies)
- Advanced content protection policies (time-based restrictions, location-based restrictions) beyond specified policies
- Content protection policy versioning or rollback
- A/B testing for content protection policies
- Advanced screenshot detection (OCR, image recognition)
- Advanced screen recording detection (audio detection, video analysis)
- Content protection for PDF downloads
- Content protection for offline content
- Content protection for web version
- Advanced database optimization (query optimization, index tuning) beyond specified constraints and indexes
- Advanced transaction management (distributed transactions, saga pattern) beyond specified atomic transactions
- Advanced error handling (circuit breaker, retry with exponential backoff) beyond structured error responses
- Advanced monitoring (APM, distributed tracing) beyond Health Check Dashboard
- Advanced alerting (PagerDuty, Slack integration) beyond specified logging
- Advanced backup strategies (point-in-time recovery, incremental backups)
- Advanced disaster recovery (multi-region failover, automated recovery)
- Advanced load balancing (geo-routing, traffic shaping)
- Advanced caching strategies (Redis, CDN integration) beyond specified caching
- Advanced rate limiting (per-user, per-endpoint) beyond specified constraints
- Advanced API versioning (semantic versioning, deprecation policies)
- Advanced documentation (OpenAPI, Swagger) beyond specified PRD
- Automatic provider failover or load balancing between providers
- Provider-specific upload quotas or rate limits
- Provider usage analytics (uploads per provider, storage per provider)
- Provider cost tracking or billing integration
- Provider health monitoring or status checks
- Provider API key management or rotation
- Provider webhook integration for upload status updates
- Provider-specific video processing options (transcoding, quality settings)
- Provider-specific security settings (encryption, access control)
- Provider migration tools (move videos between providers)
- Bulk provider permission updates (enable/disable for multiple teachers at once)
- Provider permission templates or presets
- Provider permission inheritance (faculty-level, university-level)
- Provider permission scheduling (enable/disable at specific times)
- Provider permission audit reports beyond specified audit logging
- Provider permission notifications to teachers
- Provider permission request workflow (teachers request access, admin approves)
- Provider-specific upload UI customization
- Provider-specific player customization
- Provider-specific analytics integration