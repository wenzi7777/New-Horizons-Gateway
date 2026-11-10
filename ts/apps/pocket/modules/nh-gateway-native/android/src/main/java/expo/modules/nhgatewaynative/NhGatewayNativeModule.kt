package expo.modules.nhgatewaynative

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.Inet4Address
import java.net.NetworkInterface

class NhGatewayNativeModule : Module(), UdpHub.Listener {
  private val context: Context
    get() = requireNotNull(appContext.reactContext).applicationContext

  private fun files(): NhFiles {
    NhFiles.init(context)
    return NhFiles
  }

  override fun definition() = ModuleDefinition {
    Name("NhGatewayNative")

    Events("onDatagram", "onTimeServed")

    OnCreate {
      UdpHub.listener = this@NhGatewayNativeModule
      appContext.reactContext?.let { NhFiles.init(it.applicationContext) }
    }
    OnDestroy {
      if (UdpHub.listener === this@NhGatewayNativeModule) UdpHub.listener = null
      // The JS that held these handles is gone (reload or teardown): close
      // them so nothing keeps writing to a file no one will finish. A capture
      // left this way is converted by the next start's recovery.
      RawCapture.stopAll()
      NhFiles.closeAll()
    }

    Function("startService") {
      val intent = Intent(context, GatewayService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
      true
    }

    Function("stopService") {
      context.stopService(Intent(context, GatewayService::class.java))
      true
    }

    Function("isRunning") { UdpHub.running }

    Function("send") { localPort: Int, ip: String, dstPort: Int, base64: String ->
      UdpHub.send(localPort, ip, dstPort, Base64.decode(base64, Base64.NO_WRAP))
    }

    // Doubles: JS numbers hold integers exactly up to 2^53, which covers
    // epoch microseconds for the next few hundred years.
    Function("nowEpochUs") { UdpHub.nowEpochUs().toDouble() }

    Function("stats") {
      mapOf(
        "running" to UdpHub.running,
        "datagramsIn" to UdpHub.datagramsIn.get().toDouble(),
        "datagramsOut" to UdpHub.datagramsOut.get().toDouble(),
        "timeRequests" to UdpHub.timeRequests.get().toDouble(),
        "sendErrors" to UdpHub.sendErrors.get().toDouble(),
        "lastError" to UdpHub.lastError
      )
    }

    // Every up IPv4 interface. The hotspot shows up as ap0 / swlan0 /
    // wlan1 depending on the vendor; the UI just lists them all.
    Function("networkInterfaces") {
      val result = mutableListOf<Map<String, String>>()
      for (nif in NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()) {
        if (!nif.isUp || nif.isLoopback) continue
        for (address in nif.inetAddresses.toList()) {
          if (address is Inet4Address) {
            result.add(mapOf("name" to nif.name, "address" to (address.hostAddress ?: "")))
          }
        }
      }
      result
    }

    // -- files (paths relative to the app's external files dir) --------------

    Function("filesRoot") { files().root().absolutePath }
    Function("fileExists") { path: String -> files().exists(path) }
    Function("mkdirp") { path: String -> files().mkdirp(path) }
    Function("fileSize") { path: String -> files().size(path).toDouble() }
    Function("fileOpen") { path: String -> files().open(path) }
    Function("fileAppend") { handle: Int, text: String -> files().append(handle, text) }
    Function("fileFlush") { handle: Int -> files().flush(handle) }
    Function("fileClose") { handle: Int -> files().close(handle) }
    Function("writeAtomic") { path: String, text: String -> files().writeAtomic(path, text) }
    Function("readText") { path: String -> files().readText(path) }
    Function("readBytes") { path: String, offset: Double, length: Int -> files().readBytes(path, offset.toLong(), length) }
    Function("stat") { path: String -> files().stat(path) }
    Function("listDir") { path: String -> files().list(path) }
    Function("deletePath") { path: String -> files().delete(path) }
    Function("movePath") { from: String, to: String -> files().move(from, to) }
    Function("treeSize") { path: String -> files().treeSize(path).toDouble() }
    Function("freeBytes") { files().freeBytes().toDouble() }

    // Off the JS thread: an hour of recording is a few hundred MB.
    AsyncFunction("zipDir") { path: String, zipName: String, skipSuffix: String ->
      files().zipDir(context, path, zipName, skipSuffix)
    }

    // -- .nhraw capture ----------------------------------------------------------

    Function("rawStart") { uid: String, path: String, startEpochUs: Double, firstEvent: ByteArray? ->
      files()
      RawCapture.start(uid, path, startEpochUs.toLong(), firstEvent)
    }
    Function("rawAppend") { handle: Int, source: Int, payload: ByteArray ->
      RawCapture.append(handle, source, payload).toDouble()
    }
    Function("rawFlush") { handle: Int -> RawCapture.flush(handle) }
    Function("rawFlushAll") { RawCapture.flushAll() }
    Function("rawStop") { handle: Int -> RawCapture.stop(handle) }
    Function("rawStats") { handle: Int -> RawCapture.stats(handle) }

    Function("isIgnoringBatteryOptimizations") {
      val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
      power.isIgnoringBatteryOptimizations(context.packageName)
    }

    Function("requestIgnoreBatteryOptimizations") {
      @SuppressLint("BatteryLife")
      val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
        data = Uri.parse("package:${context.packageName}")
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      context.startActivity(intent)
      true
    }
  }

  override fun onDatagram(localPort: Int, ip: String, srcPort: Int, data: ByteArray, rxEpochUs: Long) {
    sendEvent(
      "onDatagram",
      mapOf(
        "localPort" to localPort,
        "ip" to ip,
        "srcPort" to srcPort,
        "data" to Base64.encodeToString(data, Base64.NO_WRAP),
        "rxEpochUs" to rxEpochUs.toDouble()
      )
    )
  }

  override fun onTimeServed(seq: Int, turnaroundUs: Long) {
    sendEvent("onTimeServed", mapOf("seq" to seq, "turnaroundUs" to turnaroundUs.toDouble()))
  }
}
