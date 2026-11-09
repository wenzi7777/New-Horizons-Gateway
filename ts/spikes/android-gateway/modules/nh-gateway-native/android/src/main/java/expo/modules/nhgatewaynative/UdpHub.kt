package expo.modules.nhgatewaynative

import android.os.SystemClock
import android.util.Log
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

// The Gateway's UDP sockets. Owned by GatewayService (so they live as long
// as the foreground service, not as long as the JS screen) and reported to
// whichever module instance is listening.
//
// TIME_REQ is answered right here on the receive thread: t2 is taken the
// moment receive() returns and t3 just before send(), the same rule as the
// Python Gateway's time_service.py -- a hop through JS would add its
// scheduling delay to the turnaround the device has to subtract.
object UdpHub {
  interface Listener {
    fun onDatagram(localPort: Int, ip: String, srcPort: Int, data: ByteArray, rxEpochUs: Long)
    fun onTimeServed(seq: Int, turnaroundUs: Long)
  }

  private const val TAG = "NhUdpHub"
  const val STREAM_PORT = 13250
  const val DISCOVERY_PORT = 22346

  private const val TIME_REQ_MAGIC = 0xE8
  private const val TIME_RESP_MAGIC = 0xE9
  private const val TIME_WIRE_VERSION = 1
  private const val TIME_REQ_LEN = 12
  private const val TIME_RESP_LEN = 32
  private const val TIME_FLAG_SYNCED = 0x01
  private const val SERVER_SOURCE_SNTP = 1
  private const val MIN_VALID_EPOCH_US = 1_600_000_000L * 1_000_000L

  @Volatile var listener: Listener? = null
  @Volatile var running = false
    private set

  private val sockets = ConcurrentHashMap<Int, DatagramSocket>()
  private val sendExecutor = Executors.newSingleThreadExecutor()

  val datagramsIn = AtomicLong()
  val datagramsOut = AtomicLong()
  val timeRequests = AtomicLong()
  val sendErrors = AtomicLong()
  @Volatile var lastError: String = ""

  // Wall clock in microseconds. System.currentTimeMillis() has only ms
  // resolution, so anchor it to the monotonic nanosecond clock and re-anchor
  // once a minute to follow NTP corrections.
  private var anchorEpochUs = 0L
  private var anchorNanos = 0L

  @Synchronized
  fun nowEpochUs(): Long {
    val nanos = SystemClock.elapsedRealtimeNanos()
    if (anchorNanos == 0L || nanos - anchorNanos > 60_000_000_000L) {
      anchorEpochUs = System.currentTimeMillis() * 1000L
      anchorNanos = nanos
    }
    return anchorEpochUs + (nanos - anchorNanos) / 1000L
  }

  @Synchronized
  fun start(ports: List<Int>) {
    if (running) return
    running = true
    for (port in ports) {
      try {
        val socket = DatagramSocket(null).apply {
          reuseAddress = true
          // FindMe offers go back unicast, but a probe is a broadcast; the
          // Python Gateway never set this, so its probe never left the host.
          broadcast = true
          bind(InetSocketAddress(port))
        }
        sockets[port] = socket
        Thread({ receiveLoop(port, socket) }, "nh-udp-$port").apply { isDaemon = true; start() }
      } catch (e: Exception) {
        lastError = "bind $port: ${e.message}"
        Log.e(TAG, lastError)
      }
    }
  }

  @Synchronized
  fun stop() {
    running = false
    for (socket in sockets.values) socket.close()
    sockets.clear()
  }

  fun send(localPort: Int, ip: String, dstPort: Int, data: ByteArray) {
    val socket = sockets[localPort] ?: run { sendErrors.incrementAndGet(); return }
    sendExecutor.execute {
      try {
        socket.send(DatagramPacket(data, data.size, InetAddress.getByName(ip), dstPort))
        datagramsOut.incrementAndGet()
      } catch (e: Exception) {
        sendErrors.incrementAndGet()
        lastError = "send $ip:$dstPort: ${e.message}"
      }
    }
  }

  private fun receiveLoop(port: Int, socket: DatagramSocket) {
    val buffer = ByteArray(8192)
    while (running && !socket.isClosed) {
      val packet = DatagramPacket(buffer, buffer.size)
      try {
        socket.receive(packet)
      } catch (e: Exception) {
        if (running) lastError = "receive $port: ${e.message}"
        break
      }
      val rxEpochUs = nowEpochUs()
      datagramsIn.incrementAndGet()
      val data = packet.data.copyOfRange(packet.offset, packet.offset + packet.length)
      val ip = packet.address?.hostAddress ?: continue
      if (port == STREAM_PORT && isTimeRequest(data)) {
        answerTime(socket, packet, data, rxEpochUs)
        continue
      }
      listener?.onDatagram(port, ip, packet.port, data, rxEpochUs)
    }
  }

  private fun isTimeRequest(data: ByteArray): Boolean =
    data.size == TIME_REQ_LEN &&
      (data[0].toInt() and 0xFF) == TIME_REQ_MAGIC &&
      (data[1].toInt() and 0xFF) == TIME_WIRE_VERSION

  // <BBBBq request, <BBBBqqqHH response: magic, version, seq, flags, t1, t2,
  // t3, uncertainty_ms, reserved -- NewHorizonsOS-OTA spec/wire.json.
  private fun answerTime(socket: DatagramSocket, packet: DatagramPacket, request: ByteArray, t2: Long) {
    timeRequests.incrementAndGet()
    val req = ByteBuffer.wrap(request).order(ByteOrder.LITTLE_ENDIAN)
    val seq = request[2].toInt() and 0xFF
    val t1 = req.getLong(4)
    val synced = t2 >= MIN_VALID_EPOCH_US
    val flags = (if (synced) TIME_FLAG_SYNCED else 0) or (SERVER_SOURCE_SNTP shl 4)
    val out = ByteBuffer.allocate(TIME_RESP_LEN).order(ByteOrder.LITTLE_ENDIAN)
    out.put(TIME_RESP_MAGIC.toByte())
    out.put(TIME_WIRE_VERSION.toByte())
    out.put(seq.toByte())
    out.put(flags.toByte())
    out.putLong(t1)
    out.putLong(if (synced) t2 else 0L)
    val t3 = nowEpochUs()
    out.putLong(if (synced) t3 else 0L)
    out.putShort(0)
    out.putShort(0)
    try {
      socket.send(DatagramPacket(out.array(), TIME_RESP_LEN, packet.address, packet.port))
      datagramsOut.incrementAndGet()
    } catch (e: Exception) {
      sendErrors.incrementAndGet()
      lastError = "time reply: ${e.message}"
    }
    listener?.onTimeServed(seq, t3 - t2)
  }
}
