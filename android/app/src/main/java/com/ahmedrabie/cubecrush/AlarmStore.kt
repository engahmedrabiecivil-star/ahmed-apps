package com.ahmedrabie.cubecrush

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import org.json.JSONArray

/** Keeps the schedule sent from the web page and turns it into system alarms. */
object AlarmStore {
    const val SNOOZE_ID = 999001
    const val TEST_ID = 999002

    fun prefs(c: Context) = c.getSharedPreferences("cca", Context.MODE_PRIVATE)

    fun saveSchedule(c: Context, json: String) = prefs(c).edit().putString("schedule", json).apply()

    /** Cancels every alarm set last time, then sets the ones in the saved schedule that are still in the future. */
    fun scheduleAll(c: Context) {
        val p = prefs(c)
        val old = p.getString("ids", "") ?: ""
        old.split(",").filter { it.isNotBlank() }.forEach { cancel(c, it.toInt()) }
        val arr = try { JSONArray(p.getString("schedule", "[]")) } catch (e: Exception) { JSONArray() }
        val now = System.currentTimeMillis()
        val ids = mutableListOf<Int>()
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            val at = o.getLong("at")
            if (at <= now) continue
            val id = o.getInt("id")
            schedule(c, id, at, o.optString("title"), o.optString("body"))
            ids.add(id)
        }
        p.edit().putString("ids", ids.joinToString(",")).apply()
    }

    fun schedule(c: Context, id: Int, at: Long, title: String, body: String) {
        val am = c.getSystemService(AlarmManager::class.java)
        val i = Intent(c, AlarmReceiver::class.java)
            .putExtra("title", title).putExtra("body", body)
        val pi = PendingIntent.getBroadcast(c, id, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val canExact = Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()
        if (canExact) {
            val show = PendingIntent.getActivity(c, 0, Intent(c, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
            am.setAlarmClock(AlarmManager.AlarmClockInfo(at, show), pi)
        } else {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
        }
    }

    fun cancel(c: Context, id: Int) {
        val am = c.getSystemService(AlarmManager::class.java)
        val pi = PendingIntent.getBroadcast(c, id, Intent(c, AlarmReceiver::class.java),
            PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE)
        if (pi != null) { am.cancel(pi); pi.cancel() }
    }
}
