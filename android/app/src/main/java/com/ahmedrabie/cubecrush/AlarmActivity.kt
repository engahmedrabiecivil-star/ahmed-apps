package com.ahmedrabie.cubecrush

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Red full-screen alarm shown over the lock screen. */
class AlarmActivity : Activity() {
    companion object { const val CLOSE = "com.ahmedrabie.cubecrush.CLOSE_ALARM" }

    private val closer = object : BroadcastReceiver() {
        override fun onReceive(c: Context?, i: Intent?) { finish() }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true) }
        @Suppress("DEPRECATION")
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or
            WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
        render(intent)
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(closer, IntentFilter(CLOSE), RECEIVER_NOT_EXPORTED)
        else registerReceiver(closer, IntentFilter(CLOSE))
    }

    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); render(intent) }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun render(i: Intent) {
        val title = i.getStringExtra("title") ?: "Crush cubes now"
        val body = i.getStringExtra("body") ?: ""
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#C62828"))
            setPadding(dp(22), dp(40), dp(22), dp(28))
        }
        fun text(s: String, size: Float, bold: Boolean = false, alpha: Float = 1f) = TextView(this).apply {
            text = s; textSize = size; setTextColor(Color.WHITE); this.alpha = alpha
            if (bold) typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
        }
        root.addView(text(title.uppercase(Locale.ROOT), 30f, true))
        root.addView(text(SimpleDateFormat("EEE d MMM · HH:mm", Locale.ENGLISH).format(Date()), 16f, alpha = 0.85f))
        val box = TextView(this).apply {
            text = body; textSize = 20f; setTextColor(Color.WHITE)
            typeface = Typeface.MONOSPACE; setLineSpacing(0f, 1.3f)
            setBackgroundColor(Color.parseColor("#40000000")); setPadding(dp(16), dp(14), dp(16), dp(14))
        }
        val scroll = ScrollView(this).apply { addView(box) }
        root.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f).apply { topMargin = dp(18); bottomMargin = dp(18) })
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
        fun btn(label: String, bg: String, fg: String, action: String) = Button(this).apply {
            text = label; textSize = 18f; setTextColor(Color.parseColor(fg)); setBackgroundColor(Color.parseColor(bg))
            setOnClickListener {
                startService(Intent(this@AlarmActivity, AlarmService::class.java).setAction(action))
                finish()
            }
        }
        val mins = AlarmStore.prefs(this).getInt("snooze", 10)
        row.addView(btn("Snooze $mins min", "#55000000", "#FFFFFF", AlarmService.ACTION_SNOOZE),
            LinearLayout.LayoutParams(0, dp(64), 1f).apply { marginEnd = dp(10) })
        row.addView(btn("Dismiss", "#FFFFFF", "#8A1414", AlarmService.ACTION_STOP),
            LinearLayout.LayoutParams(0, dp(64), 1f))
        root.addView(row)
        setContentView(root)
    }

    override fun onDestroy() { try { unregisterReceiver(closer) } catch (_: Exception) {}; super.onDestroy() }
}
