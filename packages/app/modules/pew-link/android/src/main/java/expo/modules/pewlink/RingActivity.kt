package expo.modules.pewlink

import android.app.Activity
import android.app.KeyguardManager
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/**
 * The incoming-call screen for a ringing alert, shown over the lock screen.
 *
 * The ring's full-screen intent points here rather than at pew2 itself: on a
 * locked phone Android opens that screen at once, and opening pew2 counted as
 * "the app is in front", which stopped the ring half a second after it began.
 * This screen is separate from the app, so nothing in pew2 changes until the
 * user chooses Open. The ringtone is the notification's; both buttons end it.
 */
class RingActivity : Activity() {
  private val handler = Handler(Looper.getMainLooper())
  private var ringId: String? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(true)
      setTurnScreenOn(true)
    } else {
      @Suppress("DEPRECATION")
      window.addFlags(
        WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON,
      )
    }
    show(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    show(intent)
  }

  override fun onDestroy() {
    handler.removeCallbacksAndMessages(null)
    super.onDestroy()
  }

  private fun show(intent: Intent) {
    ringId = intent.getStringExtra(PewLinkRinger.EXTRA_RING_ID)
    val title = intent.getStringExtra(EXTRA_TITLE) ?: "pew2"
    val text = intent.getStringExtra(EXTRA_TEXT) ?: ""
    val session = intent.getStringExtra(PewLinkRinger.EXTRA_SESSION)

    val root =
      LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER
        setBackgroundColor(Color.parseColor("#111111"))
        setPadding(dp(32), dp(48), dp(32), dp(48))
      }
    root.addView(label("Incoming from your agents", 15f, "#9A9AA0"))
    root.addView(spacer(12))
    root.addView(label(title, 30f, "#F2F2F3", bold = true))
    root.addView(spacer(16))
    root.addView(label(text, 18f, "#C8C8CC").apply { maxLines = 6 })
    root.addView(spacer(64))

    val buttons = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
    buttons.addView(
      button("Dismiss", "#F85149") {
        ringId?.let { PewLinkRinger.cancel(this, it) }
        finish()
      },
    )
    buttons.addView(spacer(0).apply { layoutParams = LinearLayout.LayoutParams(dp(32), 1) })
    buttons.addView(
      button("Open", "#3FB950") {
        open(session)
      },
    )
    root.addView(buttons)
    setContentView(root)

    // The ring stops on its own after a while; so does this screen.
    handler.removeCallbacksAndMessages(null)
    handler.postDelayed({ finish() }, SCREEN_MS)
  }

  /** Unlock if needed, then open pew2 on the conversation; pew2 ends the ring. */
  private fun open(session: String?) {
    val launch =
      packageManager.getLaunchIntentForPackage(packageName)?.apply {
        addFlags(
          Intent.FLAG_ACTIVITY_NEW_TASK or
            Intent.FLAG_ACTIVITY_SINGLE_TOP or
            Intent.FLAG_ACTIVITY_REORDER_TO_FRONT,
        )
        ringId?.let { putExtra(PewLinkRinger.EXTRA_RING_ID, it) }
        session?.let { putExtra(PewLinkRinger.EXTRA_SESSION, it) }
      } ?: return finish()
    val keyguard = getSystemService(KeyguardManager::class.java)
    if (keyguard != null && keyguard.isKeyguardLocked && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      keyguard.requestDismissKeyguard(
        this,
        object : KeyguardManager.KeyguardDismissCallback() {
          override fun onDismissSucceeded() {
            startActivity(launch)
            finish()
          }
        },
      )
    } else {
      startActivity(launch)
      finish()
    }
  }

  private fun label(text: String, size: Float, color: String, bold: Boolean = false) =
    TextView(this).apply {
      this.text = text
      setTextSize(TypedValue.COMPLEX_UNIT_SP, size)
      setTextColor(Color.parseColor(color))
      gravity = Gravity.CENTER
      if (bold) setTypeface(typeface, Typeface.BOLD)
    }

  private fun button(text: String, color: String, onClick: () -> Unit) =
    Button(this).apply {
      this.text = text
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
      setTextColor(Color.WHITE)
      isAllCaps = false
      background =
        GradientDrawable().apply {
          setColor(Color.parseColor(color))
          cornerRadius = dp(32).toFloat()
        }
      layoutParams = LinearLayout.LayoutParams(dp(130), dp(64))
      setOnClickListener { onClick() }
    }

  private fun spacer(heightDp: Int) =
    TextView(this).apply { layoutParams = LinearLayout.LayoutParams(1, dp(heightDp)) }

  private fun dp(value: Int): Int =
    TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics).toInt()

  companion object {
    const val EXTRA_TITLE = "pew2.ring.title"
    const val EXTRA_TEXT = "pew2.ring.text"
    /** Matches the ring's own timeout. */
    private const val SCREEN_MS = 30_000L
  }
}
