package expo.modules.pewlink

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person

/**
 * Rings the phone like an incoming call: an agent finished, or needs approval.
 *
 * A call-style notification with a full-screen intent, on a channel whose sound
 * is the phone's ringtone and which repeats until answered, dismissed, or
 * [RING_MS] passes. Answering opens pew2 on that conversation; the session is
 * carried in the launch intent and collected by [PewLinkModule].
 */
object PewLinkRinger {
  private const val TAG = "PewLink"
  private const val CHANNEL_ID = "pew2-ring"
  private const val NOTIFICATION_ID = 7343
  /** Long enough to find the phone in a pocket, short enough not to ring on and on. */
  private const val RING_MS = 30_000L

  const val ACTION_DECLINE = "io.github.kenkaiii.pew2.RING_DECLINE"
  const val EXTRA_RING_ID = "pew2.ring.id"
  const val EXTRA_SESSION = "pew2.ring.session"

  private val ringing = mutableSetOf<String>()

  fun ring(context: Context, id: String, title: String, text: String, sessionId: String): Boolean {
    ensureChannel(context)
    val manager = NotificationManagerCompat.from(context)
    if (!manager.areNotificationsEnabled()) return false

    val launch =
      context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
        addFlags(
          Intent.FLAG_ACTIVITY_NEW_TASK or
            Intent.FLAG_ACTIVITY_SINGLE_TOP or
            Intent.FLAG_ACTIVITY_REORDER_TO_FRONT,
        )
        putExtra(EXTRA_RING_ID, id)
        putExtra(EXTRA_SESSION, sessionId)
      } ?: return false
    val requestCode = id.hashCode()
    val answer =
      PendingIntent.getActivity(
        context,
        requestCode,
        launch,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    val decline =
      PendingIntent.getBroadcast(
        context,
        requestCode,
        Intent(ACTION_DECLINE)
          .setClass(context, RingDeclineReceiver::class.java)
          .putExtra(EXTRA_RING_ID, id),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )

    val caller = Person.Builder().setName(title).setImportant(true).build()
    val notification =
      NotificationCompat.Builder(context, CHANNEL_ID)
        .setSmallIcon(context.applicationInfo.icon)
        .setContentTitle(title)
        .setContentText(text)
        .setCategory(NotificationCompat.CATEGORY_CALL)
        .setPriority(NotificationCompat.PRIORITY_MAX)
        .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        .setFullScreenIntent(answer, true)
        .setContentIntent(answer)
        .setAutoCancel(true)
        .setOngoing(true)
        .setTimeoutAfter(RING_MS)
        .addPerson(caller)
        .setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, decline, answer))
        .build()
    // Repeats the ringtone until the notification is answered or dismissed.
    notification.flags = notification.flags or Notification.FLAG_INSISTENT

    return try {
      manager.notify(id, NOTIFICATION_ID, notification)
      synchronized(ringing) { ringing.add(id) }
      true
    } catch (error: SecurityException) {
      // Notification permission refused: nothing can ring.
      Log.w(TAG, "notification permission refused", error)
      false
    }
  }

  fun cancel(context: Context, id: String) {
    NotificationManagerCompat.from(context).cancel(id, NOTIFICATION_ID)
    synchronized(ringing) { ringing.remove(id) }
  }

  fun cancelAll(context: Context) {
    val ids = synchronized(ringing) { ringing.toList().also { ringing.clear() } }
    val manager = NotificationManagerCompat.from(context)
    for (id in ids) manager.cancel(id, NOTIFICATION_ID)
  }

  /** Android 14+ can withhold the full-screen permission; without it the ring is a heads-up banner. */
  fun canUseFullScreen(context: Context): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return true
    return context.getSystemService(NotificationManager::class.java)?.canUseFullScreenIntent() ?: false
  }

  private fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "Calls from your agents", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "Rings when an agent finishes or needs your approval while pew2 is not on screen."
        setSound(
          RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build(),
        )
        enableVibration(true)
        vibrationPattern = longArrayOf(0, 800, 600, 800, 600)
        lockscreenVisibility = Notification.VISIBILITY_PUBLIC
      },
    )
  }
}
