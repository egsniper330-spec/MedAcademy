# Arabic translation — approved terminology

Purpose: keep the Arabic UI consistent and stop literal or wrong-context
translations from creeping back in. Each row records the English source term,
the approved Arabic, where it is used, and the reference that justifies it.

The rules behind the table:

- Translate by **function in this product**, not word-for-word. The same English
  word can need different Arabic in a different feature — in that case the keys
  are split (e.g. `lesson.materials` vs `course.lessons`).
- Prefer the term the user already meets in mainstream Arabic education
  products. Where the observed products differ, the deciding factor is whether
  their feature is the same thing.
- Do not translate product names, emails, URLs, IDs, API/enum values or
  user-authored content.

## Courses

| English | Arabic | Where | Reference / reasoning |
|---|---|---|---|
| My Courses | **دوراتي** | `nav.myCourses`, `tabs.myCourses`, `home.myCourses` | Arabic e-learning interfaces label the enrolled-course list «دوراتي» (observed on the [Arabic Tech App Store listing](https://apps.apple.com/us/app/arabic-tech/id6756884360?l=ar), where it is described as the navigation entry to a user's lessons with progress tracking). UNWTO Tourism Academy's [Arabic site](https://www.unwto-tourismacademy.ie.edu/ar) also uses «دوراتي» / «الدورات التدريبية» for online training courses. Same feature: a list of training courses tied to the account. |
| Courses | **الدورات** | `tabs.courses`, `home.exploreCourses`, `home.recentCourses`, `course.searchPlaceholder` | Coursera's [official Arabic store listing](https://apps.apple.com/sa/app/coursera-%D8%B7%D9%88-%D8%B1-%D8%AD%D9%8A%D8%A7%D8%AA%D9%83-%D8%A7%D9%84%D9%85%D9%87%D9%86%D9%8A%D8%A9/id736535961?l=ar) and Udemy's [Arabic Play listing](https://play.google.com/store/apps/details?id=com.udemy.android&hl=ar) both use «الدورات التدريبية»; MedAcademy uses the short form «الدورات» to fit navigation and chips. |
| ~~مساقات / مساقاتي~~ | **rejected** | — | «مساق» is the university *credit-subject* term. It does not describe MedAcademy's recorded, purchasable training courses, and it appeared nowhere in the inspected official Arabic interfaces. It also read as a different noun family to users, which is how the wrong "discussions/debates" style mistranslation arose. |
| Course (fallback title) | **دورة** | `course.titleFallback` | Singular of the approved plural; matches the product noun used across course screens. |
| Course Progress | **تقدّم الدورة** | `course.progress` | Microsoft Learn's Arabic profile/help uses «تتبع التقدم» / «التقدم المحرز» for learning progress ([Microsoft Learn FAQ](https://learn.microsoft.com/ar-sa/training/support/faq)). «تقدّم» is the noun used in Arabic UI progress labels. |
| Enroll (action) | **اشترك** | `course.enroll` | Google Classroom's Arabic help localises the join action as «الانضمام إلى صف» ([Classroom student help](https://support.google.com/edu/classroom/answer/9582544?hl=ar&co=GENIE.Platform%3DDesktop)); for a paid training course «اشترك» is the natural MSA action verb, and it matches «للمشتركين فقط» already used for subscriber-only materials. |
| Enrolled (state) | **مشترك** | `course.enrolled` | Same reasoning as above: state and action must share the root, otherwise the badge and the button disagree. |
| Teacher | **المحاضر** | `course.teacher` | The deliverable is recorded lectures (the app's own lesson screen says «محاضرة»), so the person is a lecturer. «المدرّس» is school-level in common Arabic usage. |

## Lessons

| English | Arabic | Where | Reference / reasoning |
|---|---|---|---|
| Mark as Complete | **تحديد كمكتمل** | `lesson.markComplete` | Natural MSA verb phrase; the previous «وضع علامة مكتمل» was a word-for-word rendering that is not idiomatic. |
| Lesson marked as complete | **تم تحديد الدرس كمكتمل** | `lesson.markedComplete` | Matches the action's wording so the confirmation echoes what the user tapped. |
| Lecture Materials / Lecture Notes | **مواد المحاضرة** / **ملاحظات المحاضرة** | `lesson.lectureMaterials`, `lesson.lectureNotes` | «محاضرة» is the standard term for a lecture; kept distinct from «المواد» (generic materials) and «الدرس» (lesson as a unit of a course). |
| files (count) | **ملف واحد / ملفان / {count} ملفات / {count} ملفًا** | `lesson.fileCount.*` | Arabic has six CLDR plural forms. The old «{count} ملفات» produced «2 ملفات», which is ungrammatical. The base key + `tCount()` now selects the correct form. |

## Navigation and administration

| English | Arabic | Where | Reference / reasoning |
|---|---|---|---|
| Students | **الطلاب** | `nav.students`, `tabs.students`, `role.student` badge | Observed in Google Classroom's Arabic help and its [Arabic Play listing](https://play.google.com/store/apps/details?id=com.google.android.apps.classroom&hl=ar). |
| Notifications | **الإشعارات** | `nav.notifications`, `common.notifications` | Same sources as above; also «إشعارات من Microsoft Learn» ([Microsoft Learn profile settings](https://learn.microsoft.com/ar-sa/training/support/learn-profile-manage)). |
| Enrollment Manager | **إدارة التسجيل** | `nav.enrollmentManager` | The screen manages enrollments; «مدير التسجيل» means the *registrar* (a person), which is wrong for a tool. Matches the sibling `nav.deviceManagement` = «إدارة الأجهزة». |
| Ledger | **دفتر الأستاذ** | `nav.ledgerDashboard`, `nav.ledgerHistory` | Standard accounting Arabic for "ledger"; «الدفتر» alone means any notebook. |
| Bulk Credits | **منح رصيد جماعي** | `nav.bulkCredits` | The feature grants credits to many accounts at once; «رصيد جماعي» alone reads as "a shared balance". |

## Earnings, revenue and credits

Used by the doctor earnings dashboard (`(doctor)/dr-earnings.tsx`), the embedded
earnings tab in `dr-profile.tsx`, and the Super Admin read-only view
`(hubs)/sa-doctor-earnings.tsx`. All three share the same keys, so the same
English word cannot acquire two different Arabic words across the surfaces.

| English | Arabic | Where | Reference / reasoning |
|---|---|---|---|
| Earnings (the section) | **الأرباح** | `nav.earnings`, `tabs.earnings`, `drProfile.section.earnings` | Google AdSense's official Arabic home-page help labels the earnings card «الأرباح المقدّرة» ([AdSense home-page reports](https://support.google.com/adsense/answer/32852?hl=ar)). «أرباح» is the product's *earnings* word, kept separate from the money itself. |
| Revenue | **الإيرادات** / **الإيراد** | `drProfile.earnings.totalRevenue`, `colRevenue`, `income` | Same AdSense page pairs the earnings card with «الرصيد»/«الإيرادات», and its metric page says «إيرادات الإعلان» ([AdSense metrics](https://support.google.com/adsense/answer/112032?hl=ar)). Plural «الإيرادات» for the aggregate, singular «الإيراد» for a column/row value. |
| Transactions | **المعاملات** | `drProfile.earnings.transactions`, `recent` | Google Ads' Arabic help names its billing page «المعاملات» and instructs «انقر على المعاملات» ([Google Ads transactions](https://support.google.com/google-ads/answer/1704427?hl=ar)); Google Pay Arabic uses «المعاملات المعلّقة». |
| Credits / balance | **الرصيد** | `drProfile.stats.credits`, `saEarnings.kpi.*Credits`, `creditActivity` | Microsoft's Arabic Azure credits page uses «الرصيد المتاح» and «رصيد ائتمان Azure» ([Azure credits balance](https://learn.microsoft.com/ar-sa/azure/cost-management-billing/benefits/credits/mca-check-azure-credits-balance)). MedAcademy sells a prepaid top-up, so the short product word «الرصيد» is used rather than the bank-style «ائتمان». |
| Read Only | **عرض فقط** | `saEarnings.readOnly` | Google Drive's Arabic help describes view access as «عرضه فقط» / «إمكانية العرض» ([Drive sharing](https://support.google.com/drive/answer/2494822?hl=ar)); OneDrive Arabic says «للقراءة فقط» ([OneDrive sharing](https://support.microsoft.com/ar-sa/onedrive/share-files-in-onedrive-for-android)). «عرض فقط» is the compact form that fits the badge and matches both. |
| Deduct / Deduction | **خصم** | `drProfile.earnings.deduct` (embedded tab legend), `drProfile.earnings.deduction` (standalone screens legend) | «خصم» is the standard Arabic accounting word for a deduction. English keeps two labels because the two screens phrase the legend differently; Arabic uses one word for both, because both describe the same money movement. |
| Refund | **استرداد** | `drProfile.tx.suspension_refund` | Standard Arabic financial term for money returned to the payer; kept distinct from «شراء» (purchase) so the ledger reads correctly after a suspension. |
| EGP (currency) | **EGP** (kept LTR) | every money formatter | The ISO code is an identifier, not UI copy: it stays LTR inside Arabic strings and the numeric value is never re-formatted, so a figure cannot change meaning when the language changes. |

## Administration and moderation

| English | Arabic | Where | Reference / reasoning |
|---|---|---|---|
| Block / Blocked | **حظر / محظور** | `adminDevices.block*`, `bulk.block`, `status.blocked` | «حظر» is the ordinary Arabic UI verb for denying access to an account or device. It is deliberately kept separate from «إيقاف» (suspend) so a moderation action never reads as the other one. |
| Suspend / Suspended | **إيقاف / موقوف** | `adminUsers.suspended`, `drProfile.status.suspended` | The state word «موقوف» and the action «إيقاف» share a root, so the toast echoes the badge the admin just changed. The same pairing is already used by the account-suspended screen. |
| Reset (devices / password) | **إعادة تعيين** | `bulk.resetDevices`, `bulk.resetPassword`, `adminDevices.resetTitle` | The established Arabic UI phrase for restoring something to its initial state (Microsoft/Google Arabic account screens use «إعادة تعيين كلمة المرور»). |
| Remove Credits | **خصم أرصدة** | `bulk.removeCredits` | The English label was the abbreviation «Rm Credits»; it is now spelled out and translated with the approved deduction word «خصم» rather than a literal «إزالة». |
| Delete Permanently | **حذف نهائي** | `deleteAccount.deletePermanently` | «حذف» plus «نهائي» states irreversibility without inventing a new verb, and matches the warning sentence around it. |
| Credits Remaining | **الأرصدة المتبقية** | `deleteAccount.creditsRemaining` | Plural of the approved «الرصيد» because the row summarises several credit movements before deletion. |
| Weak / Fair / Good / Strong (password) | **ضعيفة / مقبولة / جيدة / قوية** | `password.strength.*` | Strength adjectives agree with the feminine noun «كلمة المرور»; «مقبولة» avoids the literal «عادلة», which reads as *fair-minded*. |
| Optional | **اختياري** | `createUser.optional`, `editUser.newPasswordOptional` | Standard Arabic form label; used instead of «(إن أردت)» so the field header stays compact. |

## Course builder (create / edit)

Used by `src/app/(app)/course-builder/[id].tsx` (the `cb.*` namespace). These
were chosen for internal consistency with the terminology already approved
above, not from a new external source.

| English | Arabic | Where | Reasoning |
|---|---|---|---|
| Course Status | **حالة الدورة** | `cb.field.courseStatus` | Same «الدورة» noun as the rest of the course namespace. |
| Draft | **مسودة** | `courseStatus.draft`, `cb.statusHelp` | The state of unpublished authored content; standard Arabic UI term. |
| Published | **منشور** | `courseStatus.published` | Agrees with the existing `courseStatus.published` key already used by the course list. |
| Scheduled | **مجدول** | `courseStatus.scheduled` | Added because the lesson editor can schedule lessons; previously the raw enum value leaked. |
| Structure | **الهيكل** | `cb.tab.structure` | The tab edits sections/lessons (the course's internal structure), not a “programme”. |
| Section | **قسم** | `cb.section`, `drCourses.sectionCount` | Matches «أقسام» already used in the doctor course list. |
| Learning & Access | **التعلّم والوصول** | `cb.learningAccess` | Two nouns, both standard; kept distinct from «الاشتراك» (subscription). |
| Subscription Required | **الاشتراك مطلوب** | `cb.subscriptionRequired` | Reuses the approved «اشترك/مشترك» root so the setting and the student-facing gate agree. |
| Enrollment Cost: 1 Credit | **تكلفة التسجيل: رصيد واحد** | `cb.enrollmentCost` | «التسجيل» is the enrollment *record*; the credit noun follows the earnings/credits section. |
| Bulk Import | **استيراد جماعي** | `cb.bulkImport`, `nav.bulkImport` | Same pattern as the approved «منح رصيد جماعي» (batch action + «جماعي»). |

## Verification

`tests/i18nTerminology.test.cjs` pins these decisions (including
`My Courses → دوراتي`, the absence of the rejected «مساق» family in the course
namespace, plural correctness and key parity). Changing a pinned term requires
changing the test and recording the new reference here.
