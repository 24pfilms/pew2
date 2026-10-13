package expo.modules.pewlink

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** "Dismiss" on a ringing alert: stop the ring, open nothing. */
class RingDeclineReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val id = intent.getStringExtra(PewLinkRinger.EXTRA_RING_ID) ?: return
    PewLinkRinger.cancel(context, id)
  }
}
