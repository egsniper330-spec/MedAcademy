/**
 * NativeUploadBridge.swift
 *
 * React Native bridge module for iOS background uploads.
 * Exposes native upload capabilities to JavaScript.
 */

import Foundation
import React

@objc(NativeUploadBridge)
class NativeUploadBridge: RCTEventEmitter {

  private let handler = BackgroundUploadHandler.shared

  override init() {
    super.init()
    handler.eventEmitter = self
  }

  /// Module name — must match NativeModules.NativeUploadBridge in JS
  override static func moduleName() -> String! {
    return "NativeUploadBridge"
  }

  /// Events this module can send to JS
  override func supportedEvents() -> [String]! {
    return ["nativeUploadEvent"]
  }

  /// Required for RCTEventEmitter — returns true for hasListeners
  @objc override static func requiresMainQueueSetup() -> Bool {
    return false
  }

  private var hasListeners = false

  override func startObserving() {
    hasListeners = true
  }

  override func stopObserving() {
    hasListeners = false
  }

  // MARK: - React Native Methods

  /**
   * Check if native background upload is available (always true on iOS).
   */
  @objc func isNativeUploadAvailable(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    resolve(true)
  }

  /**
   * Start native background upload.
   *
   * Config keys:
   *   uploadId, fileUri, fileName, mimeType, fileSize,
   *   chunkSize, totalChunks, startChunk,
   *   apiUrl, authToken,
   *   lessonId, courseId, doctorId
   */
  @objc func startUpload(
    _ config: NSDictionary,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let uploadId = config["uploadId"] as? String else {
      reject("INVALID_CONFIG", "uploadId is required", nil)
      return
    }

    guard let authToken = config["authToken"] as? String, !authToken.isEmpty else {
      reject("INVALID_CONFIG", "authToken is required", nil)
      return
    }

    guard let fileUri = config["fileUri"] as? String else {
      reject("INVALID_CONFIG", "fileUri is required", nil)
      return
    }

    // Verify the file exists and is readable
    let url = URL(fileURLWithPath: fileUri)
    guard FileManager.default.fileExists(atPath: fileUri) else {
      reject("FILE_NOT_FOUND", "File not found at \(fileUri)", nil)
      return
    }

    // Convert NSDictionary to [String: Any] for the handler
    var configDict: [String: Any] = [:]
    for (key, value) in config {
      if let key = key as? String {
        configDict[key] = value
      }
    }

    handler.startUpload(config: configDict)
    resolve(true)
  }

  /**
   * Cancel an active native upload.
   */
  @objc func cancelUpload(
    _ uploadId: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    handler.cancelUpload(uploadId: uploadId)
    resolve(true)
  }

  /**
   * Handle background session events from AppDelegate.
   * Called from the AppDelegate's handleEventsForBackgroundURLSession.
   */
  func handleBackgroundSessionEvents(
    identifier: String,
    completionHandler: @escaping () -> Void
  ) {
    handler.handleEventsForBackgroundURLSession(
      identifier: identifier,
      completionHandler: completionHandler
    )
  }
}
