package expo.modules.nhgatewaynative

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/** Its own class, so its manifest entry cannot collide with another library's FileProvider. */
class NhUpdateFileProvider : FileProvider()

/**
 * In-app update of NH Pocket: downloads a release APK into cacheDir/updates,
 * checks its size, sha256 and package name, and hands it to Android's
 * package installer (the user confirms there; Android itself refuses an APK
 * signed by someone else).
 */
object ApkUpdater {
  private const val DIR = "updates"
  private const val MAX_BYTES = 300L * 1024 * 1024

  class UpdateError(code: String) : Exception(code)

  private fun dir(context: Context): File = File(context.cacheDir, DIR).apply { mkdirs() }

  /** Downloads [url]; [onProgress] gets (received, total). Returns the verified file's path. */
  fun download(context: Context, url: String, sha256: String, size: Long, onProgress: (Long, Long) -> Unit): String {
    if (!url.startsWith("https://")) throw UpdateError("insecure_url")
    if (size <= 0 || size > MAX_BYTES) throw UpdateError("bad_size")
    val target = File(dir(context), "nh-pocket-update.apk")
    val part = File(dir(context), "nh-pocket-update.apk.part")
    part.delete()
    val digest = MessageDigest.getInstance("SHA-256")
    var received = 0L
    var connection: HttpURLConnection? = null
    try {
      connection = (URL(url).openConnection() as HttpURLConnection).apply {
        connectTimeout = 15_000
        readTimeout = 30_000
        instanceFollowRedirects = true
        setRequestProperty("User-Agent", "NH-Pocket")
      }
      val status = connection.responseCode
      if (status != 200) throw UpdateError("http_$status")
      connection.inputStream.use { input ->
        part.outputStream().use { output ->
          val buffer = ByteArray(64 * 1024)
          var lastReport = 0L
          while (true) {
            val n = input.read(buffer)
            if (n < 0) break
            received += n
            if (received > size) throw UpdateError("size_mismatch")
            digest.update(buffer, 0, n)
            output.write(buffer, 0, n)
            if (received - lastReport >= 256 * 1024 || received == size) {
              lastReport = received
              onProgress(received, size)
            }
          }
        }
      }
    } catch (error: UpdateError) {
      part.delete()
      throw error
    } catch (error: Exception) {
      part.delete()
      throw UpdateError("network")
    } finally {
      connection?.disconnect()
    }
    if (received != size) {
      part.delete()
      throw UpdateError("size_mismatch")
    }
    val hex = digest.digest().joinToString("") { "%02x".format(it) }
    if (!hex.equals(sha256.trim(), ignoreCase = true)) {
      part.delete()
      throw UpdateError("sha256_mismatch")
    }
    target.delete()
    if (!part.renameTo(target)) throw UpdateError("write_failed")
    // Only an update of this very app.
    @Suppress("DEPRECATION")
    val info = context.packageManager.getPackageArchiveInfo(target.absolutePath, 0)
    if (info == null || info.packageName != context.packageName) {
      target.delete()
      throw UpdateError("wrong_package")
    }
    return target.absolutePath
  }

  /** Whether Android lets this app open the installer (the "install unknown apps" switch). */
  fun canInstall(context: Context): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.packageManager.canRequestPackageInstalls()

  /** Opens this app's "install unknown apps" switch in Settings. */
  fun openInstallSettings(context: Context) {
    val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    context.startActivity(intent)
  }

  /** Opens the package installer on a file download() returned. */
  fun install(context: Context, path: String) {
    val file = File(path)
    if (file.parentFile?.canonicalPath != dir(context).canonicalPath || !file.isFile) throw UpdateError("not_downloaded")
    val uri = FileProvider.getUriForFile(context, "${context.packageName}.nhupdates", file)
    val intent = Intent(Intent.ACTION_VIEW)
      .setDataAndType(uri, "application/vnd.android.package-archive")
      .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    context.startActivity(intent)
  }

  /** The installed app's versionName / versionCode. */
  fun installedVersion(context: Context): Map<String, Any> {
    val info = context.packageManager.getPackageInfo(context.packageName, 0)
    @Suppress("DEPRECATION")
    val code = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong()
    return mapOf("versionName" to (info.versionName ?: ""), "versionCode" to code.toDouble())
  }
}
