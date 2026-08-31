/**
 * ForegroundUploadService.kt
 *
 * Real native Android foreground service that performs video chunk uploads
 * using native HttpURLConnection. This runs independently of the JavaScript
 * thread — when the user backgrounds the app, the foreground service keeps
 * the process alive and the native HTTP uploads continue.
 *
 * Architecture:
 *   JS (useVideoUploader) → NativeBridge.startUpload() → this Service
 *   this Service → native HTTP chunk uploads → DeviceEventEmitter → JS
 *
 * The JS layer still handles:
 *   - URI stabilisation (copying content:// to file://)
 *   - File chunking (reading file slices)
 *   - VdoCipher assembly trigger
 *   - VdoCipher encoding polling
 *   - video_assets creation
 *   - Upload Queue UI state
 *
 * This service handles:
 *   - Foreground service lifecycle (notification, keep-alive)
 *   - Native HTTP chunk uploads (survives JS suspension)
 *   - Progress reporting back to JS via DeviceEventEmitter
 *   - Completion / failure signaling to JS
 */

package com.medacademy.upload

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import java.io.BufferedReader
import java.io.File
import java.io.InputStream
import java.io.InputStreamReader
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONObject

private const val TAG = "ForegroundUploadSvc"
private const val CHANNEL_ID = "video-upload"
private const val CHANNEL_NAME = "Video Uploads"
private const val NOTIFICATION_ID = 7701

/**
 * Intent actions
 */
const val ACTION_START_UPLOAD = "com.medacademy.upload.START"
const val ACTION_CANCEL_UPLOAD = "com.medacademy.upload.CANCEL"

/**
 * Intent extras
 */
const val EXTRA_UPLOAD_ID = "upload_id"
const val EXTRA_FILE_URI = "file_uri"
const val EXTRA_FILE_NAME = "file_name"
const val EXTRA_MIME_TYPE = "mime_type"
const val EXTRA_FILE_SIZE = "file_size"
const val EXTRA_CHUNK_SIZE = "chunk_size"
const val EXTRA_TOTAL_CHUNKS = "total_chunks"
const val EXTRA_START_CHUNK = "start_chunk"
const val EXTRA_API_URL = "api_url"
const val EXTRA_AUTH_TOKEN = "auth_token"
const val EXTRA_REFRESH_TOKEN = "refresh_token"
const val EXTRA_LESSON_ID = "lesson_id"
const val EXTRA_COURSE_ID = "course_id"
const val EXTRA_DOCTOR_ID = "doctor_id"

class ForegroundUploadService : Service() {

    private var executor: ExecutorService? = null
    private val isCancelled = AtomicBoolean(false)
    private var currentUploadId: String? = null

