package com.ahmedrabie.cubecrush

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlarmManager
import android.app.NotificationManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject
import java.io.File

class MainActivity : Activity() {
    private lateinit var web: WebView
    private var fileCb: ValueCallback<Array<Uri>>? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        setContentView(web)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.allowFileAccess = true
        web.settings.mediaPlaybackRequiresUserGesture = false
        web.addJavascriptInterface(Bridge(), "Android")
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                val u = req.url
                if (u.scheme == "http" || u.scheme == "https") {
                    startActivity(Intent(Intent.ACTION_VIEW, u)); return true
                }
                return false
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(v: WebView, cb: ValueCallback<Array<Uri>>, p: FileChooserParams): Boolean {
                fileCb?.onReceiveValue(null)
                fileCb = cb
                val i = Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
                return try { startActivityForResult(Intent.createChooser(i, "Choose a file"), 7); true }
                       catch (e: Exception) { fileCb = null; false }
            }
        }
        web.loadUrl("file:///android_asset/www/index.html")
        if (Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 7) {
            val u = data?.data
            fileCb?.onReceiveValue(if (resultCode == RESULT_OK && u != null) arrayOf(u) else null)
            fileCb = null
        }
    }

    override fun onResume() {
        super.onResume()
        if (::web.isInitialized) web.evaluateJavascript("window.onNativeResume&&window.onNativeResume()", null)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() { if (web.canGoBack()) web.goBack() else super.onBackPressed() }

    inner class Bridge {
        private val ctx get() = this@MainActivity

        @JavascriptInterface fun schedule(json: String) {
            AlarmStore.saveSchedule(ctx, json); AlarmStore.scheduleAll(ctx)
        }

        @JavascriptInterface fun setPrefs(json: String) {
            val o = JSONObject(json)
            AlarmStore.prefs(ctx).edit()
                .putInt("ring", o.optInt("ring", 60))
                .putFloat("vol", o.optDouble("vol", 0.9).toFloat())
                .putInt("snooze", o.optInt("snooze", 10)).apply()
        }

        @JavascriptInterface fun setSound(dataUrl: String) {
            val f = File(filesDir, "alarm_sound")
            if (dataUrl.isBlank()) { AlarmStore.prefs(ctx).edit().putBoolean("custom", false).apply(); return }
            try {
                f.writeBytes(Base64.decode(dataUrl.substringAfter(","), Base64.DEFAULT))
                AlarmStore.prefs(ctx).edit().putBoolean("custom", true).apply()
            } catch (e: Exception) { AlarmStore.prefs(ctx).edit().putBoolean("custom", false).apply() }
        }

        @JavascriptInterface fun testAlarm(title: String, body: String) {
            AlarmStore.schedule(ctx, AlarmStore.TEST_ID, System.currentTimeMillis() + 10_000L, title, body)
        }

        @JavascriptInterface fun copy(text: String) {
            runOnUiThread {
                (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager)
                    .setPrimaryClip(ClipData.newPlainText("Cube crushing list", text))
            }
        }

        @JavascriptInterface fun permissions(): String {
            val am = getSystemService(AlarmManager::class.java)
            val nm = getSystemService(NotificationManager::class.java)
            val pm = getSystemService(PowerManager::class.java)
            return JSONObject()
                .put("notif", NotificationManagerCompat.from(ctx).areNotificationsEnabled())
                .put("exact", Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms())
                .put("full", Build.VERSION.SDK_INT < 34 || nm.canUseFullScreenIntent())
                .put("battery", pm.isIgnoringBatteryOptimizations(packageName))
                .toString()
        }

        @SuppressLint("BatteryLife")
        @JavascriptInterface fun fix(what: String) {
            val pkg = Uri.parse("package:$packageName")
            val i = when (what) {
                "notif" -> Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
                "exact" -> if (Build.VERSION.SDK_INT >= 31) Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, pkg) else null
                "full" -> if (Build.VERSION.SDK_INT >= 34) Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, pkg) else null
                "battery" -> Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, pkg)
                else -> null
            } ?: Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg)
            runOnUiThread { try { startActivity(i) } catch (e: Exception) {
                startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg)) } }
        }
    }
}
