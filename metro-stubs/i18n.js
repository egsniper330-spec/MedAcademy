"use strict";
/**
 * Minimal i18n helper for metro-stubs web/ExpoGo fallbacks.
 * Provides t(key, params?) for all keys referenced across stubs.
 */

const strings = {
  // ── common ──────────────────────────────────────────────────────────────
  "common.dismiss": "Dismiss",
  "common.notFilled": "(not filled)",
  "common.notSet": "(not set)",
  "common.defaultMedium": "default (medium)",
  "common.defaultSuccess": "default (success)",

  // ── alert ────────────────────────────────────────────────────────────────
  "alert.issues": "Issues: {value}",

  // ── preview (Expo Go / scan preview) ────────────────────────────────────
  "preview.statusValid": "✅ Validation passed",
  "preview.statusInvalid": "❌ Validation failed",
  "preview.scanUnsupportedMediaLibrary":
    "expo-media-library is not available in Expo Go / web preview.",
  "preview.screenshotForAgent":
    "Screenshot this alert and share with your agent.",
  "preview.availableAfterPublish": "Will work after publishing to a real device.",

  // ── validation ───────────────────────────────────────────────────────────
  "validation.mustBeNonEmptyString": "{label} must be a non-empty string",
  "validation.uriMustBeNonEmptyString": "URI must be a non-empty string",
  "validation.uriMustStartWithHttp": "URI must start with http:// or https://",
  "validation.uriFormatInvalid":
    "URI format is invalid (expected file://, content://, or ph://)",

  // ── fileSystem (expo-file-system legacy) ─────────────────────────────────
  "fileSystem.download": "FileSystem.downloadAsync",
  "fileSystem.source": "source: {value}",
  "fileSystem.target": "target: {value}",
  "fileSystem.readFile": "FileSystem.readAsStringAsync",
  "fileSystem.writeFile": "FileSystem.writeAsStringAsync",
  "fileSystem.deleteFile": "FileSystem.deleteAsync",
  "fileSystem.getInfo": "FileSystem.getInfoAsync",
  "fileSystem.moveFile": "FileSystem.moveAsync",
  "fileSystem.copyFile": "FileSystem.copyAsync",
  "fileSystem.createDir": "FileSystem.makeDirectoryAsync",
  "fileSystem.readDir": "FileSystem.readDirectoryAsync",
  "fileSystem.upload": "FileSystem.uploadAsync",
  "fileSystem.uploadTask": "FileSystem.UploadTask",
  "fileSystem.downloadResumable": "FileSystem.DownloadResumable",
  "fileSystem.from": "from: {value}",
  "fileSystem.to": "to: {value}",

  // ── fileSystemNext (expo-file-system/next) ───────────────────────────────
  "fileSystemNext.createDir": "Directory.create",
  "fileSystemNext.deleteDir": "Directory.delete",
  "fileSystemNext.copyFile": "File.copy",
  "fileSystemNext.moveFile": "File.move",
  "fileSystemNext.deleteFile": "File.delete",
  "fileSystemNext.downloadFile": "File.downloadFileAsync",
  "fileSystemNext.pickFile": "File.pickFileAsync",
  "fileSystemNext.pickDir": "Directory.pickDirectoryAsync",

  // ── notifications ────────────────────────────────────────────────────────
  "notifications.validationPassed": "✅ Validation passed",
  "notifications.validationFailed": "❌ Validation failed",
  "notifications.fixAndRetry": "Fix the issues above and try again.",
  "notifications.configCorrect": "Configuration looks correct.",
  "notifications.requestPermission": "Notifications.requestPermissionsAsync",
  "notifications.scanPreviewDenied":
    "Permission will be denied in preview/web — not available.",
  "notifications.publishWillShowSystemPrompt":
    "On a real device the OS permission prompt will appear.",
  "notifications.scheduleNotification":
    "Notifications.scheduleNotificationAsync",
  "notifications.createChannel": "Notifications.setNotificationChannelAsync",
  "notifications.channelId": "channelId: {value}",
  "notifications.channelName": "name: {value}",
  "notifications.fullConfig": "config: {value}",
  "notifications.title": "title: {value}",
  "notifications.body": "body: {value}",
  "notifications.subtitle": "subtitle: {value}",
  "notifications.data": "data: {value}",
  "notifications.triggerImmediate": "trigger: immediate",
  "notifications.triggerDelay": "trigger: in {seconds}s",
  "notifications.triggerDate": "trigger: date {value}",
  "notifications.triggerOther": "trigger: {value}",
  "notifications.invalidRequest": "(invalid request object)",
  "notifications.requestCannotBeEmpty": "request cannot be empty",
  "notifications.contentCannotBeEmpty": "content cannot be empty",
  "notifications.titleAndBodyEmpty": "title and body are both empty",
  "notifications.triggerSecondsMustBePositive":
    "trigger.seconds must be a positive number",
  "notifications.channelIdMustBeNonEmpty": "channelId must be a non-empty string",
  "notifications.channelCannotBeEmpty": "channel object cannot be empty",
  "notifications.channelNameMustBeNonEmpty":
    "channel.name must be a non-empty string",
  "notifications.unknown": "unknown",

  // ── haptics ───────────────────────────────────────────────────────────────
  "haptics.impact": "Haptics.impactAsync",
  "haptics.notification": "Haptics.notificationAsync",
  "haptics.selection": "Haptics.selectionAsync",
  "haptics.webUnsupported": "Haptic feedback is not available on web.",
  "haptics.styleMustBeEnum":
    "style must be one of [{valid}], received {received}",
  "haptics.typeMustBeEnum":
    "type must be one of [{valid}], received {received}",

  // ── calendar ──────────────────────────────────────────────────────────────
  "calendar.requestPermission": "Calendar.requestPermissionsAsync",
  "calendar.getCalendars": "Calendar.getCalendarsAsync",
  "calendar.createCalendar": "Calendar.createCalendarAsync",
  "calendar.updateCalendar": "Calendar.updateCalendarAsync",
  "calendar.deleteCalendar": "Calendar.deleteCalendarAsync",
  "calendar.getEvents": "Calendar.getEventsAsync",
  "calendar.createEvent": "Calendar.createEventAsync",
  "calendar.updateEvent": "Calendar.updateEventAsync",
  "calendar.deleteEvent": "Calendar.deleteEventAsync",
  "calendar.getReminders": "Calendar.getRemindersAsync",
  "calendar.createReminder": "Calendar.createReminderAsync",
  "calendar.updateReminder": "Calendar.updateReminderAsync",
  "calendar.deleteReminder": "Calendar.deleteReminderAsync",

  // ── mediaLibrary ─────────────────────────────────────────────────────────
  "mediaLibrary.requestPermission": "MediaLibrary.requestPermissionsAsync",
  "mediaLibrary.getAssets": "MediaLibrary.getAssetsAsync",
  "mediaLibrary.createAsset": "MediaLibrary.createAssetAsync",
  "mediaLibrary.deleteAssets": "MediaLibrary.deleteAssetsAsync",
  "mediaLibrary.getAlbums": "MediaLibrary.getAlbumsAsync",
  "mediaLibrary.createAlbum": "MediaLibrary.createAlbumAsync",
  "mediaLibrary.deleteAlbums": "MediaLibrary.deleteAlbumsAsync",
  "mediaLibrary.addAssetsToAlbum": "MediaLibrary.addAssetsToAlbumAsync",
  "mediaLibrary.removeAssetsFromAlbum":
    "MediaLibrary.removeAssetsFromAlbumAsync",
  "mediaLibrary.getAssetInfo": "MediaLibrary.getAssetInfoAsync",

  // ── imagePicker ──────────────────────────────────────────────────────────
  "imagePicker.requestPermission":
    "ImagePicker.requestMediaLibraryPermissionsAsync",
  "imagePicker.requestCameraPermission":
    "ImagePicker.requestCameraPermissionsAsync",
  "imagePicker.launchImageLibrary": "ImagePicker.launchImageLibraryAsync",
  "imagePicker.launchCamera": "ImagePicker.launchCameraAsync",
  "imagePicker.mobilePassthrough":
    "[devkit] imagePicker: passing through on mobile browser",
  "imagePicker.webUnsupported":
    "Image picker is not fully supported on web.",
};

/**
 * Translate a key, interpolating {placeholder} values from params.
 * Falls back to the raw key if not found.
 *
 * @param {string} key
 * @param {Record<string, string>} [params]
 * @returns {string}
 */
function t(key, params) {
  let str = Object.prototype.hasOwnProperty.call(strings, key)
    ? strings[key]
    : key;
  if (params && typeof params === "object") {
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(new RegExp("\\{" + k + "\\}", "g"), String(v ?? ""));
    }
  }
  return str;
}

module.exports = { t, strings };