    // ── Token management ────────────────────────────────────────────────────
    // Current access + refresh tokens, updated after each refresh.
    private var currentAccessToken: String = ""
    private var currentRefreshToken: String = ""
    private var currentApiUrl: String = ""
    // Synchronized lock to prevent concurrent refresh requests.
    // Refresh-token rotation makes concurrent refreshes dangerous.
    private val refreshLock = Any()
    private val REFRESH_THRESHOLD_SECONDS = 120L  // Refresh when <= 2 minutes remain

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        Log.d(TAG, "Service created")
    }

    // ══════════════════════════════════════════════════════════════════════════
    // TOKEN REFRESH — proactively refreshes the access token before expiry
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * Decode the JWT `exp` claim without external libraries.
     * JWT format: header.payload.signature
     * The payload is base64url-encoded JSON containing { exp: number }.
     * Returns the expiration timestamp, or Long.MAX_VALUE if decoding fails.
     */
    private fun decodeJwtExp(token: String): Long {
        return try {
            val parts = token.split(".")
            if (parts.size != 3) return Long.MAX_VALUE
            val payload = parts[1]
            // Base64url decode
            val decoded = android.util.Base64.decode(
                payload.replace('-', '+').replace('_', '/'),
                android.util.Base64.DEFAULT
            )
            val json = String(decoded, Charsets.UTF_8)
            // Simple JSON parse for "exp" field
            val match = Regex(""""exp"\s*:\s*(\d+)""").find(json)
            match?.groupValues?.get(1)?.toLongOrNull() ?: Long.MAX_VALUE
        } catch (e: Exception) {
            Log.w(TAG, "Failed to decode JWT exp: \${e.message}")
            Long.MAX_VALUE
        }
    }

    /**
     * Check if the current access token needs refreshing.
     * Returns true if the token expires within REFRESH_THRESHOLD_SECONDS.
     */
    private fun tokenNeedsRefresh(): Boolean {
        if (currentAccessToken.isEmpty()) return true
        val exp = decodeJwtExp(currentAccessToken)
        val remaining = exp - System.currentTimeMillis() / 1000
        return remaining <= REFRESH_THRESHOLD_SECONDS
    }

    /**
     * Refresh the access token using the refresh token.
     * Uses a synchronized lock to prevent concurrent refresh requests.
     * Returns true if refresh succeeded, false otherwise.
     */
    private fun refreshAuthToken(): Boolean {
        synchronized(refreshLock) {
            // Double-check after acquiring lock — another thread may have refreshed
            if (!tokenNeedsRefresh()) {
                Log.d(TAG, "Token already refreshed by another thread")
                return true
            }

            if (currentRefreshToken.isEmpty()) {
                Log.e(TAG, "No refresh token available")
                return false
            }

            Log.d(TAG, "Refreshing auth token…")

            try {
                val url = URL("$currentApiUrl/auth/refresh")
                val conn = url.openConnection() as HttpURLConnection
                conn.requestMethod = "POST"
                conn.doOutput = true
                conn.connectTimeout = 15_000
                conn.readTimeout = 15_000
                conn.setRequestProperty("Content-Type", "application/json")
                conn.setRequestProperty("Accept", "application/json")

                val body = """{"refresh_token":"$currentRefreshToken"}"""
                conn.outputStream.write(body.toByteArray(Charsets.UTF_8))
                conn.outputStream.flush()
                conn.outputStream.close()

                val responseCode = conn.responseCode
                val inputStream = if (responseCode in 200..299) conn.inputStream else conn.errorStream
                val response = inputStream.bufferedReader().readText()
                inputStream.close()

                if (responseCode in 200..299) {
                    val json = org.json.JSONObject(response)
                    val session = json.getJSONObject("session")
                    val newAccessToken = session.getString("access_token")
                    val newRefreshToken = session.getString("refresh_token")

                    currentAccessToken = newAccessToken
                    currentRefreshToken = newRefreshToken

                    Log.d(TAG, "Token refresh succeeded")
                    return true
                } else {
                    Log.e(TAG, "Token refresh failed: HTTP $responseCode")
                    return false
                }
            } catch (e: Exception) {
                Log.e(TAG, "Token refresh exception: \${e.message}")
                return false
            }
        }
    }

    /**
     * Ensure the access token is fresh before making a request.
     * If the token is about to expire, proactively refresh it.
     * Returns the current valid access token.
     */
    private fun ensureFreshToken(): String {
        if (tokenNeedsRefresh()) {
            val refreshed = refreshAuthToken()
            if (!refreshed) {
                Log.w(TAG, "Token refresh failed — will use existing token (may fail with 401)")
            }
        }
        return currentAccessToken
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START_UPLOAD -> {
                val uploadId = intent.getStringExtra(EXTRA_UPLOAD_ID) ?: run {
                    Log.e(TAG, "START without uploadId — stopping")
                    stopSelf()
                    return START_NOT_STICKY
                }

                // If we're already uploading this same ID, ignore duplicate start
                if (currentUploadId == uploadId && executor != null && !executor!!.isShutdown) {
                    Log.d(TAG, "Already uploading $uploadId — ignoring duplicate")
                    return START_STICKY
                }

                currentUploadId = uploadId
                isCancelled.set(false)

                // Start foreground IMMEDIATELY (required within 5s on Android 12+)
                startForeground(NOTIFICATION_ID, buildNotification(uploadId, "Preparing upload…", 0))

                // Execute upload on background thread
                executor?.shutdownNow()
                executor = Executors.newSingleThreadExecutor()
                executor?.execute { performUpload(intent) }

                return START_STICKY
            }

            ACTION_CANCEL_UPLOAD -> {
                val uploadId = intent.getStringExtra(EXTRA_UPLOAD_ID)
                Log.d(TAG, "CANCEL requested for $uploadId")
                isCancelled.set(true)
                executor?.shutdownNow()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
                return START_NOT_STICKY
            }

            else -> {
                Log.d(TAG, "Unknown action: ${intent?.action}")
                stopSelf()
                return START_NOT_STICKY
            }
        }
    }

    override fun onDestroy() {
        isCancelled.set(true)
        executor?.shutdownNow()
        Log.d(TAG, "Service destroyed")
        super.onDestroy()
    }

    /**
     * The actual native upload loop. Runs on a background thread.
     * Reads file chunks from disk and uploads via HttpURLConnection.
     * Sends progress events to JS via React Native DeviceEventEmitter.
     */
    private fun performUpload(intent: Intent) {
        val uploadId = intent.getStringExtra(EXTRA_UPLOAD_ID) ?: return
        val fileUriStr = intent.getStringExtra(EXTRA_FILE_URI) ?: return
        val fileName = intent.getStringExtra(EXTRA_FILE_NAME) ?: "video.mp4"
        val mimeType = intent.getStringExtra(EXTRA_MIME_TYPE) ?: "video/mp4"
        val fileSize = intent.getLongExtra(EXTRA_FILE_SIZE, 0)
        val chunkSize = intent.getIntExtra(EXTRA_CHUNK_SIZE, 8 * 1024 * 1024)
        val totalChunks = intent.getIntExtra(EXTRA_TOTAL_CHUNKS, 1)
        val startChunk = intent.getIntExtra(EXTRA_START_CHUNK, 0)
        val apiUrl = intent.getStringExtra(EXTRA_API_URL) ?: return
        val authToken = intent.getStringExtra(EXTRA_AUTH_TOKEN) ?: return
        val refreshToken = intent.getStringExtra(EXTRA_REFRESH_TOKEN) ?: ""

        // Initialize token state for refresh
        currentAccessToken = authToken
        currentRefreshToken = refreshToken
        currentApiUrl = apiUrl

        Log.d(TAG, "performUpload: id=$uploadId chunks=$totalChunks start=$startChunk size=$fileSize hasRefreshToken=${refreshToken.isNotEmpty()}")

        try {
            // Resolve the file URI to a readable file path
            val file = resolveFile(fileUriStr)
            if (!file.exists() || file.length() == 0) {
                emitError(uploadId, "File not found or empty: $fileUriStr")
                return
            }

            val raf = RandomAccessFile(file, "r")
            val buffer = ByteArray(chunkSize)

            for (chunkIndex in startChunk until totalChunks) {
                // Check cancellation
                if (isCancelled.get()) {
                    Log.d(TAG, "Upload cancelled at chunk $chunkIndex")
                    raf.close()
                    return
                }

                val chunkStart = chunkIndex.toLong() * chunkSize
                val chunkEnd = minOf(chunkStart + chunkSize, fileSize)
                val thisChunkSize = (chunkEnd - chunkStart).toInt()

                // Read chunk from file
                raf.seek(chunkStart)
                val bytesRead = raf.read(buffer, 0, thisChunkSize)
                if (bytesRead <= 0) {
                    Log.e(TAG, "Failed to read chunk $chunkIndex")
                    emitError(uploadId, "Failed to read chunk $chunkIndex from file")
                    raf.close()
                    return
                }

                val chunkData = if (bytesRead == thisChunkSize) {
                    buffer
                } else {
                    buffer.copyOf(bytesRead)
                }

                // Ensure token is fresh before uploading (proactive refresh)
                val freshToken = ensureFreshToken()

                // Upload this chunk via native HTTP
                var result = uploadChunkNative(
                    uploadId = uploadId,
                    chunkIndex = chunkIndex,
                    totalChunks = totalChunks,
                    chunkData = chunkData,
                    chunkSize = bytesRead,
                    fileName = fileName,
                    mimeType = mimeType,
                    apiUrl = apiUrl,
                    authToken = freshToken,
                )

                // If we got a 401, try refreshing and retrying once
                if (!result.success && result.isUnauthorized) {
                    Log.d(TAG, "Chunk $chunkIndex got 401 — refreshing token and retrying")
                    val refreshed = refreshAuthToken()
                    if (refreshed) {
                        result = uploadChunkNative(
                            uploadId = uploadId,
                            chunkIndex = chunkIndex,
                            totalChunks = totalChunks,
                            chunkData = chunkData,
                            chunkSize = bytesRead,
                            fileName = fileName,
                            mimeType = mimeType,
                            apiUrl = apiUrl,
                            authToken = currentAccessToken,
                        )
                    }
                }

                raf.close()

                if (!result.success) {
                    emitError(uploadId, "Chunk $chunkIndex upload failed: ${result.errorMessage}")
                    return
                }

                // Report progress to JS
                val bytesUploaded = minOf((chunkIndex + 1).toLong() * chunkSize, fileSize)
                val progress = if (totalChunks > 0) {
                    ((chunkIndex + 1).toFloat() / totalChunks * 100).toInt()
                } else 0

                emitProgress(uploadId, chunkIndex + 1, totalChunks, bytesUploaded, fileSize, progress)
                updateNotification(uploadId, fileName, progress)

                Log.d(TAG, "Chunk $chunkIndex/$totalChunks uploaded (${bytesUploaded}/${fileSize})")

                // If assembly was triggered, report completion
                if (result.assemblyTriggered) {
                    emitAssemblyTriggered(uploadId, chunkIndex + 1, totalChunks)
                }
            }

            // All chunks uploaded
            Log.d(TAG, "All $totalChunks chunks uploaded for $uploadId")
            emitComplete(uploadId)

        } catch (e: Exception) {
            Log.e(TAG, "Upload failed: ${e.message}", e)
            emitError(uploadId, "Upload failed: ${e.message}")
        } finally {
            // Stop foreground service after upload completes or fails
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    /**
     * Upload a single chunk using native HttpURLConnection.
     * This is the same HTTP contract as the JS XHR implementation.
     */
    private fun uploadChunkNative(
        uploadId: String,
        chunkIndex: Int,
        totalChunks: Int,
        chunkData: ByteArray,
        chunkSize: Int,
        fileName: String,
        mimeType: String,
        apiUrl: String,
        authToken: String,
    ): ChunkUploadResult {
        val url = URL("$apiUrl/video/chunk")
        var conn: HttpURLConnection? = null

        try {
            conn = url.openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.connectTimeout = 300_000  // 5 minutes
            conn.readTimeout = 300_000

            // Headers matching the JS XHR contract exactly
            conn.setRequestProperty("Authorization", "Bearer $authToken")
            conn.setRequestProperty("x-upload-id", uploadId)
            conn.setRequestProperty("x-chunk-index", chunkIndex.toString())
            conn.setRequestProperty("x-total-chunks", totalChunks.toString())
            conn.setRequestProperty("x-chunk-size", chunkSize.toString())
            conn.setRequestProperty("x-file-name", fileName)
            conn.setRequestProperty("x-mime-type", mimeType)
            conn.setRequestProperty("Content-Type", "application/octet-stream")

            // Write chunk data
            val os = conn.outputStream
            os.write(chunkData, 0, chunkSize)
            os.flush()
            os.close()

            val responseCode = conn.responseCode
            val inputStream: InputStream = if (responseCode in 200..299) {
                conn.inputStream
            } else {
                conn.errorStream
            }

            val reader = BufferedReader(InputStreamReader(inputStream))
            val response = reader.readText()
            reader.close()

            if (responseCode in 200..299) {
                val json = JSONObject(response)
                return ChunkUploadResult(
                    success = true,
                    received = json.optInt("received", 0),
                    total = json.optInt("total", 0),
                    assemblyTriggered = json.optBoolean("assembly_triggered", false),
                )
            } else {
                Log.e(TAG, "Chunk $chunkIndex HTTP $responseCode: $response")
                return ChunkUploadResult(
                    success = false,
                    errorMessage = "HTTP $responseCode: $response",
                    isUnauthorized = responseCode == 401,
                )
            }
        } catch (e: Exception) {
            Log.e(TAG, "Chunk $chunkIndex network error: ${e.message}", e)
            return ChunkUploadResult(
                success = false,
                errorMessage = "Network error: ${e.message}",
            )
        } finally {
            conn?.disconnect()
        }
    }

    /**
     * Resolve a file:// or content:// URI to a readable File.
     * For content:// URIs, we read the content provider.
     */
    private fun resolveFile(uriStr: String): File {
        val uri = Uri.parse(uriStr)

        if (uri.scheme == "file" || uriStr.startsWith("/")) {
            val path = uri.path ?: uriStr
            return File(path)
        }

        // For content:// URIs, we need to copy to a temp file
        // (This should rarely happen since JS stabilises URIs before starting)
        val tempFile = File(cacheDir, "upload_temp_${System.currentTimeMillis()}.mp4")
        contentResolver.openInputStream(uri)?.use { input ->
            tempFile.outputStream().use { output ->
                input.copyTo(output)
            }
        }
        return tempFile
    }

    // ── Notification ─────────────────────────────────────────────────────────

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                CHANNEL_NAME,
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Shows video upload progress"
                setShowBadge(false)
            }
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(uploadId: String, text: String, progress: Int): Notification {
        // Tap notification → open the app (this is the minimal intent)
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pendingIntent = PendingIntent.getActivity(
            this, 0, launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle("Uploading video…")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(pendingIntent)
            .setProgress(100, progress, false)
            .build()
    }

    private fun updateNotification(uploadId: String, fileName: String, progress: Int) {
        val nm = getSystemService(NotificationManager::class.java)
        val notification = buildNotification(uploadId, "$fileName — $progress%", progress)
        nm.notify(NOTIFICATION_ID, notification)
    }

    // ── JS Event Emission ────────────────────────────────────────────────────

    private fun emitProgress(
        uploadId: String,
        chunksCompleted: Int,
        totalChunks: Int,
        bytesUploaded: Long,
        totalBytes: Long,
        progress: Int,
    ) {
        try {
            val params = org.json.JSONObject().apply {
                put("uploadId", uploadId)
                put("event", "progress")
                put("chunksCompleted", chunksCompleted)
                put("totalChunks", totalChunks)
                put("bytesUploaded", bytesUploaded)
                put("totalBytes", totalBytes)
                put("progress", progress)
            }
            sendEvent("nativeUploadEvent", params)
        } catch (e: Exception) {
            Log.e(TAG, "emitProgress failed: ${e.message}")
        }
    }

    private fun emitComplete(uploadId: String) {
        try {
            val params = org.json.JSONObject().apply {
                put("uploadId", uploadId)
                put("event", "complete")
            }
            sendEvent("nativeUploadEvent", params)
        } catch (e: Exception) {
            Log.e(TAG, "emitComplete failed: ${e.message}")
        }
    }

    private fun emitError(uploadId: String, message: String) {
        try {
            val params = org.json.JSONObject().apply {
                put("uploadId", uploadId)
                put("event", "error")
                put("message", message)
            }
            sendEvent("nativeUploadEvent", params)
        } catch (e: Exception) {
            Log.e(TAG, "emitError failed: ${e.message}")
        }
    }

    private fun emitAssemblyTriggered(uploadId: String, chunksCompleted: Int, totalChunks: Int) {
        try {
            val params = org.json.JSONObject().apply {
                put("uploadId", uploadId)
                put("event", "assembly_triggered")
                put("chunksCompleted", chunksCompleted)
                put("totalChunks", totalChunks)
            }
            sendEvent("nativeUploadEvent", params)
        } catch (e: Exception) {
            Log.e(TAG, "emitAssemblyTriggered failed: ${e.message}")
        }
    }

    /**
     * Send event to React Native JS via the ReactContext.
     * This works because the service runs in the same process as the RN app.
     */
    private fun sendEvent(eventName: String, params: org.json.JSONObject) {
        try {
            val reactContext = (applicationContext as? com.facebook.react.ReactApplication)
                ?.reactNativeHost
                ?.reactInstanceManager
                ?.currentReactContext

            if (reactContext != null) {
                val writableMap = com.facebook.react.bridge.Arguments.createMap()
                for (key in params.keys()) {
                    when (val value = params.get(key)) {
                        is String -> writableMap.putString(key, value)
                        is Int -> writableMap.putInt(key, value)
                        is Long -> writableMap.putDouble(key, value.toDouble())
                        is Boolean -> writableMap.putBoolean(key, value)
                        is Double -> writableMap.putDouble(key, value)
                        is org.json.JSONObject -> {
                            // Convert nested JSONObject to WritableMap
                            val nested = com.facebook.react.bridge.Arguments.createMap()
                            for (k in value.keys()) {
                                when (v = value.get(k)) {
                                    is String -> nested.putString(k, v)
                                    is Int -> nested.putInt(k, v)
                                    is Long -> nested.putDouble(k, v.toDouble())
                                    is Double -> nested.putDouble(k, v)
                                    is Boolean -> nested.putBoolean(k, v)
                                }
                            }
                            writableMap.putMap(key, nested)
                        }
                    }
                }
                reactContext
                    .getJSModule(com.facebook.react.modules.core.DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit(eventName, writableMap)
                Log.d(TAG, "Event emitted: $eventName")
            } else {
                Log.w(TAG, "ReactContext null — cannot emit $eventName")
            }
        } catch (e: Exception) {
            Log.e(TAG, "sendEvent failed: ${e.message}")
        }
    }
}

data class ChunkUploadResult(
    val success: Boolean,
    val received: Int = 0,
    val total: Int = 0,
    val assemblyTriggered: Boolean = false,
    val errorMessage: String? = null,
    val isUnauthorized: Boolean = false,
)
