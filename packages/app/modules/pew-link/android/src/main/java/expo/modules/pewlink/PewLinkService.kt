package expo.modules.pewlink

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Keeps pew2 running, and its connection to the computer open, with the screen
 * off or another app in front.
 *
 * Android only lets an app keep working in the background as a foreground
 * service with a visible notification. This one does no networking itself —
 * the WebSocket stays in JavaScript — it exists so the process is not frozen,
 * and to deliver a "tick" every [TICK_MS]: React Native pauses JavaScript timers
 * when the app leaves the screen, so without a native clock nothing would notice
 * a dropped connection or retry it until the app was opened again.
 *
 * Adapted from riazmohamed/pew2's VoiceCallService.
 */
class PewLinkService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private val tick =
    object : Runnable {
      override fun run() {
        listener?.invoke(EVENT_TICK)
        handler.postDelayed(this, TICK_MS)
      }
    }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      // "Disconnect" on the notification: the user asked for it to go away.
      listener?.invoke(EVENT_STOPPED)
      stopSelf()
      return START_NOT_STICKY
    }
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: "pew2"
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: "Connected"
    ensureChannel()

    try {
      ServiceCompat.startForeground(
        this,
        NOTIFICATION_ID,
        build(title, text),
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
        } else {
          0
        },
      )
    } catch (error: Exception) {
      // Refused — typically started from the background. Logged and stopped
      // rather than crashing: the app still works on screen, as it did before.
      Log.w(TAG, "foreground service refused", error)
      running = false
      stopSelf()
      return START_NOT_STICKY
    }

    running = true
    handler.removeCallbacks(tick)
    handler.postDelayed(tick, TICK_MS)
    // Not sticky: a service restarted by the system after the process died
    // would show "connected" with no app behind it to be connected.
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    handler.removeCallbacks(tick)
    running = false
    super.onDestroy()
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    // Swiping pew2 away from Recents closes it; the notification goes with it.
    stopSelf()
    super.onTaskRemoved(rootIntent)
  }

  private fun build(title: String, text: String): Notification {
    val open =
      packageManager.getLaunchIntentForPackage(packageName)?.let {
        it.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
        PendingIntent.getActivity(
          this,
          0,
          it,
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
      }
    val disconnect =
      PendingIntent.getService(
        this,
        1,
        Intent(this, PewLinkService::class.java).setAction(ACTION_STOP),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle(title)
      .setContentText(text)
      .setSmallIcon(applicationInfo.icon)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setContentIntent(open)
      .addAction(0, "Disconnect", disconnect)
      .build()
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(NotificationManager::class.java) ?: return
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "Connection", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Shown while pew2 stays connected to your computer in the background."
        setShowBadge(false)
      },
    )
  }

  companion object {
    private const val TAG = "PewLink"
    const val EVENT_TICK = "tick"
    const val EVENT_STOPPED = "stopped"
    private const val EXTRA_TITLE = "title"
    private const val EXTRA_TEXT = "text"
    private const val ACTION_STOP = "io.github.kenkaiii.pew2.LINK_STOP"
    private const val CHANNEL_ID = "pew2-link"
    private const val NOTIFICATION_ID = 7342

    /**
     * How often the app is nudged to check its connection.
     *
     * Thirty seconds: inside the window most carrier NATs keep an idle mapping,
     * and rare enough to cost nothing measurable while the radio is idle.
     */
    private const val TICK_MS = 30_000L

    @Volatile var running = false
      private set

    /** Set by the module while the app is alive; receives [EVENT_TICK] and [EVENT_STOPPED]. */
    @Volatile var listener: ((String) -> Unit)? = null

    /** Must be called while the app is on screen: Android refuses it from the background. */
    fun start(context: Context, title: String, text: String): Boolean =
      try {
        ContextCompat.startForegroundService(
          context,
          Intent(context, PewLinkService::class.java)
            .putExtra(EXTRA_TITLE, title)
            .putExtra(EXTRA_TEXT, text),
        )
        true
      } catch (error: Exception) {
        Log.w(TAG, "could not start the connection service", error)
        false
      }

    fun stop(context: Context) {
      context.stopService(Intent(context, PewLinkService::class.java))
    }
  }
}
