"use strict";
var import_react_native = require("react-native");
var import_web_stub_dialog = require("./web-stub-dialog");
var import_i18n = require("./i18n");
if (import_react_native.Platform.OS !== "web") {
  module.exports = require("expo-calendar");
} else {
  let createStubCalendar = function() {
    return {
      id: "stub-calendar",
      title: (0, import_i18n.t)("calendar.previewCalendarTitle"),
      color: "#1677FF",
      entityType: "event",
      source: { id: "stub", type: "local", name: (0, import_i18n.t)("calendar.sourceNameLocal") },
      type: "local",
      allowsModifications: true,
      allowedAvailabilities: [],
      allowedReminders: [],
      allowedAttendeeTypes: [],
      accessLevel: "owner"
    };
  }, showCalendarAlert = function(title, lines, isValid, errors) {
    (0, import_web_stub_dialog.showWebStubDialog)({
      title,
      details: lines,
      errors: !isValid && errors && errors.length > 0 ? errors : void 0
    });
  }, validateId = function(id, label = "id") {
    const errors = [];
    if (typeof id !== "string" || id.trim().length === 0) {
      errors.push((0, import_i18n.t)("validation.mustBeNonEmptyString", { label }));
    }
    return { ok: errors.length === 0, errors };
  }, validateDate = function(value, label) {
    const errors = [];
    if (value == null) {
      errors.push((0, import_i18n.t)("validation.cannotBeEmpty", { label }));
    } else if (!(value instanceof Date) && typeof value !== "string") {
      errors.push((0, import_i18n.t)("validation.mustBeDateOrString", { label }));
    } else if (value instanceof Date && isNaN(value.getTime())) {
      errors.push((0, import_i18n.t)("validation.invalidDateObject", { label }));
    }
    return errors;
  }, formatDateArg = function(value) {
    if (value instanceof Date) return value.toLocaleString();
    if (typeof value === "string") return value;
    return String(value);
  }, useCalendarPermissions = function() {
    const [permission] = useState(GRANTED_PERMISSION);
    const requestPermission = useCallback(async () => GRANTED_PERMISSION, []);
    const getPermission = useCallback(async () => GRANTED_PERMISSION, []);
    return [permission, requestPermission, getPermission];
  }, useRemindersPermissions = function() {
    const [permission] = useState(GRANTED_PERMISSION);
    const requestPermission = useCallback(async () => GRANTED_PERMISSION, []);
    const getPermission = useCallback(async () => GRANTED_PERMISSION, []);
    return [permission, requestPermission, getPermission];
  };
  var createStubCalendar2 = createStubCalendar, showCalendarAlert2 = showCalendarAlert, validateId2 = validateId, validateDate2 = validateDate, formatDateArg2 = formatDateArg, useCalendarPermissions2 = useCalendarPermissions, useRemindersPermissions2 = useRemindersPermissions;
  const GRANTED_PERMISSION = {
    status: "granted",
    granted: true,
    canAskAgain: true,
    expires: "never"
  };
  const { useState, useCallback } = require("react");
  const requestCalendarPermissionsAsync = async () => GRANTED_PERMISSION;
  const getCalendarPermissionsAsync = async () => GRANTED_PERMISSION;
  const requestRemindersPermissionsAsync = async () => GRANTED_PERMISSION;
  const getRemindersPermissionsAsync = async () => GRANTED_PERMISSION;
  const requestPermissionsAsync = requestCalendarPermissionsAsync;
  const getPermissionsAsync = getCalendarPermissionsAsync;
  const isAvailableAsync = async () => true;
  const getCalendarsAsync = async (entityType) => {
    void entityType;
    return [createStubCalendar()];
  };
  const getDefaultCalendarAsync = async () => {
    showCalendarAlert((0, import_i18n.t)("calendar.getDefaultCalendar"), [(0, import_i18n.t)("calendar.getDefaultCalendarDetail"), (0, import_i18n.t)("preview.unsupported")], false, [(0, import_i18n.t)("preview.cannotAccessCalendar")]);
    return void 0;
  };
  const createCalendarAsync = async (details) => {
    const errors = [];
    const d = details && typeof details === "object" ? details : {};
    const titleVal = d["title"];
    if (typeof titleVal !== "string" || titleVal.trim().length === 0) {
      errors.push((0, import_i18n.t)("validation.mustBeNonEmptyString", { label: "details.title" }));
    }
    const isValid = errors.length === 0;
    const titleDisplay = typeof titleVal === "string" ? titleVal : (0, import_i18n.t)("common.notFilled");
    showCalendarAlert(
      (0, import_i18n.t)("calendar.createCalendar"),
      [(0, import_i18n.t)("calendar.calendarName", { value: titleDisplay }), (0, import_i18n.t)("calendar.calendarColor", { value: String(d["color"] ?? (0, import_i18n.t)("common.notSet")) })],
      isValid,
      isValid ? void 0 : errors
    );
    return "stub";
  };
  const updateCalendarAsync = async (id, details) => {
    const { ok: idOk, errors: idErrors } = validateId(id, "calendarId");
    const d = details && typeof details === "object" ? details : {};
    showCalendarAlert(
      (0, import_i18n.t)("calendar.updateCalendar"),
      [
        (0, import_i18n.t)("calendar.calendarId", { value: typeof id === "string" ? id : String(id) }),
        (0, import_i18n.t)("calendar.updateFields", { value: Object.keys(d).join(", ") || (0, import_i18n.t)("common.none") })
      ],
      idOk,
      idOk ? void 0 : idErrors
    );
    return typeof id === "string" ? id : "stub";
  };
  const deleteCalendarAsync = async (id) => {
    const { ok, errors } = validateId(id, "calendarId");
    showCalendarAlert(
      (0, import_i18n.t)("calendar.deleteCalendar"),
      [(0, import_i18n.t)("calendar.calendarId", { value: typeof id === "string" ? id : String(id) })],
      ok,
      ok ? void 0 : errors
    );
  };
  const getEventsAsync = async (calendarIds, startDate, endDate) => {
    const errors = [];
    if (!Array.isArray(calendarIds) || calendarIds.length === 0) {
      errors.push((0, import_i18n.t)("validation.calendarIdsMustBeNonEmptyArray"));
    }
    errors.push(...validateDate(startDate, "startDate"));
    errors.push(...validateDate(endDate, "endDate"));
    const isValid = errors.length === 0;
    const idsStr = Array.isArray(calendarIds) ? `[${calendarIds.slice(0, 3).join(", ")}${calendarIds.length > 3 ? "\u2026" : ""}]` : String(calendarIds);
    showCalendarAlert(
      (0, import_i18n.t)("calendar.queryEvents"),
      [
        (0, import_i18n.t)("calendar.calendarIds", { value: idsStr }),
        (0, import_i18n.t)("calendar.startTime", { value: formatDateArg(startDate) }),
        (0, import_i18n.t)("calendar.endTime", { value: formatDateArg(endDate) }),
        (0, import_i18n.t)("preview.returnsEmptyList")
      ],
      isValid,
      isValid ? void 0 : errors
    );
    return [];
  };
  const getEventAsync = async (id) => {
    const { ok, errors } = validateId(id, "eventId");
    showCalendarAlert(
      (0, import_i18n.t)("calendar.getEvent"),
      [(0, import_i18n.t)("calendar.eventId", { value: typeof id === "string" ? id : String(id) })],
      ok,
      ok ? void 0 : errors
    );
    return void 0;
  };
  const createEventAsync = async (calendarId, eventData) => {
    const errors = [];
    const { errors: idErrors } = validateId(calendarId, "calendarId");
    errors.push(...idErrors);
    const data = eventData && typeof eventData === "object" ? eventData : {};
    if (import_react_native.Platform.OS === "android") {
      errors.push(...validateDate(data["startDate"], "eventData.startDate"));
      errors.push(...validateDate(data["endDate"], "eventData.endDate"));
    }
    const titleVal = data["title"];
    const titleDisplay = typeof titleVal === "string" ? titleVal : (0, import_i18n.t)("common.notFilled");
    const startDisplay = data["startDate"] != null ? formatDateArg(data["startDate"]) : (0, import_i18n.t)("common.notSet");
    const endDisplay = data["endDate"] != null ? formatDateArg(data["endDate"]) : (0, import_i18n.t)("common.notSet");
    const isValid = errors.length === 0;
    showCalendarAlert(
      (0, import_i18n.t)("calendar.createEvent"),
      [
        (0, import_i18n.t)("calendar.calendarId", { value: typeof calendarId === "string" ? calendarId : String(calendarId) }),
        (0, import_i18n.t)("calendar.eventTitle", { value: titleDisplay }),
        (0, import_i18n.t)("calendar.eventStart", { value: startDisplay }),
        (0, import_i18n.t)("calendar.eventEnd", { value: endDisplay })
      ],
      isValid,
      isValid ? void 0 : errors
    );
    return "stub";
  };
  const updateEventAsync = async (id, details) => {
    const { ok, errors } = validateId(id, "eventId");
    const d = details && typeof details === "object" ? details : {};
    showCalendarAlert(
      (0, import_i18n.t)("calendar.updateEvent"),
      [
        (0, import_i18n.t)("calendar.eventId", { value: typeof id === "string" ? id : String(id) }),
        (0, import_i18n.t)("calendar.updateFields", { value: Object.keys(d).join(", ") || (0, import_i18n.t)("common.none") })
      ],
      ok,
      ok ? void 0 : errors
    );
    return typeof id === "string" ? id : "stub";
  };
  const deleteEventAsync = async (id) => {
    const { ok, errors } = validateId(id, "eventId");
    showCalendarAlert(
      (0, import_i18n.t)("calendar.deleteEvent"),
      [(0, import_i18n.t)("calendar.eventId", { value: typeof id === "string" ? id : String(id) })],
      ok,
      ok ? void 0 : errors
    );
  };
  const enums = {
    EntityTypes: { EVENT: "event", REMINDER: "reminder" },
    Frequency: { DAILY: "daily", WEEKLY: "weekly", MONTHLY: "monthly", YEARLY: "yearly" },
    Availability: {
      NOT_SUPPORTED: "notSupported",
      BUSY: "busy",
      FREE: "free",
      TENTATIVE: "tentative",
      UNAVAILABLE: "unavailable"
    },
    CalendarType: {
      LOCAL: "local",
      CALDAV: "caldav",
      EXCHANGE: "exchange",
      SUBSCRIBED: "subscribed",
      BIRTHDAYS: "birthdays",
      UNKNOWN: "unknown"
    },
    EventStatus: { NONE: "none", CONFIRMED: "confirmed", TENTATIVE: "tentative", CANCELED: "canceled" },
    SourceType: {
      LOCAL: "local",
      EXCHANGE: "exchange",
      CALDAV: "caldav",
      MOBILEME: "mobileme",
      SUBSCRIBED: "subscribed",
      BIRTHDAYS: "birthdays"
    },
    AttendeeRole: {
      UNKNOWN: "unknown",
      REQUIRED: "required",
      OPTIONAL: "optional",
      CHAIR: "chair",
      NON_PARTICIPANT: "nonParticipant",
      ATTENDEE: "attendee",
      ORGANIZER: "organizer",
      PERFORMER: "performer",
      SPEAKER: "speaker",
      NONE: "none"
    },
    AttendeeStatus: {
      UNKNOWN: "unknown",
      PENDING: "pending",
      ACCEPTED: "accepted",
      DECLINED: "declined",
      TENTATIVE: "tentative",
      DELEGATED: "delegated",
      COMPLETED: "completed",
      IN_PROCESS: "inProcess",
      INVITED: "invited",
      NONE: "none"
    },
    AttendeeType: {
      UNKNOWN: "unknown",
      PERSON: "person",
      ROOM: "room",
      GROUP: "group",
      RESOURCE: "resource",
      OPTIONAL: "optional",
      REQUIRED: "required",
      NONE: "none"
    },
    AlarmMethod: { ALARM: "alarm", ALERT: "alert", EMAIL: "email", SMS: "sms", DEFAULT: "default" },
    EventAccessLevel: { CONFIDENTIAL: "confidential", PRIVATE: "private", PUBLIC: "public", DEFAULT: "default" },
    CalendarAccessLevel: {
      CONTRIBUTOR: "contributor",
      EDITOR: "editor",
      FREEBUSY: "freebusy",
      OVERRIDE: "override",
      OWNER: "owner",
      READ: "read",
      RESPOND: "respond",
      ROOT: "root",
      NONE: "none"
    },
    ReminderStatus: { COMPLETED: "completed", INCOMPLETE: "incomplete" },
    PermissionStatus: { GRANTED: "granted", DENIED: "denied", UNDETERMINED: "undetermined" },
    DayOfTheWeek: { SU: 1, MO: 2, TU: 3, WE: 4, TH: 5, FR: 6, SA: 7 },
    MonthOfTheYear: { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 },
    CalendarDialogResultActions: { SAVED: "saved", CANCELED: "canceled", DELETED: "deleted" }
  };
  const coreHandlers = {
    isAvailableAsync,
    useCalendarPermissions,
    useRemindersPermissions,
    requestCalendarPermissionsAsync,
    getCalendarPermissionsAsync,
    requestRemindersPermissionsAsync,
    getRemindersPermissionsAsync,
    requestPermissionsAsync,
    getPermissionsAsync,
    getCalendarsAsync,
    getDefaultCalendarAsync,
    createCalendarAsync,
    updateCalendarAsync,
    deleteCalendarAsync,
    getEventsAsync,
    getEventAsync,
    createEventAsync,
    updateEventAsync,
    deleteEventAsync
  };
  const noopPermission = async () => GRANTED_PERMISSION;
  const noop = async () => void 0;
  module.exports = new Proxy(enums, {
    get(target, key) {
      if (key in target) return target[key];
      if (key in coreHandlers) return coreHandlers[key];
      if (key.endsWith("PermissionsAsync")) return noopPermission;
      return noop;
    }
  });
}
//# sourceMappingURL=expo-calendar-stub.js.map