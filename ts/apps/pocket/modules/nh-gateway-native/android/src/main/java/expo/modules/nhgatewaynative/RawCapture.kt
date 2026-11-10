package expo.modules.nhgatewaynative

import java.io.BufferedOutputStream
import java.io.FileOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

// `.nhraw` capture (ts/packages/engine/src/recording/NHRAW.md): while JS
// records a device, every stream datagram carrying that device's UID is
// appended here on the UDP receive thread with its arrival time, so the data
// is on its way to disk even when the JS thread is throttled. JS adds its
// own records (knowledge / start / stop / app_events_request events, control
// replies) through append().
//
// Ordering: conversion replays records in file order with each record's time
// as the clock, so times in a file never go backwards. A record is stamped
// max(its time, the last stamp written): a JS event is stamped "now", and a
// datagram that was received just before but reached the lock just after it
// is stamped with the event's time (a few µs later) -- so an event is never
// stamped later than the stream record that follows it.
object RawCapture {
  const val SOURCE_STREAM = 0
  const val SOURCE_CONTROL = 1
  const val SOURCE_EVENT = 2

  private const val HEADER_LEN = 24
  private const val RECORD_FIXED = 9
  private const val PACKET_MAGIC_LO = 0x5A
  private const val PACKET_MAGIC_HI = 0xA5

  private class Writer(val uid: String, val path: String, val out: BufferedOutputStream, var lastUs: Long) {
    var records = 0L
    var bytes = HEADER_LEN.toLong()
    var error = ""
  }

  private val byHandle = ConcurrentHashMap<Int, Writer>()
  private val byUid = ConcurrentHashMap<String, Writer>()
  private val nextHandle = AtomicInteger(1)

  /** Whether any capture is armed (keeps the receive thread's check to one read). */
  @Volatile var active = false
    private set

  /**
   * Creates `path` (relative to NhFiles' root) with the header and an
   * optional first event (the knowledge before the first frame), both
   * stamped startEpochUs, then captures the UID's stream datagrams.
   * Throws when the UID is already being captured.
   */
  fun start(uid: String, path: String, startEpochUs: Long, firstEvent: ByteArray?): Int {
    val key = uid.uppercase()
    val uidBytes = hexToBytes(key)
    if (uidBytes.size != 6) throw IOException("device_uid must be 12 hex digits")
    if (byUid.containsKey(key)) throw IOException("capture_already_running")
    val file = NhFiles.resolve(path)
    file.parentFile?.mkdirs()
    val out = BufferedOutputStream(FileOutputStream(file, false), 64 * 1024)
    val header = ByteBuffer.allocate(HEADER_LEN).order(ByteOrder.LITTLE_ENDIAN)
    header.put(byteArrayOf(0x4E, 0x48, 0x52, 0x57)) // "NHRW"
    header.putShort(1) // version
    header.putShort(HEADER_LEN.toShort())
    header.put(uidBytes)
    header.putShort(0) // reserved
    header.putLong(startEpochUs)
    out.write(header.array())
    val writer = Writer(key, path, out, startEpochUs)
    if (firstEvent != null) writeRecord(writer, startEpochUs, SOURCE_EVENT, firstEvent, 0, firstEvent.size)
    out.flush()
    val handle = nextHandle.getAndIncrement()
    byHandle[handle] = writer
    byUid[key] = writer
    active = true
    return handle
  }

  /** A record from JS, stamped now (never earlier than the last one). Returns the stamp. */
  fun append(handle: Int, source: Int, payload: ByteArray): Long {
    val writer = byHandle[handle] ?: throw IOException("capture_closed")
    synchronized(writer) {
      val stamp = maxOf(UdpHub.nowEpochUs(), writer.lastUs)
      writeRecord(writer, stamp, source, payload, 0, payload.size)
      return stamp
    }
  }

  fun flush(handle: Int) {
    val writer = byHandle[handle] ?: return
    synchronized(writer) { tryFlush(writer) }
  }

  fun flushAll() {
    for (writer in byHandle.values) synchronized(writer) { tryFlush(writer) }
  }

  /** Stops capturing and closes the file. */
  fun stop(handle: Int) {
    val writer = byHandle.remove(handle) ?: return
    byUid.remove(writer.uid, writer)
    active = byHandle.isNotEmpty()
    synchronized(writer) {
      try {
        writer.out.close()
      } catch (e: IOException) {
        writer.error = e.message ?: "close failed"
      }
    }
  }

  fun stopAll() {
    for (handle in byHandle.keys.toList()) stop(handle)
  }

  fun stats(handle: Int): Map<String, Any>? {
    val writer = byHandle[handle] ?: return null
    synchronized(writer) {
      return mapOf(
        "uid" to writer.uid,
        "path" to writer.path,
        "records" to writer.records.toDouble(),
        "bytes" to writer.bytes.toDouble(),
        "lastEpochUs" to writer.lastUs.toDouble(),
        "error" to writer.error
      )
    }
  }

  /** From the receive thread: a stream-port datagram. Cheap when nothing is captured. */
  fun onStreamDatagram(data: ByteArray, offset: Int, length: Int, rxEpochUs: Long) {
    if (!active || length < 10) return
    if ((data[offset].toInt() and 0xFF) != PACKET_MAGIC_LO || (data[offset + 1].toInt() and 0xFF) != PACKET_MAGIC_HI) return
    val writer = byUid[uidHex(data, offset + 4)] ?: return
    synchronized(writer) {
      writeRecord(writer, maxOf(rxEpochUs, writer.lastUs), SOURCE_STREAM, data, offset, length)
    }
  }

  private fun writeRecord(writer: Writer, stamp: Long, source: Int, payload: ByteArray, offset: Int, length: Int) {
    if (writer.error.isNotEmpty()) return
    val head = ByteBuffer.allocate(4 + RECORD_FIXED).order(ByteOrder.LITTLE_ENDIAN)
    head.putInt(RECORD_FIXED + length)
    head.putLong(stamp)
    head.put(source.toByte())
    try {
      writer.out.write(head.array())
      writer.out.write(payload, offset, length)
      writer.lastUs = stamp
      writer.records += 1
      writer.bytes += 4L + RECORD_FIXED + length
    } catch (e: IOException) {
      // Disk full or the like: the capture stops growing; JS sees it in stats().
      writer.error = e.message ?: "write failed"
    }
  }

  private fun tryFlush(writer: Writer) {
    try {
      writer.out.flush()
    } catch (e: IOException) {
      writer.error = e.message ?: "flush failed"
    }
  }

  private val HEX = "0123456789ABCDEF".toCharArray()

  private fun uidHex(data: ByteArray, offset: Int): String {
    val chars = CharArray(12)
    for (i in 0 until 6) {
      val b = data[offset + i].toInt() and 0xFF
      chars[i * 2] = HEX[b ushr 4]
      chars[i * 2 + 1] = HEX[b and 0x0F]
    }
    return String(chars)
  }

  private fun hexToBytes(hex: String): ByteArray {
    if (hex.length % 2 != 0) return ByteArray(0)
    val out = ByteArray(hex.length / 2)
    for (i in out.indices) {
      val hi = Character.digit(hex[i * 2], 16)
      val lo = Character.digit(hex[i * 2 + 1], 16)
      if (hi < 0 || lo < 0) return ByteArray(0)
      out[i] = ((hi shl 4) or lo).toByte()
    }
    return out
  }
}
