/**
 * UploadBridgeModule.kt
 *
 * React Native bridge module that allows JavaScript to:
 *   - Start the native foreground upload service
 *   - Cancel an active upload
 *   - Check if native upload is available
 *
 * The actual upload is performed by ForegroundUploadService.
 * This module just sends Intents to start/stop the service.
 */

package com.medacademy.upload

import android.content.Intent
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap

private const val TAG = "UploadBridge"

class UploadBridgeModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "NativeUploadBridge"

    /**
     * Start native foreground upload.
     *
     * @param config JSON object with upload configuration:
     *   - uploadId: string
     *   - fileUri: string (file:// URI — must be stable, not content://)
     *   - fileName: string
     *   - mimeType: string
     *   - fileSize: number (bytes)
     *   - chunkSize: number (bytes, default 8MB)
     *   - totalChunks: number
     *   - startChunk: number (for resume)
     *   - apiUrl: string (PHP backend base URL)
     *   - authToken: string (Bearer token)
     *   - lessonId: string | null
     *   - courseId: string | null
     *   - doctorId: string | null
     */
    @ReactMethod
    fun startUpload(config: ReadableMap, promise: Promise) {
        try {
            val ctx = reactApplicationContext
            val intent = Intent(ctx, ForegroundUploadService::class.java).apply {
                action = ACTION_START_UPLOAD
                putExtra(EXTRA_UPLOAD_ID, config.getString("uploadId"))
                putExtra(EXTRA_FILE_URI, config.getString("fileUri"))
                putExtra(EXTRA_FILE_NAME, config.getString("fileName") ?: "video.mp4")
                putExtra(EXTRA_MIME_TYPE, config.getString("mimeType") ?: "video/mp4")
                putExtra(EXTRA_FILE_SIZE, config.getDouble("fileSize").toLong())
                putExtra(EXTRA_CHUNK_SIZE, config.getInt("chunkSize"))
                putExtra(EXTRA_TOTAL_CHUNKS, config.getInt("totalChunks"))
                putExtra(EXTRA_START_CHUNK, config.getInt("startChunk"))
                putExtra(EXTRA_API_URL, config.getString("apiUrl"))
                putExtra(EXTRA_AUTH_TOKEN, config.getString("authToken"))
                putExtra(EXTRA_REFRESH_TOKEN, config.getString("refreshToken") ?: "")
                putExtra(EXTRA_LESSON_ID, config.getString("lessonId") ?: "")
                putExtra(EXTRA_COURSE_ID, config.getString("courseId") ?: "")
                putExtra(EXTRA_DOCTOR_ID, config.getString("doctorId") ?: "")
            }

            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                ctx.startForegroundService(intent)
            } else {
                ctx.startService(intent)
            }

            Log.d(TAG, "startUpload sent for ${config.getString("uploadId")}")
            promise.resolve(true)
        } catch (e: Exception) {
            Log.e(TAG, "startUpload failed: ${e.message}", e)
            promise.reject("UPLOAD_START_FAILED", e.message)
        }
    }

    /**
     * Cancel an active upload.
     */
    @ReactMethod
    fun cancelUpload(uploadId: String, promise: Promise) {
        try {
            val ctx = reactApplicationContext
            val intent = Intent(ctx, ForegroundUploadService::class.java).apply {
                action = ACTION_CANCEL_UPLOAD
                putExtra(EXTRA_UPLOAD_ID, uploadId)
            }
            ctx.startService(intent)

            Log.d(TAG, "cancelUpload sent for $uploadId")
            promise.resolve(true)
        } catch (e: Exception) {
            Log.e(TAG, "cancelUpload failed: ${e.message}", e)
            promise.reject("UPLOAD_CANCEL_FAILED", e.message)
        }
    }

    /**
     * Check if native upload is available (always true on Android).
     */
    @ReactMethod
    fun isNativeUploadAvailable(promise: Promise) {
        promise.resolve(true)
    }
}
