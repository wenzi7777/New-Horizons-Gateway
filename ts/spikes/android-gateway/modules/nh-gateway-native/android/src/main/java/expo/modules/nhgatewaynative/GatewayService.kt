package expo.modules.nhgatewaynative

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

// Foreground service that keeps the Gateway alive with the screen off: it
// owns the UDP sockets (UdpHub), a partial wake lock (CPU stays up for UDP
// and the WebSocket) and a Wi-Fi multicast lock (broadcast FindMe frames are
// otherwise filtered while the screen is off).
class GatewayService : Service() {
  companion object {
    private const val CHANNEL_ID = "nh_gateway"
    private const val NOTIFICATION_ID = 22346
  }

  private var wakeLock: PowerManager.WakeLock? = null
  private var multicastLock: WifiManager.MulticastLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    val notification = buildNotification()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    val power = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "NhGateway::service").apply {
      setReferenceCounted(false)
      acquire()
    }
    val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    multicastLock = wifi.createMulticastLock("NhGateway::findme").apply {
      setReferenceCounted(false)
      acquire()
    }
    UdpHub.start(listOf(UdpHub.STREAM_PORT, UdpHub.DISCOVERY_PORT))
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

  override fun onDestroy() {
    UdpHub.stop()
    multicastLock?.release()
    wakeLock?.release()
    super.onDestroy()
  }

  private fun buildNotification(): Notification {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "NH Gateway", NotificationManager.IMPORTANCE_LOW)
      )
    }
    val launch = packageManager.getLaunchIntentForPackage(packageName)
    val content = launch?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }
    return builder
      .setContentTitle("NH Gateway")
      .setContentText("Relaying devices on UDP 13250 / 22346")
      .setSmallIcon(android.R.drawable.stat_sys_upload_done)
      .setOngoing(true)
      .setContentIntent(content)
      .build()
  }
}
