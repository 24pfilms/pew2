package expo.modules.pewlink

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import com.facebook.react.modules.network.CustomClientBuilder
import com.facebook.react.modules.websocket.WebSocketModule
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.TimeUnit

/**
 * pew2's Android side of staying connected: the background service, the native
 * WebSocket ping, ringing alerts, and the phone-setup checklist.
 */
class PewLinkModule : Module() {
  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw IllegalStateException("React context lost")

  /** Set when the app was opened by answering a ringing alert; taken once by JavaScript. */
  @Volatile private var answered: String? = null

  override fun definition() =
    ModuleDefinition {
      Name("PewLink")
      Events(PewLinkService.EVENT_TICK, PewLinkService.EVENT_STOPPED)

      OnCreate {
        // Every WebSocket the app opens pings on OkHttp's own threads, which run
        // whether or not React Native has paused JavaScript timers, and a socket
        // whose pong does not come back is failed — reaching JavaScript as an
        // ordinary close. The relay answers pings without waking.
        WebSocketModule.setCustomClientBuilder(
          CustomClientBuilder { builder -> builder.pingInterval(PING_SECONDS, TimeUnit.SECONDS) },
        )
        PewLinkService.listener = { event -> sendEvent(event, emptyMap<String, Any?>()) }
      }

      OnDestroy {
        PewLinkService.listener = null
      }

      // Opened by answering a ring while pew2 was already running.
      OnNewIntent { intent -> collectAnswer(intent) }

      Function("start") { title: String, text: String -> PewLinkService.start(context, title, text) }
      Function("stop") { PewLinkService.stop(context) }
      Function("isRunning") { PewLinkService.running }

      Function("ring") { id: String, title: String, text: String, sessionId: String ->
        PewLinkRinger.ring(context, id, title, text, sessionId)
      }
      Function("cancelRing") { id: String -> PewLinkRinger.cancel(context, id) }
      Function("cancelAllRings") { PewLinkRinger.cancelAll(context) }
      Function("canRingFullScreen") { PewLinkRinger.canUseFullScreen(context) }

      /** The conversation a ring was answered for, once. Also covers a cold start. */
      Function("takeAnswered") {
        appContext.currentActivity?.intent?.let { collectAnswer(it) }
        answered.also { answered = null }
      }

      Function("batteryUnrestricted") {
        context.getSystemService(PowerManager::class.java)?.isIgnoringBatteryOptimizations(context.packageName) ?: false
      }
      Function("requestBatteryUnrestricted") {
        open(
          Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}")),
        )
      }
      Function("openAppSettings") {
        open(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")))
      }
      Function("openFullScreenSettings") {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
          open(Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:${context.packageName}")))
        } else {
          false
        }
      }
      /**
       * ColorOS's "Auto launch" list, which has no public intent. Tried by known
       * component names; falls back to the app's settings page.
       */
      Function("openAutoStart") {
        val pm = context.packageManager
        val found =
          AUTO_START.map { (pkg, cls) -> Intent().setComponent(ComponentName(pkg, cls)) }
            .firstOrNull { it.resolveActivity(pm) != null }
        if (found != null && open(found)) {
          true
        } else {
          open(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")))
          false
        }
      }
    }

  private fun collectAnswer(intent: Intent) {
    val session = intent.getStringExtra(PewLinkRinger.EXTRA_SESSION) ?: return
    intent.getStringExtra(PewLinkRinger.EXTRA_RING_ID)?.let { PewLinkRinger.cancel(context, it) }
    // Read once: the activity keeps its launch intent, and a later
    // `takeAnswered` must not reopen the same conversation again.
    intent.removeExtra(PewLinkRinger.EXTRA_SESSION)
    intent.removeExtra(PewLinkRinger.EXTRA_RING_ID)
    answered = session
  }

  private fun open(intent: Intent): Boolean {
    val activity = appContext.currentActivity
    return try {
      if (activity != null) {
        activity.startActivity(intent)
      } else {
        context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      }
      true
    } catch (error: Exception) {
      Log.w("PewLink", "could not open settings", error)
      false
    }
  }

  companion object {
    /** Matches the relay's heartbeat cadence, under carrier NAT idle timeouts. */
    private const val PING_SECONDS = 25L

    private val AUTO_START =
      listOf(
        "com.coloros.safecenter" to "com.coloros.safecenter.startupapp.StartupAppListActivity",
        "com.coloros.safecenter" to "com.coloros.safecenter.permission.startup.StartupAppListActivity",
        "com.oppo.safe" to "com.oppo.safe.permission.startup.StartupAppListActivity",
        "com.coloros.oppoguardelf" to "com.coloros.powermanager.fuelgaue.PowerUsageModelActivity",
      )
  }
}
