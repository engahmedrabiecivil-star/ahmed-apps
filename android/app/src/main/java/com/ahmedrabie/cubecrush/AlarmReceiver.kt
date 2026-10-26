package com.ahmedrabie.cubecrush

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

class AlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val s = Intent(context, AlarmService::class.java)
            .setAction(AlarmService.ACTION_RING)
            .putExtra("title", intent.getStringExtra("title"))
            .putExtra("body", intent.getStringExtra("body"))
        ContextCompat.startForegroundService(context, s)
    }
}
