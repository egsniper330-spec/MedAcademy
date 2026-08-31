/**
 * BackgroundUploadHandler.swift
 *
 * Core iOS background upload handler using URLSession background sessions.
 *
 * Architecture:
 *   JS (useVideoUploader) → NativeUploadBridge.startUpload() → this handler
 *   this handler → native URLSession background upload tasks → PHP backend
 *   this handler → URLSession delegate callbacks → NativeUploadBridge → JS
 *
 * When iOS suspends the app:
 *   - The background URLSession continues uploading
 *   - iOS wakes the app briefly to deliver delegate callbacks
 *   - On final callback, the handler triggers assembly + finalization
 *
 * The JS layer still handles:
 *   - URI stabilisation (copying content:// to file://)
 *   - Upload Queue UI state
 *   - VdoCipher status polling (if JS is available)
 *   - video_assets creation (if JS is available)
 *
 * This handler handles:
 *   - Background URLSession lifecycle
 *   - Native HTTP chunk uploads (survive JS suspension)
 *   - Progress reporting back to JS via DeviceEventEmitter
 *   - Auto-triggering assembly after all chunks uploaded
 *   - Session reconnection when iOS relaunches the app
 */

import Foundation
import UIKit
import UserNotifications
import React

// MARK: - Singleton

@objc(BackgroundUploadHandler)
class BackgroundUploadHandler: NSObject {

  static let shared = BackgroundUploadHandler()

  /// Stable background session identifier — iOS uses this to reconnect after app termination.
  static let sessionIdentifier = "com.medacademy.video-upload"

  /// The background URLSession (created lazily on first use).
  private var backgroundSession: URLSession?

  /// Completion handler held between handleEventsForBackgroundURLSession and
  /// URLSessionDidFinishEventsForBackgroundURLSession.
  private var backgroundSessionCompletionHandler: (() -> Void)?

  /// Active upload states keyed by URLSessionTask taskIdentifier.
  /// Maps taskIdentifier → (uploadId, chunkIndex, totalChunks)
  private var taskMap: [Int: UploadTaskInfo] = [:]

  /// Upload states keyed by uploadId — persists across session reconnection.
  /// Written to UserDefaults so the handler survives app termination.
  private var uploadStates: [String: UploadState] = [:]

  /// React event emitter reference — set from NativeUploadBridge
  weak var eventEmitter: RCTEventEmitter?

  // MARK: - Types

  struct UploadTaskInfo {
    let uploadId: String
    let chunkIndex: Int
    let totalChunks: Int
    let fileName: String
    let mimeType: String
    let fileSize: Int64
  }

  struct UploadState: Codable {
    let uploadId: String
    let fileUri: String
    let fileName: String
    let mimeType: String
    let fileSize: Int64
    let chunkSize: Int
    let totalChunks: Int
    let startChunk: Int
    let apiUrl: String
    var authToken: String
    var refreshToken: String
    let lessonId: String?
    let courseId: String?
    let doctorId: String?
    var completedChunks: Set<Int>
    var assemblyTriggered: Bool
    var providerVideoId: String?
    var failedChunks: Set<Int>
    var startedAt: TimeInterval

    enum CodingKeys: String, CodingKey {
      case uploadId, fileUri, fileName, mimeType, fileSize, chunkSize
      case totalChunks, startChunk, apiUrl, authToken, lessonId, courseId
      case doctorId, completedChunks, assemblyTriggered, providerVideoId
      case failedChunks, startedAt
    }
  }

  // MARK: - Initialization

