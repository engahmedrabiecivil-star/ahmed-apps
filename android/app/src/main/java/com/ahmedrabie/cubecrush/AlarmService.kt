package com.ahmedrabie.cubecrush

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.core.app.NotificationCompat
import java.io.File

/** Plays the siren in the foreground, shows the alarm screen, and handles Dismiss / Snooze. */
class AlarmService : Service() {
    companion object {
        const val ACTION_RING = "ring"
        const val ACTION_STOP = "stop"
        const val ACTION_SNOOZE = "snooze"
        const val CHANNEL = "crush_alarm"
        const val NOTIF_ID = 42
        const val MISSED_ID = 43
    }

    private var player: MediaPlayer? = null
    private var vibrator: Vibrator? = null
    private var wake: PowerManager.WakeLock? = null
    private var restoreVol = -1
    private val handler = Handler(Looper.getMainLooper())
    private var title = ""
    private var body = ""

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> { finishAlarm(); return START_NOT_STICKY }
            ACTION_SNOOZE -> {
                val mins = AlarmStore.prefs(this).getInt("snooze", 10)
                AlarmStore.schedule(this, AlarmStore.SNOOZE_ID, System.currentTimeMillis() + mins * 60_000L,
                    "Snoozed · $title", body)
                finishAlarm(); return START_NOT_STICKY
            }
        }
        title = intent?.getStringExtra("title") ?: "Crush cubes now"
        body = intent?.getStringExtra("body") ?: ""
        createChannel()
        val n = buildNotification()
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        else startForeground(NOTIF_ID, n)

        wake = (getSystemService(POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "cubecrush:alarm").apply { acquire(10 * 60_000L) }
        try {
            startActivity(alarmScreenIntent())
        } catch (e: Exception) { /* full-screen notification shows it instead */ }
        startSound()
        val ring = AlarmStore.prefs(this).getInt("ring", 60)
        handler.removeCallbacksAndMessages(null)
        handler.postDelayed({ timeUp() }, ring * 1000L)
        return START_NOT_STICKY
    }

    private fun alarmScreenIntent() = Intent(this, AlarmActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_USER_ACTION)
        .putExtra("title", title).putExtra("body", body)

    private fun buildNotification(): Notification {
        val full = PendingIntent.getActivity(this, 1, alarmScreenIntent(),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 2, Intent(this, AlarmService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val snooze = PendingIntent.getService(this, 3, Intent(this, AlarmService::class.java).setAction(ACTION_SNOOZE),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat)
            .setColor(0xFFC62828.toInt())
            .setContentTitle(title)
            .setContentText(body.replace('\n', ' '))
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setFullScreenIntent(full, true)
            .setContentIntent(full)
            .setOngoing(true)
            .addAction(0, "Snooze", snooze)
            .addAction(0, "Dismiss", stop)
            .build()
    }

    private fun createChannel() {
        val nm = getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL) == null) {
            val ch = NotificationChannel(CHANNEL, "Cube crushing alarm", NotificationManager.IMPORTANCE_HIGH)
            ch.setSound(null, null) // the service plays the siren itself, on the alarm volume
            ch.enableVibration(false)
            ch.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            nm.createNotificationChannel(ch)
        }
    }

    private fun startSound() {
        stopSound()
        val prefs = AlarmStore.prefs(this)
        val vol = prefs.getFloat("vol", 0.9f)
        val am = getSystemService(AUDIO_SERVICE) as AudioManager
        val max = am.getStreamMaxVolume(AudioManager.STREAM_ALARM)
        val want = (max * vol).toInt().coerceIn(1, max)
        val cur = am.getStreamVolume(AudioManager.STREAM_ALARM)
        if (cur < want) { restoreVol = cur; am.setStreamVolume(AudioManager.STREAM_ALARM, want, 0) }

        val attrs = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
        val custom = File(filesDir, "alarm_sound")
        player = try { makePlayer(attrs, if (prefs.getBoolean("custom", false) && custom.exists()) custom else null) }
                 catch (e: Exception) { try { makePlayer(attrs, null) } catch (e2: Exception) { null } }
        player?.start()

        vibrator = if (Build.VERSION.SDK_INT >= 31)
            (getSystemService(VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
        else getSystemService(VIBRATOR_SERVICE) as Vibrator
        vibrator?.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 900, 500), 0))
    }

    private fun makePlayer(attrs: AudioAttributes, file: File?): MediaPlayer = MediaPlayer().apply {
        setAudioAttributes(attrs)
        if (file != null) setDataSource(file.path)
        else resources.openRawResourceFd(R.raw.siren).use { setDataSource(it.fileDescriptor, it.startOffset, it.length) }
        isLooping = true
        prepare()
    }

    private fun stopSound() {
        try { player?.stop() } catch (_: Exception) {}
        player?.release(); player = null
        vibrator?.cancel(); vibrator = null
        if (restoreVol >= 0) {
            (getSystemService(AUDIO_SERVICE) as AudioManager).setStreamVolume(AudioManager.STREAM_ALARM, restoreVol, 0)
            restoreVol = -1
        }
    }

    /** Ringing time is over: go quiet but leave a notification so the list is not lost. */
    private fun timeUp() {
        stopSound()
        val open = PendingIntent.getActivity(this, 4, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(title)
            .setContentText(body.replace('\n', ' '))
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(open).setAutoCancel(true).build()
        getSystemService(NotificationManager::class.java).notify(MISSED_ID, n)
        sendBroadcast(Intent(AlarmActivity.CLOSE).setPackage(packageName))
        finishAlarm()
    }

    private fun finishAlarm() {
        handler.removeCallbacksAndMessages(null)
        stopSound()
        sendBroadcast(Intent(AlarmActivity.CLOSE).setPackage(packageName))
        try { wake?.release() } catch (_: Exception) {}
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() { stopSound(); super.onDestroy() }
}
