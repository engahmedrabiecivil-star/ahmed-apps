package com.ahmedrabie.cubecrush

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Alarms are wiped on restart; set them again from the saved schedule. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        AlarmStore.scheduleAll(context)
    }
}