  private override init() {
    super.init()
    loadStates()

    // Register for notifications when background transfers complete
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(appDidBecomeActive),
      name: UIApplication.didBecomeActiveNotification,
      object: nil
    )
  }

  @objc private func appDidBecomeActive() {
    // Emit current upload states to JS when app returns to foreground
    for (uploadId, state) in uploadStates {
      emitProgressEvent(uploadId: uploadId, state: state)
    }
  }

  // MARK: - Session Management

  func getBackgroundSession() -> URLSession {
    if let session = backgroundSession {
      return session
    }

    let config = URLSessionConfiguration.background(withIdentifier: Self.sessionIdentifier)
    config.isDiscretionary = false // Upload immediately, don't let OS defer
    config.sessionSendsLaunchEvents = true
    config.timeoutIntervalForRequest = 300 // 5 minutes per chunk
    config.timeoutIntervalForResource = 3600 // 1 hour total

    let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    backgroundSession = session
    return session
  }

  /// Called by AppDelegate when iOS wakes the app for background URL session events.
  func handleEventsForBackgroundURLSession(
    identifier: String,
    completionHandler: @escaping () -> Void
  ) {
    guard identifier == Self.sessionIdentifier else {
      completionHandler()
      return
    }
    backgroundSessionCompletionHandler = completionHandler

    // Reconnect to the background session
    _ = getBackgroundSession()
  }

  // MARK: - Upload Control

  func startUpload(config: [String: Any]) {
    guard let uploadId = config["uploadId"] as? String,
          let fileUri = config["fileUri"] as? String,
          let apiUrl = config["apiUrl"] as? String,
          let authToken = config["authToken"] as? String else {
      return
    }

    let refreshToken = (config["refreshToken"] as? String) ?? ""
    let fileName = (config["fileName"] as? String) ?? "video.mp4"
    let mimeType = (config["mimeType"] as? String) ?? "video/mp4"
    let fileSize = (config["fileSize"] as? Double).map(Int64.init) ?? 0
    let chunkSize = (config["chunkSize"] as? Int) ?? (8 * 1024 * 1024)
    let totalChunks = (config["totalChunks"] as? Int) ?? 1
    let startChunk = (config["startChunk"] as? Int) ?? 0
    let lessonId = config["lessonId"] as? String
    let courseId = config["courseId"] as? String
    let doctorId = config["doctorId"] as? String

    // Initialize token state for refresh
    currentAccessToken = authToken
    currentRefreshToken = refreshToken
    currentApiUrl = apiUrl

    // Check for existing state (resume scenario)
    var state: UploadState
    if let existing = uploadStates[uploadId] {
      state = existing
      // Don't overwrite if we already have more completed chunks
      if startChunk > state.startChunk {
        state = UploadState(
          uploadId: uploadId, fileUri: fileUri, fileName: fileName,
          mimeType: mimeType, fileSize: fileSize, chunkSize: chunkSize,
          totalChunks: totalChunks, startChunk: startChunk, apiUrl: apiUrl,
          authToken: authToken, refreshToken: refreshToken,
          lessonId: lessonId, courseId: courseId,
          doctorId: doctorId, completedChunks: state.completedChunks,
          assemblyTriggered: state.assemblyTriggered,
          providerVideoId: state.providerVideoId,
          failedChunks: [], startedAt: state.startedAt
        )
      }
    } else {
      state = UploadState(
        uploadId: uploadId, fileUri: fileUri, fileName: fileName,
        mimeType: mimeType, fileSize: fileSize, chunkSize: chunkSize,
        totalChunks: totalChunks, startChunk: startChunk, apiUrl: apiUrl,
        authToken: authToken, refreshToken: refreshToken,
        lessonId: lessonId, courseId: courseId,
        doctorId: doctorId, completedChunks: [],
        assemblyTriggered: false, providerVideoId: nil,
        failedChunks: [], startedAt: Date().timeIntervalSince1970
      )
    }

    uploadStates[uploadId] = state
    saveStates()

    // Start upload tasks for incomplete chunks
    let session = getBackgroundSession()
    for chunkIndex in startChunk..<totalChunks {
      if state.completedChunks.contains(chunkIndex) { continue }

      guard let chunkData = readChunkData(
        fileUri: fileUri, chunkIndex: chunkIndex, chunkSize: chunkSize, fileSize: fileSize
      ) else {
        emitErrorEvent(uploadId: uploadId, message: "Failed to read chunk \(chunkIndex)")
        return
      }

      // Ensure token is fresh before creating the upload task
      let freshToken = ensureFreshToken()

      let task = createUploadTask(
        session: session, uploadId: uploadId, chunkIndex: chunkIndex,
        totalChunks: totalChunks, chunkData: chunkData,
        fileName: fileName, mimeType: mimeType, apiUrl: apiUrl,
        authToken: freshToken
      )

      taskMap[task.taskIdentifier] = UploadTaskInfo(
        uploadId: uploadId, chunkIndex: chunkIndex, totalChunks: totalChunks,
        fileName: fileName, mimeType: mimeType, fileSize: fileSize
      )

      task.resume()
    }

    emitProgressEvent(uploadId: uploadId, state: state)
  }

  func cancelUpload(uploadId: String) {
    // Cancel all URLSession tasks for this uploadId
    let session = getBackgroundSession()
    session.getTasksWithCompletionHandler { tasks in
      for task in tasks.uploads {
        if let info = self.taskMap[task.taskIdentifier], info.uploadId == uploadId {
          task.cancel()
        }
      }

      // Remove state
      self.uploadStates.removeValue(forKey: uploadId)
      self.saveStates()

      self.emitCancelEvent(uploadId: uploadId)
    }
  }

  // MARK: - Token Refresh (native, no JS dependency)

  /// Refresh threshold: refresh when <= 120 seconds remain.
  private let refreshThresholdSeconds: TimeInterval = 120

  /// Lock to prevent concurrent refresh requests (refresh-token rotation makes
  /// concurrent refreshes dangerous — only one can succeed).
  private let refreshLock = NSLock()

  /  // Current access token — updated after each refresh.
  private var currentAccessToken: String = ""
  /// Current refresh token — updated after each refresh (rotation).
  private var currentRefreshToken: String = ""
  /// Current API base URL.
  private var currentApiUrl: String = ""

  /**
   * Decode the JWT `exp` claim without external libraries.
   * JWT format: header.payload.signature
   * Returns the expiration timestamp (Unix seconds), or nil if decoding fails.
   */
  private func decodeJwtExp(_ token: String) -> TimeInterval? {
    let parts = token.split(separator: ".")
    guard parts.count == 3 else { return nil }
    guard let data = Data(base64Encoded: String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + String(repeating: "=", count: (3 - String(parts[1]).count % 3) % 3)) else { return nil }
    guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    return json["exp"] as? TimeInterval
  }

  /**
   * Check if the current access token needs refreshing.
   */
  private func tokenNeedsRefresh() -> Bool {
    guard !currentAccessToken.isEmpty else { return true }
    guard let exp = decodeJwtExp(currentAccessToken) else { return true }
    let remaining = exp - Date().timeIntervalSince1970
    return remaining <= refreshThresholdSeconds
  }

  /**
   * Refresh the access token using the refresh token.
   * Uses NSLock to prevent concurrent refresh requests.
   * Returns true on success.
   */
  private func refreshAuthTokenSync() -> Bool {
    refreshLock.lock()
    defer { refreshLock.unlock() }

    // Double-check after acquiring lock
    guard tokenNeedsRefresh() else {
      NSLog("[BGUpload] Token already refreshed by another path")
      return true
    }

    guard !currentRefreshToken.isEmpty else {
      NSLog("[BGUpload] No refresh token available")
      return false
    }

    NSLog("[BGUpload] Refreshing auth token…")

    // Synchronous refresh using URLSession.shared (not background session)
    let semaphore = DispatchSemaphore(value: 0)
    var refreshSuccess = false

    let url = URL(string: "\(currentApiUrl)/auth/refresh")!
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    let body = ["refresh_token": currentRefreshToken]
    request.httpBody = try? JSONSerialization.data(withJSONObject: body)

    let task = URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
      defer { semaphore.signal() }
      guard let self = self else { return }

      guard let httpResponse = response as? HTTPURLResponse,
            (200...299).contains(httpResponse.statusCode),
            let data = data,
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let session = json["session"] as? [String: Any],
            let newAccess = session["access_token"] as? String,
            let newRefresh = session["refresh_token"] as? String else {
        NSLog("[BGUpload] Token refresh failed")
        return
      }

      self.currentAccessToken = newAccess
      self.currentRefreshToken = newRefresh

      // Persist the new tokens to the upload state for survival across app restarts
      if let uploadId = self.uploadStates.first?.key,
         var state = self.uploadStates[uploadId] {
        state.authToken = newAccess
        state.refreshToken = newRefresh
        self.uploadStates[uploadId] = state
        self.saveStates()
      }

      refreshSuccess = true
      NSLog("[BGUpload] Token refresh succeeded")
    }
    task.resume()

    // Wait up to 15 seconds for refresh
    _ = semaphore.wait(timeout: .now() + 15)
    return refreshSuccess
  }

  /**
   * Ensure the access token is fresh. Proactively refreshes if close to expiry.
   * Returns the current valid access token.
   */
  private func ensureFreshToken() -> String {
    if tokenNeedsRefresh() {
      let refreshed = refreshAuthTokenSync()
      if !refreshed {
        NSLog("[BGUpload] Token refresh failed — will use existing token")
      }
    }
    return currentAccessToken
  }

  // MARK: - Chunk File Reading

  private func readChunkData(
    fileUri: String, chunkIndex: Int, chunkSize: Int, fileSize: Int64
  ) -> Data? {
    let url = URL(fileURLWithPath: fileUri)
    guard let fileHandle = try? FileHandle(forReadingFrom: url) else { return nil }
    defer { fileHandle.closeFile() }

    let offset = Int64(chunkIndex) * Int64(chunkSize)
    let length = min(Int64(chunkSize), fileSize - offset)

    fileHandle.seek(toFileOffset: offset)
    return fileHandle.readData(ofLength: Int(length))
  }

  // MARK: - Task Creation

  private func createUploadTask(
    session: URLSession, uploadId: String, chunkIndex: Int, totalChunks: Int,
    chunkData: Data, fileName: String, mimeType: String,
    apiUrl: String, authToken: String
  ) -> URLSessionUploadTask {

    // Write chunk to temporary file (background URLSession requires file-based upload)
    let tempDir = FileManager.default.temporaryDirectory
      .appendingPathComponent("medacademy_chunks")
      .appendingPathComponent(uploadId)
    try? FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)

    let chunkFile = tempDir.appendingPathComponent("chunk_\(chunkIndex)")
    try? chunkData.write(to: chunkFile)

    // Build the request matching the JS XHR contract exactly
    var request = URLRequest(url: URL(string: "\(apiUrl)/video/chunk")!)
    request.httpMethod = "POST"
    request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
    request.setValue("\(uploadId)", forHTTPHeaderField: "x-upload-id")
    request.setValue("\(chunkIndex)", forHTTPHeaderField: "x-chunk-index")
    request.setValue("\(totalChunks)", forHTTPHeaderField: "x-total-chunks")
    request.setValue("\(chunkData.count)", forHTTPHeaderField: "x-chunk-size")
    request.setValue(fileName, forHTTPHeaderField: "x-file-name")
    request.setValue(mimeType, forHTTPHeaderField: "x-mime-type")
    request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")

    // Use uploadTask(with:fromFile:) — iOS reads the file and streams it to the server
    // even when the app is suspended. This is the key API for background uploads.
    return session.uploadTask(with: request, fromFile: chunkFile)
  }

  // MARK: - Assembly & Finalization

  func triggerAssembly(uploadId: String, state: UploadState) {
    guard !state.assemblyTriggered else { return }

    let url = URL(string: "\(state.apiUrl)/video/assemble")!
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("Bearer \(state.authToken)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")

    let body: [String: Any] = [
      "upload_id": uploadId,
      "total_chunks": state.totalChunks,
      "file_name": state.fileName,
      "mime_type": state.mimeType,
    ]
    request.httpBody = try? JSONSerialization.data(withJSONObject: body)

    let task = URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
      guard let self = self else { return }

      if let error = error {
        self.emitErrorEvent(uploadId: uploadId, message: "Assembly failed: \(error.localizedDescription)")
        return
      }

      guard let httpResponse = response as? HTTPURLResponse,
            (200...299).contains(httpResponse.statusCode),
            let data = data,
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let videoId = json["video_id"] as? String else {
        let bodyStr = data.flatMap { String(data: $0, encoding: .utf8) } ?? "unknown"
        self.emitErrorEvent(uploadId: uploadId, message: "Assembly HTTP error: \(bodyStr)")
        return
      }

      // Mark assembly as triggered
      var updatedState = state
      updatedState.assemblyTriggered = true
      updatedState.providerVideoId = videoId
      self.uploadStates[uploadId] = updatedState
      self.saveStates()

      self.emitAssemblyCompleteEvent(uploadId: uploadId, videoId: videoId)

      // Now poll VdoCipher until ready
      self.pollVdoCipherStatus(uploadId: uploadId, videoId: videoId, state: updatedState)
    }
    task.resume()
  }

  func pollVdoCipherStatus(uploadId: String, videoId: String, state: UploadState) {
    let deadline = Date().addingTimeInterval(10 * 60) // 10-minute timeout

    func poll() {
      guard Date() < deadline else {
        emitErrorEvent(uploadId: uploadId, message: "VdoCipher processing timed out")
        return
      }

      let url = URL(string: "\(state.apiUrl)/video/upload-status")!
      var request = URLRequest(url: url)
      request.httpMethod = "POST"
      request.setValue("Bearer \(state.authToken)", forHTTPHeaderField: "Authorization")
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")

      let body: [String: Any] = ["video_id": videoId]
      request.httpBody = try? JSONSerialization.data(withJSONObject: body)

      let task = URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
        guard let self = self else { return }

        if let _ = error {
          // Retry after delay
          DispatchQueue.global().asyncAfter(deadline: .now() + 5) { poll() }
          return
        }

        guard let data = data,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
          DispatchQueue.global().asyncAfter(deadline: .now() + 5) { poll() }
          return
        }

        let status = json["status"] as? String ?? ""
        let vdoStatus = json["vdo_status"] as? String ?? ""
        let duration = json["duration"] as? Double
        let poster = json["poster"] as? String

        if status == "ready" || vdoStatus == "ready" || vdoStatus == "3" {
          // Ready! Trigger finalization via PHP API
          self.finalizeUpload(uploadId: uploadId, videoId: videoId, state: state,
                              duration: duration, poster: poster)
          return
        }

        if status == "failed" || vdoStatus == "-1" {
          self.emitErrorEvent(uploadId: uploadId, message: "VdoCipher encoding failed: \(vdoStatus)")
          return
        }

        // Still processing — emit progress and retry
        self.emitProcessingEvent(uploadId: uploadId, status: vdoStatus)
        DispatchQueue.global().asyncAfter(deadline: .now() + 5) { poll() }
      }
      task.resume()
    }

    poll()
  }

  func finalizeUpload(
    uploadId: String, videoId: String, state: UploadState,
    duration: Double?, poster: String?
  ) {
    // Step 1: Create video_assets via PHP API
    let createAssetUrl = URL(string: "\(state.apiUrl)/api/video_assets")!
    var createRequest = URLRequest(url: createAssetUrl)
    createRequest.httpMethod = "POST"
    createRequest.setValue("Bearer \(state.authToken)", forHTTPHeaderField: "Authorization")
    createRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")

    var assetBody: [String: Any] = [
      "doctor_id": state.doctorId ?? "",
      "provider_video_id": videoId,
      "title": (state.fileName as NSString).deletingPathExtension,
      "status": "ready",
      "upload_id": uploadId,
      "file_size_bytes": state.fileSize,
    ]
    if let d = duration { assetBody["duration_seconds"] = d }
    if let p = poster { assetBody["thumbnail_url"] = p }

    createRequest.httpBody = try? JSONSerialization.data(withJSONObject: assetBody)

    let createTask = URLSession.shared.dataTask(with: createRequest) { [weak self] data, response, error in
      guard let self = self else { return }

      var assetId: String?
      if let data = data,
         let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
        assetId = json["id"] as? String
      }

      // Step 2: If lesson upload, link the video to the lesson
      if let lessonId = state.lessonId, let assetId = assetId {
        self.linkToLesson(
          uploadId: uploadId, lessonId: lessonId, assetId: assetId,
          videoId: videoId, state: state, duration: duration, poster: poster
        )
      } else {
        // Library upload — just update the upload record
        self.updateUploadRecord(uploadId: uploadId, status: "ready", state: state)
        self.emitCompleteEvent(uploadId: uploadId, videoId: videoId)
      }
    }
    createTask.resume()
  }

  func linkToLesson(
    uploadId: String, lessonId: String, assetId: String,
    videoId: String, state: UploadState, duration: Double?, poster: String?
  ) {
    // Update lessons table
    var lessonPatch: [String: Any] = [
      "video_asset_id": assetId,
      "video_id": videoId,
      "video_status": "ready",
      "video_upload_id": uploadId,
      "updated_at": ISO8601DateFormatter().string(from: Date()),
    ]
    if let d = duration { lessonPatch["video_duration_seconds"] = d }
    if let p = poster { lessonPatch["video_thumbnail_url"] = p }

    let url = URL(string: "\(state.apiUrl)/api/lessons?id=\(lessonId)")!
    var request = URLRequest(url: url)
    request.httpMethod = "PATCH"
    request.setValue("Bearer \(state.authToken)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try? JSONSerialization.data(withJSONObject: lessonPatch)

    let task = URLSession.shared.dataTask(with: request) { [weak self] _, _, _ in
      guard let self = self else { return }
      self.updateUploadRecord(uploadId: uploadId, status: "ready", state: state)
      self.emitCompleteEvent(uploadId: uploadId, videoId: videoId)
    }
    task.resume()
  }

  func updateUploadRecord(uploadId: String, status: String, state: UploadState) {
    var patch: [String: Any] = [
      "status": status,
      "updated_at": ISO8601DateFormatter().string(from: Date()),
    ]
    if status == "ready" {
      patch["ready_at"] = ISO8601DateFormatter().string(from: Date())
      patch["verification_status"] = "passed"
      if let vid = state.providerVideoId {
        patch["provider_video_id"] = vid
      }
    }

    let url = URL(string: "\(state.apiUrl)/api/video_uploads?id=\(uploadId)")!
    var request = URLRequest(url: url)
    request.httpMethod = "PATCH"
    request.setValue("Bearer \(state.authToken)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try? JSONSerialization.data(withJSONObject: patch)

    let task = URLSession.shared.dataTask(with: request) { _, _, _ in }
    task.resume()
  }

  // MARK: - Event Emission

  func emitProgressEvent(uploadId: String, state: UploadState) {
    let progress = state.totalChunks > 0
      ? Int(Double(state.completedChunks.count) / Double(state.totalChunks) * 100)
      : 0
    let bytesUploaded = Int64(state.completedChunks.count) * Int64(state.chunkSize)

    let event: [String: Any] = [
      "uploadId": uploadId,
      "event": "progress",
      "chunksCompleted": state.completedChunks.count,
      "totalChunks": state.totalChunks,
      "bytesUploaded": min(bytesUploaded, state.fileSize),
      "totalBytes": state.fileSize,
      "progress": progress,
    ]
    emitEvent("nativeUploadEvent", body: event)
    // Update progress notification every 5% to avoid spamming
    if progress % 5 == 0 || progress == 100 {
      showProgressNotification(uploadId: uploadId, fileName: state.fileName, progress: progress)
    }
  }

  func emitCompleteEvent(uploadId: String, videoId: String) {
    let event: [String: Any] = [
      "uploadId": uploadId,
      "event": "complete",
      "videoId": videoId,
    ]
    emitEvent("nativeUploadEvent", body: event)
    // Show system notification
    let fileName = uploadStates[uploadId]?.fileName ?? "Video"
    showCompletionNotification(uploadId: uploadId, fileName: fileName)
    dismissNotification(identifier: "upload_\(uploadId)")
    uploadStates.removeValue(forKey: uploadId)
    saveStates()
    cleanupTempFiles(uploadId: uploadId)
  }

  func emitErrorEvent(uploadId: String, message: String) {
    let event: [String: Any] = [
      "uploadId": uploadId,
      "event": "error",
      "message": message,
    ]
    emitEvent("nativeUploadEvent", body: event)
    // Show system notification
    let fileName = uploadStates[uploadId]?.fileName ?? "Video"
    showFailureNotification(uploadId: uploadId, fileName: fileName, message: message)
    dismissNotification(identifier: "upload_\(uploadId)")
  }

  func emitCancelEvent(uploadId: String) {
    let event: [String: Any] = [
      "uploadId": uploadId,
      "event": "cancelled",
    ]
    emitEvent("nativeUploadEvent", body: event)
  }

  func emitAssemblyCompleteEvent(uploadId: String, videoId: String) {
    let event: [String: Any] = [
      "uploadId": uploadId,
      "event": "assembly_complete",
      "videoId": videoId,
    ]
    emitEvent("nativeUploadEvent", body: event)
  }

  func emitProcessingEvent(uploadId: String, status: String) {
    let event: [String: Any] = [
      "uploadId": uploadId,
      "event": "processing",
      "status": status,
    ]
    emitEvent("nativeUploadEvent", body: event)
  }

  private func emitEvent(_ name: String, body: [String: Any]) {
    DispatchQueue.main.async {
      self.eventEmitter?.sendEvent(withName: name, body: body)
    }
  }

  // MARK: - Local Notifications

  private func requestNotificationPermission() {
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
  }

  private func showProgressNotification(uploadId: String, fileName: String, progress: Int) {
    let state = uploadStates[uploadId]
    let content = UNMutableNotificationContent()
    content.title = "Uploading video"
    content.body = "\(fileName) — \(progress)%"
    content.sound = nil
    content.categoryIdentifier = "upload_progress"

    let request = UNNotificationRequest(
      identifier: "upload_\(uploadId)",
      content: content,
      trigger: nil
    )
    UNUserNotificationCenter.current().add(request)
  }

  private func showCompletionNotification(uploadId: String, fileName: String) {
    let content = UNMutableNotificationContent()
    content.title = "Upload complete"
    content.body = "\(fileName) has been uploaded successfully."
    content.sound = .default
    content.categoryIdentifier = "upload_complete"

    let request = UNNotificationRequest(
      identifier: "upload_complete_\(uploadId)",
      content: content,
      trigger: nil
    )
    UNUserNotificationCenter.current().add(request)
  }

  private func showFailureNotification(uploadId: String, fileName: String, message: String) {
    let content = UNMutableNotificationContent()
    content.title = "Upload failed"
    content.body = "\(fileName) — Tap to retry"
    content.sound = .default
    content.categoryIdentifier = "upload_failed"

    let request = UNNotificationRequest(
      identifier: "upload_failed_\(uploadId)",
      content: content,
      trigger: nil
    )
    UNUserNotificationCenter.current().add(request)
  }

  private func dismissNotification(identifier: String) {
    UNUserNotificationCenter.current()
      .removePendingNotificationRequests(withIdentifiers: [identifier])
    UNUserNotificationCenter.current()
      .removeDeliveredNotifications(withIdentifiers: [identifier])
  }

  // MARK: - Persistence

  private func saveStates() {
    if let data = try? JSONEncoder().encode(uploadStates) {
      UserDefaults.standard.set(data, forKey: "medacademy_upload_states")
    }
  }

  private func loadStates() {
    guard let data = UserDefaults.standard.data(forKey: "medacademy_upload_states"),
          let states = try? JSONDecoder().decode([String: UploadState].self, from: data) else {
      return
    }
    uploadStates = states
  }

  private func cleanupTempFiles(uploadId: String) {
    let tempDir = FileManager.default.temporaryDirectory
      .appendingPathComponent("medacademy_chunks")
      .appendingPathComponent(uploadId)
    try? FileManager.default.removeItem(at: tempDir)
  }
}
