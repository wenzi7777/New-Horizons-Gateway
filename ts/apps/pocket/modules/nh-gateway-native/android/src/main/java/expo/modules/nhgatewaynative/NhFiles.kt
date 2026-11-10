package expo.modules.nhgatewaynative

import android.content.Context
import android.os.StatFs
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.io.RandomAccessFile
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

// The app's files, under its external files dir (Android/data/<package>/files:
// survives app updates, reachable over USB for export) or the internal one
// when there is no external storage. JS passes '/'-separated paths relative to
// that root; anything absolute or containing ".." is refused.
//
// Every call is synchronous (the engine's RecordingFileSink is), so each is
// kept short: appends go into a 64 KiB buffer and reach the disk on flush().
object NhFiles {
  private const val BUFFER_BYTES = 64 * 1024

  @Volatile private var rootDir: File? = null
  private val handles = ConcurrentHashMap<Int, BufferedOutputStream>()
  private val nextHandle = AtomicInteger(1)

  fun init(context: Context) {
    if (rootDir != null) return
    synchronized(this) {
      if (rootDir == null) {
        val dir = context.getExternalFilesDir(null) ?: context.filesDir
        dir.mkdirs()
        rootDir = dir
      }
    }
  }

  fun root(): File = rootDir ?: throw IOException("files_not_ready")

  fun resolve(path: String): File {
    if (path.startsWith("/") || path.split('/').any { it == ".." }) throw IOException("invalid_path: $path")
    return if (path.isEmpty()) root() else File(root(), path)
  }

  fun exists(path: String): Boolean = resolve(path).exists()

  fun mkdirp(path: String) {
    val dir = resolve(path)
    if (!dir.isDirectory && !dir.mkdirs()) throw IOException("mkdir failed: $path")
  }

  /** Bytes in the file, -1 when it does not exist. */
  fun size(path: String): Long {
    val file = resolve(path)
    return if (file.isFile) file.length() else -1L
  }

  fun open(path: String): Int {
    val file = resolve(path)
    file.parentFile?.mkdirs()
    val stream = BufferedOutputStream(FileOutputStream(file, true), BUFFER_BYTES)
    val handle = nextHandle.getAndIncrement()
    handles[handle] = stream
    return handle
  }

  private fun stream(handle: Int): BufferedOutputStream =
    handles[handle] ?: throw IOException("I/O operation on closed file.")

  fun append(handle: Int, text: String) {
    stream(handle).write(text.toByteArray(Charsets.UTF_8))
  }

  fun flush(handle: Int) {
    stream(handle).flush()
  }

  fun close(handle: Int) {
    val stream = handles.remove(handle) ?: return
    stream.close()
  }

  fun closeAll() {
    for (handle in handles.keys.toList()) {
      try {
        close(handle)
      } catch (_: Exception) {
      }
    }
  }

  /** `<path>.tmp` written, synced and renamed over `path`. */
  fun writeAtomic(path: String, text: String) {
    val file = resolve(path)
    file.parentFile?.mkdirs()
    val tmp = File(file.parentFile, file.name + ".tmp")
    FileOutputStream(tmp).use { out ->
      out.write(text.toByteArray(Charsets.UTF_8))
      out.fd.sync()
    }
    if (!tmp.renameTo(file)) {
      // renameTo does not replace on every filesystem.
      file.delete()
      if (!tmp.renameTo(file)) throw IOException("rename failed: $path")
    }
  }

  /** The whole file as UTF-8, or null when it does not exist. */
  fun readText(path: String): String? {
    val file = resolve(path)
    return if (file.isFile) file.readText(Charsets.UTF_8) else null
  }

  /** Up to `length` bytes from `offset` (fewer at the end of the file; empty past it). */
  fun readBytes(path: String, offset: Long, length: Int): ByteArray {
    RandomAccessFile(resolve(path), "r").use { file ->
      val available = file.length() - offset
      if (available <= 0) return ByteArray(0)
      val n = minOf(length.toLong(), available).toInt()
      val out = ByteArray(n)
      file.seek(offset)
      file.readFully(out)
      return out
    }
  }

  fun stat(path: String): Map<String, Any>? {
    val file = resolve(path)
    if (!file.exists()) return null
    return describe(file)
  }

  private fun describe(file: File): Map<String, Any> = mapOf(
    "name" to file.name,
    "isDirectory" to file.isDirectory,
    "size" to (if (file.isFile) file.length() else 0L).toDouble(),
    "mtimeMs" to file.lastModified().toDouble()
  )

  fun list(path: String): List<Map<String, Any>> {
    val dir = resolve(path)
    return dir.listFiles()?.sortedBy { it.name }?.map { describe(it) } ?: emptyList()
  }

  fun delete(path: String): Boolean {
    val file = resolve(path)
    if (!file.exists()) return false
    return file.deleteRecursively()
  }

  fun move(from: String, to: String): Boolean {
    val target = resolve(to)
    target.parentFile?.mkdirs()
    return resolve(from).renameTo(target)
  }

  /** Total bytes of the files under `path` (0 when missing). */
  fun treeSize(path: String): Long {
    val file = resolve(path)
    if (!file.exists()) return 0L
    return file.walkTopDown().filter { it.isFile }.sumOf { it.length() }
  }

  /** Bytes free for the app on the volume holding the root. */
  fun freeBytes(): Long = StatFs(root().path).availableBytes

  /**
   * Zips the folder at `path` (its files under the folder's own name) into
   * `<cacheDir>/export/<zipName>` and returns the zip's absolute path.
   * Files ending in `skipSuffix` (the raw capture) are left out when given.
   */
  fun zipDir(context: Context, path: String, zipName: String, skipSuffix: String): String {
    val dir = resolve(path)
    if (!dir.isDirectory) throw IOException("not_a_directory: $path")
    if (zipName.contains('/') || zipName.contains("..")) throw IOException("invalid_zip_name")
    val exportDir = File(context.cacheDir, "export")
    exportDir.mkdirs()
    // Earlier exports are only needed while the share sheet reads them.
    exportDir.listFiles()?.forEach { if (System.currentTimeMillis() - it.lastModified() > 3_600_000L) it.delete() }
    val zip = File(exportDir, zipName)
    val base = dir.parentFile ?: dir
    ZipOutputStream(BufferedOutputStream(FileOutputStream(zip), BUFFER_BYTES)).use { out ->
      for (file in dir.walkTopDown().filter { it.isFile }) {
        if (skipSuffix.isNotEmpty() && file.name.endsWith(skipSuffix)) continue
        if (file.name.endsWith(".tmp")) continue
        out.putNextEntry(ZipEntry(file.relativeTo(base).invariantSeparatorsPath))
        FileInputStream(file).use { input -> input.copyTo(out, BUFFER_BYTES) }
        out.closeEntry()
      }
    }
    return zip.absolutePath
  }
}
